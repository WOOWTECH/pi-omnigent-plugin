import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as runtime from '../src/runtime.mjs';
import { boot, readOnboarding } from '../src/web.mjs';
import { saveJSON, readJSON, locked } from '../src/common.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-resume-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const loc = { root: fileURLToPath(new URL('../', import.meta.url)), home, agentDir: path.join(home, 'agent'),
    stateDir: path.join(home, 'agent/omnigent-plugin'), omniDir: path.join(home, 'omni'), omniDataDir: path.join(home, 'omni') };
  const state = { online: false, hostId: 'original-host', server: 'https://omni.test', calls: [], active: true };
  const dependencies = { ok: true, omnigent: { available: true }, pi: { available: true }, claude: { available: true }, codex: { available: true } };
  const callAdapter = async input => {
    state.calls.push(input);
    if (['connect', 'resume'].includes(input.action)) state.online = true;
    if (input.action === 'disconnect') state.online = false;
    return { ok: true, data: { server: state.server, workspace: home,
      host: { id: state.hostId, connected: state.online }, engines: { pi: { configured: 'needs-auth', ready: false } } } };
  };
  const lifecycle = () => ({ active: state.active, registered: true, reason: state.active ? 'native-plugin-enabled' : 'native-plugin-disabled' });
  const ctx = { loc, dependencies, callAdapter, lifecycle };
  // Inject only the external adapter/dependency inventory. All runtime methods
  // and lifecycle/state/operation locks are the real implementations.
  const boundRuntime = Object.fromEntries(['status', 'prepare', 'resumeAuthorizedHost', 'observeLifecycle'].map(name => [name,
    name === 'observeLifecycle' ? (life, o) => runtime[name](life, { ...ctx, ...o }) : o => runtime[name]({ ...ctx, ...o })]));
  const options = { ...loc, env: { HOME: home, PATH: '' }, lifecycle, runtime: boundRuntime,
    fetch: async () => ({ ok: true, json: async () => ({ data: { commands: [{ name: 'omnigent' }] } }) }) };
  const login = async () => {
    await runtime.observeLifecycle(lifecycle(), ctx);
    await runtime.initialize({ ...ctx, server: state.server, username: 'synthetic', password: 'synthetic-only' });
    state.online = false; state.calls.length = 0;
  };
  return { ctx, state, options, login };
}

test('two boots and a later restart restore the host without creating a setup conversation or model calls', async t => {
  const f = fixture(t); await f.login();
  await boot(f.options);
  assert.equal(f.state.online, true, 'the real boot must restore the prior connection');
  assert.deepEqual(readOnboarding(f.options), {});
  assert.equal(fs.existsSync(path.join(f.ctx.loc.stateDir, 'onboarding.json')), false);
  await boot(f.options); f.state.online = false; await boot(f.options);
  assert.equal(f.state.online, true); assert.equal(f.state.hostId, 'original-host');
  assert.equal(fs.existsSync(path.join(f.ctx.loc.stateDir, 'onboarding.json')), false);
  assert.equal(f.state.calls.some(c => ['connect', 'verify'].includes(c.action)), false);
  assert.equal((await runtime.status(f.ctx)).phase, 'needs-verification');
});

test('ambient SDK login cannot resume a fresh install or trigger a setup conversation', async t => {
  const f = fixture(t); f.state.online = true;
  // External status advertises an existing SDK host; no plugin consent exists.
  await boot(f.options);
  await boot(f.options);
  assert.equal(fs.existsSync(path.join(f.ctx.loc.stateDir, 'onboarding.json')), false);
  assert.equal(f.state.calls.some(c => ['connect', 'resume', 'verify'].includes(c.action)), false);
  const state = await runtime.status(f.ctx); assert.equal(state.loginConfirmed, false);
  assert.equal(state.phase, 'needs-login');
});

for (const revoke of ['native-disable-enable', 'cli-disable-enable', 'disconnect']) {
  test(`${revoke} revokes consent before the next boot`, async t => {
    const f = fixture(t); await f.login();
    if (revoke === 'disconnect') await runtime.disconnect(f.ctx);
    else if (revoke === 'cli-disable-enable') { await runtime.setEnabled(false, f.ctx); await runtime.setEnabled(true, f.ctx); }
    else { f.state.active = false; await boot(f.options); f.state.active = true; }
    f.state.calls.length = 0;
    await boot(f.options);
    assert.equal(f.state.calls.some(c => ['connect', 'resume', 'verify'].includes(c.action)), false);
    assert.equal((await runtime.status(f.ctx)).loginConfirmed, false);
  });
}

