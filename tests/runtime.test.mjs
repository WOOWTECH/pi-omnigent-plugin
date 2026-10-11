import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initialize, verify, status, prepare, disconnect } from '../src/runtime.mjs';
import { normalizeServer, saveJSON, locked } from '../src/common.mjs';

function fixture(t, failed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-omnigent-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loc = { root, home: root, agentDir: root, stateDir: path.join(root, 'state'), omniDir: path.join(root, 'omni'), omniDataDir: path.join(root, 'omni') };
  const calls = [];
  const dependencies = { ok: true, omnigent: { available: true, python: '/fake/python', path: '/fake/omnigent' }, claude: { available: true }, codex: { available: true }, pi: { available: true } };
  const callAdapter = async input => {
    calls.push(input);
    if (input.action === 'status') return { ok: true, data: { server: 'https://omni.test', host: { connected: true, id: 'host-1' }, engines: { claude: { ready: true }, codex: { ready: true }, pi: { ready: true } } } };
    if (input.action === 'catalog') return { ok: true, data: { host: { id: 'host-1' } } };
    if (input.action === 'connect') return { ok: true, data: { host: { id: 'host-1' } } };
    return { ok: true, data: { engine: input.engine, ok: input.engine !== failed, reply: input.engine === failed ? undefined : 'OMNIGENT_CONNECTION_OK', sessionId: `test-${input.engine}` } };
  };
  return { loc, dependencies, callAdapter, calls, server: 'https://omni.test', username: 'admin', password: 'SECRET_TEST_PASSWORD' };
}
test('only real sentinel replies from all engines make setup ready; credentials never persisted', async t => {
  const ctx = fixture(t); const result = await initialize({ ...ctx, username: 'admin', password: 'SECRET_TEST_PASSWORD' });
  assert.equal(result.phase, 'ready'); assert.equal(result.ok, true);
  assert.deepEqual(ctx.calls.filter(c => c.action === 'verify').map(c => c.engine), ['claude', 'codex', 'pi']);
  for (const file of fs.readdirSync(ctx.loc.stateDir).filter(f => f.endsWith('.json'))) {
    assert.ok(!fs.readFileSync(path.join(ctx.loc.stateDir, file), 'utf8').includes('SECRET_TEST_PASSWORD'));
    assert.equal(fs.statSync(path.join(ctx.loc.stateDir, file)).mode & 0o777, 0o600);
  }
});
test('missing response never becomes ready', async t => {
  const ctx = fixture(t, 'codex'); const result = await initialize(ctx);
  assert.equal(result.ok, false); assert.equal(result.phase, 'needs-verification');
});
test('verification receipts from a different host cannot claim readiness', async t => {
  const ctx = fixture(t); await initialize(ctx);
  ctx.callAdapter = async () => ({ ok: true, data: { host: { connected: true, id: 'other-host' } } });
  assert.equal((await status(ctx)).phase, 'needs-verification');
});
test('failed login gives actionable state without running chat tests', async t => {
  const ctx = fixture(t); const base = ctx.callAdapter;
  ctx.callAdapter = input => input.action === 'connect' ? Promise.resolve({ ok: false, error: { code: 'NEEDS_LOGIN', message: 'Login required' } }) : base(input);
  assert.equal((await initialize(ctx)).phase, 'needs-login');
  assert.equal(ctx.calls.some(c => c.action === 'verify'), false);
});
test('stored successful replies cannot hide a newly unavailable engine', async t => {
  const ctx = fixture(t); await initialize(ctx);
  ctx.callAdapter = async () => ({ ok: true, data: { host: { connected: true, id: 'host-1' }, engines: { claude: { ready: true }, codex: { ready: false }, pi: { ready: true } } } });
  assert.equal((await status(ctx)).phase, 'needs-verification');
});
test('host adapter partial locations merge required Omnigent state paths', async t => {
  const ctx = fixture(t); let metadata;
  ctx.callAdapter = async input => { metadata = input; return { ok: true, data: {} }; };
  const partial = { home: ctx.loc.home, stateDir: ctx.loc.stateDir, agentDir: ctx.loc.agentDir, root: ctx.loc.root };
  await status({ ...ctx, loc: partial });
  assert.ok(path.isAbsolute(metadata.configHome)); assert.ok(path.isAbsolute(metadata.dataDir));
});
test('single-engine retest cannot bypass missing verification of other engines', async t => {
  const ctx = fixture(t); saveJSON(path.join(ctx.loc.stateDir, 'state.json'), { server: 'https://omni.test', enabled: true, loginConfirmed: true });
  const result = await verify({ ...ctx, engine: 'pi' });
  assert.equal(result.ok, false); assert.equal(result.phase, 'needs-verification');
});
test('remote HTTP and credential-bearing URLs rejected', () => {
  for (const url of ['http://omni.test', 'https://user:password@omni.test', 'https://omni.test?token=secret', 'javascript:alert(1)']) assert.throws(() => normalizeServer(url));
  assert.equal(normalizeServer('https://OMNI.test/'), 'https://omni.test');
  assert.equal(normalizeServer('http://127.0.0.1:6767/'), 'http://127.0.0.1:6767');
});
test('active initialization lock serializes different processes', async t => {
  const ctx = fixture(t); const lock = path.join(ctx.loc.stateDir, 'test.lock');
  await locked(lock, async () => assert.deepEqual(await locked(lock, async () => 'unexpected'), { busy: true }));
});
test('new installation cannot reuse ambient login and verification cannot bypass fresh login', async t => {
  const ctx = fixture(t); delete ctx.username; delete ctx.password;
  assert.equal((await initialize(ctx)).phase, 'needs-login');
  assert.equal(ctx.calls.some(c => ['connect', 'verify'].includes(c.action)), false);
  assert.equal((await verify(ctx)).phase, 'needs-login');
});
test('startup preparation installs only and never connects or runs chats', async t => {
  const ctx = fixture(t); assert.equal((await prepare(ctx)).phase, 'needs-login');
  assert.equal(ctx.calls.length, 0);
});
test('only the engines present in the environment are connected and verified', async t => {
  const ctx = fixture(t); ctx.dependencies.claude.available = false; ctx.dependencies.codex.available = false;
  const result = await initialize(ctx);
  assert.equal(result.ok, true); assert.deepEqual(result.installedEngines, ['pi']);
  assert.deepEqual(ctx.calls.filter(c => c.action === 'verify').map(c => c.engine), ['pi']);
  assert.equal((await status(ctx)).phase, 'ready');
});
test('an environment without engines cannot claim chat readiness', async t => {
  const ctx = fixture(t); for (const engine of ['claude', 'codex', 'pi']) ctx.dependencies[engine].available = false;
  assert.equal((await initialize(ctx)).phase, 'needs-engine');
  assert.equal(ctx.calls.some(c => c.action === 'verify'), false);
});

