import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doctor, formatDoctor } from '../src/doctor.mjs';
import { connectWithPassword, readPasswordStdin } from '../src/connect.mjs';
import { installHost, loadPiSdk } from '../src/web.mjs';
import { saveJSON } from '../src/common.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/cli.mjs');
const SERVER = 'https://omni.test';
const LOGIN_FILES = ['state.json', 'verification.json', 'connection.json'];

function executable(file, body = '#!/bin/sh\nexit 0\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

// Only the external adapter and the dependency inventory are injected; status,
// initialize, the lifecycle reader and the launcher chain are the real modules.
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-omnigent-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agentDir = path.join(home, 'agent');
  const loc = { root, home, agentDir, stateDir: path.join(agentDir, 'omnigent-plugin'), omniDir: path.join(home, 'omni'), omniDataDir: path.join(home, 'omni') };
  const calls = [];
  const adapter = { host: { id: 'host-1', name: 'pi-test', connected: true, state: 'running', manager: 'plugin', managerRunning: false, managed: true },
    connect: { ok: true } };
  const callAdapter = async input => {
    calls.push(input);
    if (input.action === 'status') return { ok: true, data: { server: SERVER, host: adapter.host, engines: { pi: { ready: true } } } };
    if (input.action === 'connect') return adapter.connect.ok
      ? { ok: true, data: { server: SERVER, host: { id: adapter.host.id, name: adapter.host.name, connected: true }, engines: {} } }
      : { ok: false, error: adapter.connect.error };
    return { ok: false, error: { code: 'UNEXPECTED_ACTION' } };
  };
  const dependencies = { ok: true, omnigent: { available: true, python: '/fake/python', path: '/fake/omnigent' },
    pi: { available: true, version: '1.1.0' }, claude: { available: false }, codex: { available: false } };
  const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PATH: '' };
  const lifecycle = { active: true, registered: true, reason: 'native-plugin-enabled', source: root, scope: 'global' };
  return { home, agentDir, loc, calls, adapter, env, options: { loc, env, callAdapter, dependencies, lifecycle } };
}

function signedIn(f, changes = {}) {
  saveJSON(path.join(f.loc.stateDir, 'state.json'), { phase: 'ready', enabled: true, loginConfirmed: true, server: SERVER, ...changes });
  saveJSON(path.join(f.loc.stateDir, 'verification.json'), { pi: { engine: 'pi', ok: true, cleanup: 'stopped', server: SERVER,
    hostId: 'host-1', cliVersion: '1.1.0', reply: 'OMNIGENT_CONNECTION_OK', checkedAt: '2026-10-29T00:00:00.000Z' } });
  saveJSON(path.join(f.loc.stateDir, 'connection.json'), { server: SERVER, workspace: f.home, host: { id: 'host-1' } });
}

function stateFiles(f) {
  const files = {};
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(f.loc.stateDir, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  if (fs.existsSync(f.loc.stateDir)) walk(f.loc.stateDir);
  return files;
}

const loginState = f => Object.fromEntries(LOGIN_FILES.map(name => [name, fs.readFileSync(path.join(f.loc.stateDir, name), 'utf8')]));

/** An installed launcher whose recorded Pi Web was deleted, plus a healthy pi-web on PATH. */
async function staleLaunchChain(f) {
  const old = executable(path.join(f.home, 'old-ui-copy/bin/pi-web.js'));
  await installHost({ loc: f.loc, env: f.env, realWeb: old });
  fs.rmSync(path.join(f.home, 'old-ui-copy'), { recursive: true });
  const healthy = executable(path.join(f.home, 'image/bin/pi-web'));
  return { old, healthy, env: { ...f.env, PATH: path.dirname(healthy) } };
}

test('doctor reports a healthy installation as ok and writes nothing', async t => {
  const f = fixture(t); signedIn(f);
  const healthy = executable(path.join(f.home, 'image/bin/pi-web'));
  await installHost({ loc: f.loc, env: f.env, realWeb: healthy });
  const before = stateFiles(f);
  const report = await doctor(f.options);
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'read-only');
  assert.deepEqual(report.issues, []);
  for (const name of ['registration', 'realWeb', 'host', 'login', 'issue']) assert.equal(report.checks[name].status, 'ok', name);
  assert.equal(report.checks.registration.reason, 'native-plugin-enabled');
  assert.equal(report.checks.realWeb.realWeb, healthy);
  assert.equal(report.checks.host.id, 'host-1');
  assert.equal(report.checks.host.managedProcess, true);
  assert.equal(report.checks.login.phase, 'ready');
  assert.deepEqual(report.checks.login.verification, { pi: { ok: true, checkedAt: '2026-10-29T00:00:00.000Z' } });
  assert.equal(report.fix, undefined);
  assert.deepEqual(stateFiles(f), before);
  assert.deepEqual(f.calls.map(call => call.action), ['status']);
});