for (const variant of ['no-connection', 'wrong-server', 'wrong-workspace', 'wrong-installation', 'wrong-package',
  'unknown-installation-format', 'missing-installation-id', 'public-receipt', 'symlink']) {
  test(`resume fails closed with ${variant}`, async t => {
    const f = fixture(t); await f.login(); const file = path.join(f.ctx.loc.stateDir, 'connection.json');
    const proof = readJSON(file);
    if (variant === 'no-connection') fs.unlinkSync(file);
    else if (variant === 'public-receipt') fs.chmodSync(file, 0o644);
    else if (variant === 'symlink') { fs.renameSync(file, file+'.other'); fs.symlinkSync(file+'.other', file); }
    else if (variant === 'missing-installation-id') {
      const stateFile = path.join(f.ctx.loc.stateDir, 'state.json');
      const { installationId, ...state } = readJSON(stateFile); assert.match(installationId, /^[0-9a-f]{32}$/);
      saveJSON(stateFile, state);
    }
    else { if (variant === 'wrong-server') proof.server='https://other.test';
      if (variant === 'wrong-workspace') proof.workspace='/another-installation';
      if (variant === 'wrong-installation') proof.installation.id='f'.repeat(32);
      if (variant === 'wrong-package') proof.installation.package='@someone/pi-omnigent-plugin';
      if (variant === 'unknown-installation-format') proof.installation.schema=3;
      saveJSON(file, proof); }
    const result = await runtime.resumeAuthorizedHost(f.ctx);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'CONNECTION_IDENTITY_MISMATCH');
    assert.equal(f.state.calls.length, 0);
  });
}

// 0.3.16–0.3.29 named the installation by its home and Omnigent paths.
function pathIdentity(f, paths = {}) {
  const stateFile = path.join(f.ctx.loc.stateDir, 'state.json'), file = path.join(f.ctx.loc.stateDir, 'connection.json');
  const { installationId: _id, ...state } = readJSON(stateFile); saveJSON(stateFile, state);
  const { loc } = f.ctx;
  saveJSON(file, { ...readJSON(file), installation: { home: path.resolve(loc.home), configHome: path.resolve(loc.omniDir),
    dataDir: path.resolve(loc.omniDataDir), ...paths } });
  return file;
}

test('a 0.3.29 receipt named by paths migrates to the stable installation identity', async t => {
  const f = fixture(t); await f.login(); const file = pathIdentity(f);
  const result = await runtime.resumeAuthorizedHost(f.ctx);
  assert.equal(result.resumed, true);
  const state = readJSON(path.join(f.ctx.loc.stateDir, 'state.json')), proof = readJSON(file);
  assert.match(state.installationId, /^[0-9a-f]{32}$/);
  assert.equal(proof.installation.schema, 2);
  assert.equal(proof.installation.id, state.installationId);
  assert.equal(proof.installation.package, '@woowtech/pi-omnigent-plugin');
  assert.equal(state.loginConfirmed, true);
  // A second boot resumes from the migrated receipt without migrating again.
  f.state.online = false;
  assert.equal((await runtime.resumeAuthorizedHost(f.ctx)).resumed, true);
  assert.equal(readJSON(path.join(f.ctx.loc.stateDir, 'state.json')).installationId, state.installationId);
});

test('a 0.3.29 receipt still migrates when its recorded paths differ, because paths are no longer the identity', async t => {
  const f = fixture(t); await f.login(); pathIdentity(f, { home: '/old-image/home', dataDir: '/old-image/omnigent' });
  assert.equal((await runtime.resumeAuthorizedHost(f.ctx)).resumed, true);
  assert.deepEqual(f.state.calls.map(c => c.action), ['resume']);
});

for (const variant of ['wrong-server', 'wrong-workspace', 'no-host']) {
  test(`a 0.3.29 receipt with ${variant} does not migrate`, async t => {
    const f = fixture(t); await f.login(); const file = pathIdentity(f); const proof = readJSON(file);
    if (variant === 'wrong-server') proof.server = 'https://other.test';
    if (variant === 'wrong-workspace') proof.workspace = '/another-installation';
    if (variant === 'no-host') delete proof.host;
    saveJSON(file, proof);
    const result = await runtime.resumeAuthorizedHost(f.ctx);
    assert.equal(result.error.code, 'CONNECTION_IDENTITY_MISMATCH');
    assert.equal(f.state.calls.length, 0);
    assert.equal(readJSON(path.join(f.ctx.loc.stateDir, 'state.json')).installationId, undefined);
  });
}

test('the installation identity survives sign-out and a fresh sign-in', async t => {
  const f = fixture(t); await f.login();
  const first = readJSON(path.join(f.ctx.loc.stateDir, 'state.json')).installationId;
  assert.match(first, /^[0-9a-f]{32}$/);
  await runtime.disconnect(f.ctx); await f.login();
  assert.equal(readJSON(path.join(f.ctx.loc.stateDir, 'state.json')).installationId, first);
  assert.equal(readJSON(path.join(f.ctx.loc.stateDir, 'connection.json')).installation.id, first);
});

