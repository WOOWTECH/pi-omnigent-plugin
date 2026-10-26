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
    return { ok: true, data: { engine: input.engine, ok: input.engine !== failed, reply: input.engine === failed ? undefined : 'OMNIGENT_CONNECTION_OK', sessionId: `test-${input.engine}`, cleanup: 'stopped' } };
  };
  return { loc, dependencies, callAdapter, calls, verify: true, server: 'https://omni.test', username: 'admin', password: 'SECRET_TEST_PASSWORD' };
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
test('terminal removal evidence persists separately from cleanup with no raw output', async t => {
  const ctx = fixture(t); const base = ctx.callAdapter;
  for (const exitCode of [null, 0, 1, -9, true, 'private-output', 1.5, 2 ** 40]) {
    for (const cleanup of ['stopped', 'stop_failed']) {
      ctx.callAdapter = async input => {
        const result = await base(input);
        if (input.action === 'verify') Object.assign(result.data, {
          ok: false, reply: null, reason: 'NATIVE_TERMINAL_REMOVED', cleanup,
          terminalDiagnostic: { resourceId: `terminal_${input.engine}_main`, event: 'session.resource.deleted',
            phase: 'before_cleanup', exitCode, message: 'private-output', credentials: 'private-output' }
        });
        return result;
      };
      const result = await initialize(ctx);
      assert.equal(result.ok, false);
      const receipts = JSON.parse(fs.readFileSync(path.join(ctx.loc.stateDir, 'verification.json')));
      const expectedCode = Number.isInteger(exitCode) && exitCode >= -(2 ** 31) && exitCode < 2 ** 31 ? exitCode : null;
      for (const engine of ['pi', 'claude']) {
        assert.deepEqual(receipts[engine].terminalDiagnostic, {
          resourceId: `terminal_${engine}_main`, event: 'session.resource.deleted', phase: 'before_cleanup', exitCode: expectedCode
        });
        assert.equal(receipts[engine].cleanup, cleanup);
        assert.equal(receipts[engine].reason, cleanup === 'stopped' ? 'NATIVE_TERMINAL_REMOVED' : 'SESSION_STOP_FAILED');
      }
      assert.equal(receipts.codex.terminalDiagnostic, undefined);
      assert.equal(JSON.stringify(receipts).includes('private-output'), false);
    }
  }
});
test('receipt boundary drops mismatched, cleanup-phase or successful terminal diagnostics', async t => {
  const ctx = fixture(t); const base = ctx.callAdapter;
  for (const extra of [{ resourceId: 'terminal_other_main' }, { event: 'session.resource.created' },
    { phase: 'cleanup' }, { success: true }]) {
    ctx.callAdapter = async input => {
      const result = await base(input);
      if (input.action === 'verify') Object.assign(result.data, {
        ok: extra.success === true, reason: 'NATIVE_TERMINAL_REMOVED',
        terminalDiagnostic: { resourceId: `terminal_${input.engine}_main`, event: 'session.resource.deleted',
          phase: 'before_cleanup', exitCode: 1, ...extra }
      });
      return result;
    };
    await initialize(ctx);
    const receipts = JSON.parse(fs.readFileSync(path.join(ctx.loc.stateDir, 'verification.json')));
    assert.equal(receipts.pi.terminalDiagnostic, undefined);
    assert.equal(receipts.claude.terminalDiagnostic, undefined);
  }
});
test('verification persists the requested alias and sanitized resolved model separately', async t => {
  const ctx = fixture(t); const base = ctx.callAdapter;
  ctx.callAdapter = async input => {
    const result = await base(input);
    if (input.action === 'verify') Object.assign(result.data, { model: 'sonnet', resolvedModel: 'provider/actual-model' });
    return result;
  };
  await initialize(ctx);
  const proof = JSON.parse(fs.readFileSync(path.join(ctx.loc.stateDir, 'verification.json'))).claude;
  assert.equal(proof.model, 'sonnet');
  assert.equal(proof.resolvedModel, 'provider/actual-model');
  ctx.callAdapter = async input => {
    const result = await base(input);
    if (input.action === 'verify') result.data.resolvedModel = 'https://private.example/?token=secret';
    return result;
  };
  await verify(ctx);
  const saved = fs.readFileSync(path.join(ctx.loc.stateDir, 'verification.json'), 'utf8');
  assert.equal(JSON.parse(saved).claude.resolvedModel, undefined);
  assert.ok(!saved.includes('token=secret'));
});
test('a pre-session engine failure retains its cause rather than inventing a cleanup failure', async t => {
  const ctx = fixture(t); const base = ctx.callAdapter;
  ctx.callAdapter = input => input.action === 'verify'
    ? Promise.resolve({ ok: false, error: { code: 'ENGINE_NOT_READY' } }) : base(input);
  const result = await initialize(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.verification.claude.reason, 'ENGINE_NOT_READY');
  assert.equal(result.verification.claude.sessionId, undefined);
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

test('a rejected fresh login cannot inherit a previous successful approval', async t => {
  const ctx = fixture(t); await initialize(ctx);
  const base = ctx.callAdapter;
  ctx.callAdapter = input => input.action === 'connect' ? { ok: false, error: { code: 'NEEDS_LOGIN', message: 'Rejected' } } : base(input);
  const result = await initialize(ctx);
  assert.equal(result.ok, false);
  assert.equal((await status(ctx)).phase, 'needs-login');
  assert.equal((await status(ctx)).loginConfirmed, false);
});

test('adapter termination leaves a safe error state rather than stuck connecting', async t => {
  const ctx = fixture(t); const base = ctx.callAdapter;
  ctx.callAdapter = input => input.action === 'connect' ? Promise.reject(Object.assign(new Error('secret transport body'), { code: 'ETIMEDOUT' })) : base(input);
  const result = await initialize(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ETIMEDOUT');
  assert.equal((await status(ctx)).phase, 'error');
  assert.equal(JSON.stringify(result).includes('secret transport body'), false);
});

test('single-engine verification cannot reuse receipts from an older engine binary', async t => {
  const ctx = fixture(t); ctx.dependencies.claude.version = '2.1.0'; await initialize(ctx);
  ctx.dependencies.claude.version = '2.2.0';
  assert.equal((await verify({ ...ctx, engine: 'pi' })).ok, false);
});

test('a successful reply whose test session could not be stopped remains incomplete', async t => {
  const ctx = fixture(t); const base = ctx.callAdapter;
  ctx.callAdapter = async input => {
    const result = await base(input);
    if (input.action === 'verify') result.data.cleanup = 'stop_failed';
    return result;
  };
  assert.equal((await initialize(ctx)).ok, false);
  assert.notEqual((await status(ctx)).phase, 'ready');
});

test('a successful reply without confirmed session cleanup remains incomplete', async t => {
  const ctx = fixture(t); const base = ctx.callAdapter;
  ctx.callAdapter = async input => {
    const result = await base(input);
    if (input.action === 'verify') delete result.data.cleanup;
    return result;
  };
  const initialized = await initialize(ctx);
  assert.equal(initialized.ok, false);
  assert.equal(initialized.phase, 'needs-verification');
  assert.equal((await status(ctx)).phase, 'needs-verification');
});

test('disabled plugin never creates verification sessions', async t => {
  const ctx = fixture(t); await initialize(ctx); ctx.calls.length = 0;
  saveJSON(path.join(ctx.loc.stateDir, 'state.json'), { enabled: false, loginConfirmed: true, server: ctx.server });
  assert.equal((await verify(ctx)).phase, 'disabled');
  assert.equal(ctx.calls.length, 0);
});

test('concurrent initialization returns an actionable failed busy envelope', async t => {
  const ctx = fixture(t);
  await locked(path.join(ctx.loc.stateDir, 'initialize.lock'), async () => {
    const result = await initialize(ctx);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'OPERATION_BUSY');
  });
});

test('native disable and re-enable requires fresh approval without clearing host credentials', async t => {
  const { observeLifecycle } = await import('../src/runtime.mjs');
  const ctx = fixture(t); await initialize(ctx); ctx.calls.length = 0;
  await observeLifecycle({ active: false, registered: true, reason: 'native-plugin-disabled' }, ctx);
  await observeLifecycle({ active: true, registered: true, reason: 'native-plugin-enabled' }, ctx);
  assert.equal((await status(ctx)).loginConfirmed, false);
  assert.equal((await initialize({ ...ctx, username: undefined, password: undefined })).phase, 'needs-login');
  assert.equal(ctx.calls.some(c => c.action === 'connect' || c.action === 'disconnect'), false);
});

test('ordinary setup and repair never create chat verification sessions', async t => {
  const ctx = fixture(t); delete ctx.verify;
  const result = await initialize(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'needs-verification');
  assert.equal(ctx.calls.some(c => c.action === 'verify'), false);
  const { repair } = await import('../src/runtime.mjs');
  await repair(ctx);
  assert.equal(ctx.calls.some(c => c.action === 'verify'), false);
});