test('doctor flags a deleted realWeb as fixable and changes nothing without --fix', async t => {
  const f = fixture(t); signedIn(f);
  const { old, healthy, env } = await staleLaunchChain(f);
  const before = stateFiles(f);
  const report = await doctor({ ...f.options, env });
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, ['REAL_WEB_STALE']);
  const check = report.checks.realWeb;
  assert.equal(check.status, 'fail');
  assert.equal(check.code, 'REAL_WEB_STALE');
  assert.equal(check.fixable, true);
  assert.equal(check.recorded, old);
  assert.equal(check.realWeb, healthy);
  assert.equal(check.source, 'path');
  assert.deepEqual(check.rejected, [{ source: 'recorded', path: old, problem: 'missing' }]);
  assert.equal(check.lastLaunch.by, 'install-host');
  assert.deepEqual(stateFiles(f), before);
});

test('doctor --fix repoints only realWeb and leaves the login state byte for byte', async t => {
  const f = fixture(t); signedIn(f);
  const { old, healthy, env } = await staleLaunchChain(f);
  const hostFile = path.join(f.loc.stateDir, 'host.json');
  const hostBefore = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
  const shim = path.join(f.home, '.local/bin/pi-web'), named = path.join(f.home, '.local/bin/pi-omnigent-web');
  const launchersBefore = [shim, named].map(file => fs.readFileSync(file, 'utf8'));
  const login = loginState(f);
  const report = await doctor({ ...f.options, env, fix: true });
  assert.equal(report.mode, 'fix');
  assert.deepEqual(report.fix, { status: 'repointed', from: old, to: healthy, source: 'path', launchers: [shim, named],
    rejected: [{ source: 'recorded', path: old, problem: 'missing' }] });
  assert.equal(report.ok, true);
  assert.equal(report.checks.realWeb.status, 'ok');
  assert.deepEqual(JSON.parse(fs.readFileSync(hostFile, 'utf8')), { ...hostBefore, realWeb: healthy });
  [shim, named].forEach((file, index) => assert.equal(fs.readFileSync(file, 'utf8'),
    launchersBefore[index].replace(`const native=${JSON.stringify(old)};`, `const native=${JSON.stringify(healthy)};`)));
  const receipt = JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'launch.json'), 'utf8'));
  assert.equal(receipt.by, 'doctor-fix');
  assert.equal(receipt.recorded, old);
  assert.equal(receipt.realWeb, healthy);
  assert.deepEqual(loginState(f), login);
  assert.equal(f.calls.some(call => ['connect', 'resume', 'disconnect', 'verify'].includes(call.action)), false);
});

test('doctor --fix changes nothing when no Pi Web can run', async t => {
  const f = fixture(t); signedIn(f);
  await staleLaunchChain(f);
  const before = stateFiles(f);
  const report = await doctor({ ...f.options, fix: true });
  assert.deepEqual(report.fix, { status: 'skipped', code: 'PI_WEB_UNAVAILABLE' });
  assert.equal(report.checks.realWeb.code, 'PI_WEB_UNAVAILABLE');
  assert.equal(report.checks.realWeb.fixable, false);
  assert.deepEqual(stateFiles(f), before);
});

test('doctor reads registration through the native package lifecycle of web.mjs', async t => {
  const f = fixture(t);
  const { lifecycle, ...options } = f.options;
  const sdk = await loadPiSdk();
  const settings = sdk.SettingsManager.create(f.home, f.agentDir, { projectTrusted: false });
  settings.setPackages([root]); await settings.flush();
  let report = await doctor({ ...options, sdk });
  assert.equal(report.checks.registration.status, 'ok');
  assert.equal(report.checks.registration.reason, 'native-plugin-enabled');
  settings.setPackages([{ source: root, extensions: [] }]); await settings.flush();
  report = await doctor({ ...options, sdk });
  assert.equal(report.checks.registration.status, 'fail');
  assert.equal(report.checks.registration.code, 'PACKAGE_DISABLED');
  settings.setPackages([]); await settings.flush();
  report = await doctor({ ...options, sdk });
  assert.equal(report.checks.registration.code, 'PACKAGE_NOT_REGISTERED');
  assert.ok(report.issues.includes('PACKAGE_NOT_REGISTERED'));
});

test('doctor surfaces the current issue code and the kit host state', async t => {
  const f = fixture(t);
  signedIn(f, { phase: 'error', issue: { code: 'NEEDS_RESET_ID', message: 'reset the host id' } });
  f.adapter.host = { ...f.adapter.host, connected: false, state: 'needs-reset-id', manager: 'kit', managerRunning: true, managed: true };
  const report = await doctor(f.options);
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.issue, { status: 'fail', code: 'NEEDS_RESET_ID', state: 'NEEDS_RESET_ID' });
  assert.equal(report.checks.host.code, 'NEEDS_RESET_ID');
  assert.equal(report.checks.host.state, 'needs-reset-id');
  assert.ok(report.issues.includes('NEEDS_RESET_ID'));
  assert.equal(JSON.stringify(report).includes('reset the host id'), false, 'issue messages are not echoed');
});