test('new receipts keep the path fields that 0.3.16–0.3.29 compare, so a rollback still resumes', async t => {
  const f = fixture(t); await f.login();
  const { installation } = readJSON(path.join(f.ctx.loc.stateDir, 'connection.json'));
  const { loc } = f.ctx;
  // The exact check those versions make in resumeAuthorizedHost.
  const bound = { home: path.resolve(loc.home), configHome: path.resolve(loc.omniDir), dataDir: path.resolve(loc.omniDataDir) };
  assert.equal(Object.keys(bound).some(key => installation[key] !== bound[key]), false);
});

test('legacy successful connection restores only when original workspace/server/host proof remains', async t => {
  const f = fixture(t); await f.login(); const file = path.join(f.ctx.loc.stateDir, 'connection.json');
  const proof = readJSON(file); delete proof.installation; saveJSON(file, proof);
  assert.equal((await runtime.resumeAuthorizedHost(f.ctx)).resumed, true);
  assert.equal(readJSON(file).installation.home, f.ctx.loc.home);
});

test('expired exact-server login asks again and is not retried by later boots', async t => {
  const f = fixture(t); await f.login(); let attempts = 0;
  const expired = { ...f.ctx, callAdapter: async input => {
    if (input.action === 'resume') { attempts++; return { ok: false, error: { code: 'NEEDS_LOGIN' } }; }
    return f.ctx.callAdapter(input);
  } };
  assert.equal((await runtime.resumeAuthorizedHost(expired)).ok, false);
  assert.equal((await runtime.resumeAuthorizedHost(expired)).reason, 'fresh-login-required');
  assert.equal(attempts, 1); assert.equal((await runtime.status(f.ctx)).loginConfirmed, false);
});

test('existing operation lock serializes resume against disconnect and parallel boots', async t => {
  const f = fixture(t); await f.login();
  await locked(path.join(f.ctx.loc.stateDir, 'initialize.lock'), async () => {
    const result = await runtime.resumeAuthorizedHost(f.ctx);
    assert.equal(result.error.code, 'OPERATION_BUSY'); assert.equal(f.state.calls.length, 0);
  });
  // External host creation is represented by an offline -> online transition.
  let starts = 0;
  const original = f.ctx.callAdapter;
  f.options.runtime.resumeAuthorizedHost = o => runtime.resumeAuthorizedHost({ ...f.ctx, ...o, callAdapter: async input => {
    if (input.action === 'resume' && !f.state.online) { starts++; await new Promise(r=>setTimeout(r,50)); }
    return original(input);
  } });
  await Promise.all([boot(f.options), boot(f.options)]);
  assert.equal(starts, 1); assert.equal(f.state.online, true);
});

test('unregistered activation window cannot reuse an old installation consent', async t => {
  const f = fixture(t); await f.login();
  assert.equal((await runtime.resumeAuthorizedHost({ ...f.ctx, lifecycle: { active: true, registered: false } })).reason, 'inactive');
  assert.equal(f.state.calls.length, 0);
});

test('stale online heartbeat and valid verification cannot bypass local host recovery', async t => {
  const f = fixture(t); await f.login(); let localAlive = false, starts = 0;
  const stateFile = path.join(f.ctx.loc.stateDir, 'state.json');
  saveJSON(stateFile, { ...readJSON(stateFile), phase: 'ready' });
  saveJSON(path.join(f.ctx.loc.stateDir, 'verification.json'), Object.fromEntries(['pi','claude','codex'].map(engine =>
    [engine, { ok: true, cleanup: 'stopped', hostId: f.state.hostId, server: f.state.server }])));
  const inventory = Object.fromEntries(['pi','claude','codex'].map(engine => [engine, { ready: true }]));
  const adapter = async input => {
    if (input.action === 'resume') { if (!localAlive) starts++; localAlive = true; }
    return { ok: true, data: { server: f.state.server, workspace: f.ctx.loc.home,
      host: { id: f.state.hostId, connected: true, managed: localAlive }, engines: inventory } };
  };
  for (const name of ['status', 'resumeAuthorizedHost']) f.options.runtime[name] = o => runtime[name]({ ...f.ctx, ...o, callAdapter: adapter });
  assert.equal((await f.options.runtime.status({})).phase, 'ready');
  await boot(f.options); await boot(f.options);
  assert.equal(localAlive, true, 'remote heartbeat is not proof of a local host process');
  assert.equal(starts, 1);
});

test('mismatched saved identity cannot leave a stale ready status', async t => {
  const f=fixture(t); await f.login();
  saveJSON(path.join(f.ctx.loc.stateDir, 'state.json'), { ...readJSON(path.join(f.ctx.loc.stateDir, 'state.json')), phase: 'ready' });
  const proofFile=path.join(f.ctx.loc.stateDir,'connection.json');
  saveJSON(proofFile,{...readJSON(proofFile),server:'https://different.test'});
  const result=await runtime.resumeAuthorizedHost(f.ctx);
  assert.equal(result.ok,false);
  assert.equal((await runtime.status(f.ctx)).phase,'error');
});