test('disconnect invalidates login and all chat receipts; reconnect requires fresh credentials', async t => {
  const ctx = fixture(t); await initialize(ctx);
  const base = ctx.callAdapter;
  ctx.callAdapter = input => input.action === 'disconnect'
    ? Promise.resolve({ ok: true, data: { host: { id: 'host-1', connected: false }, credentialsCleared: true } }) : base(input);
  const result = await disconnect(ctx);
  assert.equal(result.ok, true); assert.equal(result.phase, 'needs-login');
  const current = await status(ctx);
  assert.equal(current.loginConfirmed, false); assert.deepEqual(current.verification, {});
  assert.equal(fs.existsSync(path.join(ctx.loc.stateDir, 'connection.json')), false);
  assert.equal((await initialize({ ...ctx, username: undefined, password: undefined })).phase, 'needs-login');
});

test('failed disconnection cannot leave stale success receipts or a confirmed login', async t => {
  const ctx = fixture(t); await initialize(ctx);
  const base = ctx.callAdapter;
  ctx.callAdapter = input => input.action === 'disconnect'
    ? Promise.resolve({ ok: false, error: { code: 'HOST_DISCONNECT_TIMEOUT', message: 'Still online' } }) : base(input);
  const result = await disconnect(ctx);
  assert.equal(result.ok, false); assert.equal(result.error.code, 'HOST_DISCONNECT_TIMEOUT');
  assert.equal((await status(ctx)).loginConfirmed, false);
  assert.deepEqual((await status(ctx)).verification, {});
});