test('an online host without the plugin\'s Settings consent is reported as login required', async t => {
  const f = fixture(t);
  const report = await doctor(f.options);
  assert.equal(report.checks.host.status, 'ok');
  assert.equal(report.checks.host.connected, true);
  assert.equal(report.checks.login.status, 'fail');
  assert.equal(report.checks.login.code, 'LOGIN_REQUIRED');
  assert.equal(report.checks.realWeb.code, 'LAUNCHER_NOT_INSTALLED');
});

test('a logged-in host that is offline fails; missing chat receipts only warn', async t => {
  const f = fixture(t);
  signedIn(f, { phase: 'needs-verification', issue: { code: 'INCOMPLETE_CHAT_VERIFICATION' } });
  fs.writeFileSync(path.join(f.loc.stateDir, 'verification.json'), '{}\n');
  let report = await doctor(f.options);
  assert.equal(report.checks.login.status, 'warn');
  assert.equal(report.checks.login.code, 'VERIFICATION_INCOMPLETE');
  assert.equal(report.checks.issue.status, 'warn');
  assert.equal(report.checks.realWeb.status, 'warn');
  assert.equal(report.ok, true);
  f.adapter.host = { ...f.adapter.host, connected: false };
  report = await doctor(f.options);
  assert.equal(report.checks.host.code, 'HOST_OFFLINE');
  assert.equal(report.ok, false);
});

test('doctor text output lists every check and the result', async t => {
  const f = fixture(t); signedIn(f);
  const { env } = await staleLaunchChain(f);
  const text = formatDoctor(await doctor({ ...f.options, env }));
  for (const name of ['registration', 'realWeb', 'host', 'login', 'issue']) assert.match(text, new RegExp(`\\b${name}\\b`));
  assert.match(text, /fail\s+realWeb\s+REAL_WEB_STALE/);
  assert.match(text, /pi-omnigent doctor --fix/);
  assert.match(text, /^result: REAL_WEB_STALE$/m);
});

test('doctor CLI is read-only by default, prints JSON on request, and --fix touches only realWeb', async t => {
  const f = fixture(t); signedIn(f);
  const { old, healthy } = await staleLaunchChain(f);
  // The temporary HOME has no Omnigent server configured, so status never contacts one.
  const env = { HOME: f.home, PI_CODING_AGENT_DIR: f.agentDir, PATH: [path.dirname(healthy), '/usr/bin', '/bin'].join(path.delimiter) };
  const run = (...args) => spawnSync(process.execPath, [cli, 'doctor', ...args], { encoding: 'utf8', env, timeout: 60000 });
  const before = stateFiles(f), login = loginState(f);
  let result = run('--json');
  assert.equal(result.status, 1, result.stderr);
  let report = JSON.parse(result.stdout);
  assert.equal(report.checks.realWeb.code, 'REAL_WEB_STALE');
  assert.equal(report.checks.registration.code, 'PACKAGE_NOT_REGISTERED');
  assert.deepEqual(stateFiles(f), before);
  result = run();
  assert.match(result.stdout, /^pi-omnigent doctor \(read-only\)$/m);
  assert.deepEqual(stateFiles(f), before);
  result = run('--fix', '--json');
  report = JSON.parse(result.stdout);
  assert.equal(report.fix.status, 'repointed');
  assert.equal(report.fix.from, old);
  assert.equal(report.fix.to, healthy);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'host.json'), 'utf8')).realWeb, healthy);
  assert.deepEqual(loginState(f), login);
  for (const args of [['--bogus'], ['--json', '--json'], ['--fix', 'all']]) {
    result = run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /INVALID_ARGUMENTS/);
  }
});

test('connect follows the Settings page flow: same initialize call with verify off, password never stored or echoed', async t => {
  const f = fixture(t);
  const password = 'stdin-only-secret-sentinel';
  const result = await connectWithPassword({ ...f.options, server: ` ${SERVER}/ `, username: ' admin ', password });
  assert.deepEqual(result, { ok: true, phase: 'needs-verification', server: SERVER, host: { id: 'host-1', name: 'pi-test', connected: true } });
  const connect = f.calls.find(call => call.action === 'connect');
  assert.equal(connect.server, SERVER);
  assert.equal(connect.username, 'admin');
  assert.equal(connect.password, password);
  assert.equal(connect.allowManagedHost, true);
  assert.equal(f.calls.some(call => call.action === 'verify'), false);
  const state = JSON.parse(fs.readFileSync(path.join(f.loc.stateDir, 'state.json'), 'utf8'));
  assert.equal(state.loginConfirmed, true);
  assert.equal(state.phase, 'needs-verification');
  for (const content of Object.values(stateFiles(f))) assert.equal(content.includes(password), false);
});

test('connect applies the Settings field rules before any adapter call', async t => {
  const f = fixture(t);
  for (const changes of [{ server: '' }, { server: '   ' }, { server: 'ftp://omni.test' }, { server: 'https://user:pw@omni.test' },
    { server: 'https://omni.test/?q=1' }, { server: 'http://remote.example' }, { server: `https://${'x'.repeat(2049)}` },
    { username: '' }, { username: '   ' }, { username: 'u'.repeat(257) }, { username: undefined },
    { password: '' }, { password: 'p'.repeat(4097) }, { password: undefined }]) {
    const result = await connectWithPassword({ ...f.options, server: SERVER, username: 'admin', password: 'secret-sentinel', ...changes });
    assert.deepEqual(result, { ok: false, error: { code: 'INVALID_SETUP' } }, JSON.stringify(Object.keys(changes)));
  }
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.loc.stateDir), false);
});

test('connect refuses an inactive plugin and reports adapter failures by code only', async t => {
  const f = fixture(t);
  const inactive = await connectWithPassword({ ...f.options, lifecycle: { active: false, reason: 'native-plugin-disabled' },
    server: SERVER, username: 'admin', password: 'secret-sentinel' });
  assert.deepEqual(inactive, { ok: false, error: { code: 'PLUGIN_UNAVAILABLE' } });
  assert.equal(f.calls.length, 0);
  f.adapter.connect = { ok: false, error: { code: 'NEEDS_RESET_ID', message: 'host belongs to another account' } };
  const failed = await connectWithPassword({ ...f.options, server: SERVER, username: 'admin', password: 'secret-sentinel' });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.error, { code: 'NEEDS_RESET_ID' });
  assert.equal(JSON.stringify(failed).includes('another account'), false);
});

test('the stdin reader strips one line ending, refuses a terminal and bounds the input', async () => {
  const stream = (...chunks) => Object.assign((async function* () { for (const chunk of chunks) yield Buffer.from(chunk); })(), { isTTY: false });
  assert.equal(await readPasswordStdin(stream('pass', 'word\r\n')), 'password');
  assert.equal(await readPasswordStdin(stream('two\n\n')), 'two\n');
  assert.equal(await readPasswordStdin(stream()), '');
  await assert.rejects(readPasswordStdin(Object.assign(stream('typed'), { isTTY: true })), { code: 'PASSWORD_STDIN_REQUIRED' });
  await assert.rejects(readPasswordStdin(stream('x'.repeat(70000))), { code: 'INVALID_SETUP' });
});

test('connect CLI takes the password only from stdin and never echoes it', async t => {
  const f = fixture(t);
  const env = { HOME: f.home, PI_CODING_AGENT_DIR: f.agentDir, PATH: '/usr/bin:/bin',
    OMNIGENT_PASSWORD: 'env-secret-sentinel', PI_OMNIGENT_PASSWORD: 'env-secret-sentinel' };
  const run = (args, input = '') => spawnSync(process.execPath, [cli, 'connect', ...args], { encoding: 'utf8', env, input, timeout: 60000 });
  const quiet = (result, ...secrets) => secrets.forEach(secret => assert.equal((result.stdout + result.stderr).includes(secret), false, secret));
  let result = run(['--server', SERVER, '--username', 'admin', '--password', 'argv-secret-sentinel']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /INVALID_ARGUMENTS/);
  quiet(result, 'argv-secret-sentinel');
  result = run(['--server', SERVER, '--username', 'admin']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /PASSWORD_STDIN_REQUIRED/);
  result = run(['--server', SERVER, '--username', 'admin', '--password-stdin'], 'stdin-secret-sentinel\n');
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: 'PLUGIN_UNAVAILABLE' } });
  quiet(result, 'stdin-secret-sentinel');
  // Registered and active: the Settings rules run next. The environment is never a password source.
  const sdk = await loadPiSdk();
  const settings = sdk.SettingsManager.create(f.home, f.agentDir, { projectTrusted: false });
  settings.setPackages([root]); await settings.flush();
  result = run(['--server', SERVER, '--username', 'admin', '--password-stdin'], '');
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: 'INVALID_SETUP' } });
  quiet(result, 'env-secret-sentinel');
  result = run(['--server', 'http://remote.example', '--username', 'admin', '--password-stdin'], 'stdin-secret-sentinel\n');
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: 'INVALID_SETUP' } });
  quiet(result, 'stdin-secret-sentinel');
  assert.equal(fs.existsSync(path.join(f.loc.stateDir, 'state.json')), false);
});
