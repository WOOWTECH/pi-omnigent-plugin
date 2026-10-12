import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureOnboarding, installHost, uninstallHost, loadPiSdk, boot, startOnboardingSession, launchWeb, packageLifecycle, watchPackageLifecycle } from '../src/web.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-omnigent-web-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agentDir = path.join(home, '.pi/agent');
  const stateDir = path.join(agentDir, 'omnigent-plugin');
  return { home, agentDir, stateDir, root: fileURLToPath(new URL('../', import.meta.url)), cwd: home, env: { HOME: home, PATH: '' }, lifecycle: { active: true } };
}

test('SDK onboarding persists a discoverable conversation once under the requested data root', async t => {
  const options = fixture(t);
  const sdk = await loadPiSdk();
  const created = await ensureOnboarding({ ...options, sdk });
  assert.equal(created.status, 'created');
  assert.ok(created.sessionFile.startsWith(path.join(options.agentDir, 'sessions')));
  const reopened = sdk.SessionManager.open(created.sessionFile);
  assert.equal(reopened.getSessionName(), 'Omnigent 連線設定');
  assert.equal(reopened.getSessionId(), created.sessionId);
  assert.equal(reopened.getEntries().filter(entry => entry.type === 'message').length, 1);
  const repeated = await ensureOnboarding({ ...options, sdk });
  assert.equal(repeated.status, 'reused');
  assert.equal(repeated.sessionId, created.sessionId);
  assert.match(created.url, /^\/\?session=/);
});

test('parallel initialization shares one persisted onboarding session', async t => {
  const options = fixture(t);
  const sdk = await loadPiSdk();
  const sessions = await Promise.all(Array.from({ length: 5 }, () => ensureOnboarding({ ...options, sdk })));
  assert.equal(new Set(sessions.map(session => session.sessionId)).size, 1);
  assert.equal(sessions.filter(session => session.status === 'created').length, 1);
});

test('ready boot checks status without reinstalling, reconnecting, creating chat, or calling Pi Web', async t => {
  const options = fixture(t);
  let statusOptions;
  const result = await boot({ ...options, runtime: {
    status: async input => { statusOptions = input; return { phase: 'ready' }; },
    initialize: () => assert.fail('ready startup must not initialize'),
    prepare: () => assert.fail('ready startup must not prepare dependencies'),
  }, fetch: () => assert.fail('ready startup must not call web') });
  assert.equal(result.startup.status, 'ready');
  assert.equal(statusOptions.loc.stateDir, options.stateDir);
  assert.equal(fs.existsSync(options.stateDir), false);
});

test('disabled boot has no onboarding or installation side effects', async t => {
  const options = fixture(t);
  const result = await boot({ ...options, runtime: { status: async () => ({ phase: 'disabled' }), initialize: () => assert.fail('disabled startup must not initialize'), prepare: () => assert.fail('disabled startup must not install') } });
  assert.equal(result.startup.status, 'disabled');
  assert.equal(fs.existsSync(options.stateDir), false);
});

test('incomplete boot creates chat and starts extension runtime without model prompt or secret state', async t => {
  const options = fixture(t);
  const sdk = await loadPiSdk();
  const requests = [];
  let prepared = false;
  const secret = 'only-in-memory-fixture-password';
  const result = await boot({ ...options, sdk, env: { ...options.env, PI_WEB_PASSWORD: secret }, runtime: {
    status: async () => ({ phase: 'needs-login' }),
    initialize: () => assert.fail('startup must never initialize using ambient credentials'),
    prepare: async input => { prepared = input.loc.stateDir === options.stateDir; return { phase: 'needs-login' }; },
  }, fetch: async (url, request) => { requests.push({ url: String(url), request }); return { ok: true, json: async () => ({ data: { commands: [{ name: 'omnigent' }] } }) }; } });
  assert.equal(prepared, true);
  assert.equal(result.startup.status, 'started');
  assert.deepEqual(JSON.parse(requests[0].request.body), { type: 'get_commands' });
  assert.equal(Buffer.from(requests[0].request.headers.Authorization.slice(6), 'base64').toString(), `pi:${secret}`);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(fs.readFileSync(path.join(options.stateDir, 'onboarding.json'), 'utf8').includes(secret), false);
});

test('web auth rejection preserves saved conversation and returns safe manual recovery', async () => {
  const result = await startOnboardingSession('session-id', { attempts: 1, fetch: async () => ({ ok: false, status: 401 }) });
  assert.equal(result.status, 'manual-open-required');
});

test('postinstall readiness reloads only the generated onboarding session until the plugin command is loaded', async () => {
  const commands = [];
  let loaded = false;
  const result = await startOnboardingSession('owned-onboarding-id', { attempts: 3, retryDelay: 0, fetch: async (url, request) => {
    assert.equal(new URL(url).pathname, '/api/agent/owned-onboarding-id');
    const command = JSON.parse(request.body);
    commands.push(command.type);
    if (command.type === 'reload') loaded = true;
    return { ok: true, json: async () => ({ data: { commands: loaded ? [{ name: 'omnigent' }] : [] } }) };
  } });
  assert.equal(result.status, 'started');
  assert.deepEqual(commands, ['get_commands', 'reload', 'get_commands']);
});

test('host startup refuses a remote credential destination', async () => {
  await assert.rejects(startOnboardingSession('id', { webUrl: 'https://remote.example.com', fetch: () => assert.fail('must not send credentials') }), /local HTTP origin/);
});

test('unknown Pi Web launcher is preserved and a named wrapper composes it', async t => {
  const options = fixture(t);
  const shim = path.join(options.home, '.local/bin/pi-web');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, '#!/bin/sh\nexec /custom/pi-web "$@"\n', { mode: 0o755 });
  const original = fs.readFileSync(shim, 'utf8');
  const installed = await installHost(options);
  assert.equal(installed.status, 'composable-wrapper');
  assert.equal(installed.realWeb, shim);
  assert.equal(fs.readFileSync(shim, 'utf8'), original);
  assert.equal(fs.existsSync(installed.namedShim), true);
  await uninstallHost(options);
  assert.equal(fs.readFileSync(shim, 'utf8'), original);
});

test('recognized sibling launcher is backed up and chained without self-recursion; uninstall restores bytes', async t => {
  const options = fixture(t);
  const shim = path.join(options.home, '.local/bin/pi-web');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  const original = '#!/usr/bin/env node\n// pi-agent-shared-runtime launcher\nimport {spawn} from "node:child_process";\nconst child=spawn("/usr/bin/node",["/workspace/pi-agent-shared-runtime/bin/cli.mjs",\'launch-web\',...process.argv.slice(2)],{stdio:"inherit"});\n';
  fs.writeFileSync(shim, original, { mode: 0o755 });
  const installed = await installHost(options);
  assert.equal(installed.mode, 'chained-path-wrapper');
  assert.notEqual(installed.realWeb, shim);
  assert.equal(fs.readFileSync(installed.backup, 'utf8'), original);
  const repeated = await installHost(options);
  assert.equal(repeated.realWeb, installed.realWeb);
  assert.equal(repeated.backup, installed.backup);
  assert.equal((await uninstallHost(options)).status, 'restored');
  assert.equal(fs.readFileSync(shim, 'utf8'), original);
});

test('fallback shared-runtime launcher from Pi 6 is chained and restored byte for byte', async t => {
  const options = fixture(t);
  const shim = path.join(options.home, '.local/bin/pi-web');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  const original = `#!/usr/bin/env node
// pi-agent-shared-runtime launcher
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
const cli="/data/pi-agent/git/github.com/WOOWTECH/pi-agent-shared-runtime/bin/cli.mjs";
const present=existsSync(cli);
const child=spawn(present?"/usr/bin/node":"/usr/local/bin/pi-web",present?[cli,'launch-web',...process.argv.slice(2)]:process.argv.slice(2),{stdio:'inherit'});
child.on('error',()=>process.exit(1));
for(const s of ['SIGINT','SIGTERM','SIGHUP'])process.on(s,()=>child.kill(s));
child.on('exit',c=>process.exit(c??1));
`;
  fs.writeFileSync(shim, original, { mode: 0o755 });
  const result = await installHost(options);
  assert.equal(result.mode, 'chained-path-wrapper');
  assert.notEqual(result.realWeb, shim);
  assert.equal(fs.readFileSync(result.backup, 'utf8'), original);
  assert.equal((await uninstallHost(options)).status, 'restored');
  assert.equal(fs.readFileSync(shim, 'utf8'), original);
});

test('fallback sibling with relative native executable remains an untouched foreign launcher', async t => {
  const options = fixture(t);
  const shim = path.join(options.home, '.local/bin/pi-web');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  const original = `// pi-agent-shared-runtime launcher
const cli="/data/pi-agent/git/github.com/WOOWTECH/pi-agent-shared-runtime/bin/cli.mjs";
const present=existsSync(cli);
const child=spawn(present?"/usr/bin/node":"pi-web",present?[cli,'launch-web',...process.argv.slice(2)]:process.argv.slice(2),{stdio:'inherit'});
`;
  fs.writeFileSync(shim, original, { mode: 0o755 });
  assert.equal((await installHost(options)).mode, 'named-wrapper');
  assert.equal(fs.readFileSync(shim, 'utf8'), original);
});

test('incomplete setup restarts a stale loaded extension only once before reporting started', async () => {
  const commands = [];
  const result = await startOnboardingSession('owned-onboarding-id', { attempts: 3, retryDelay: 0, fetch: async (url, request) => {
    assert.equal(new URL(url).pathname, '/api/agent/owned-onboarding-id');
    const command = JSON.parse(request.body); commands.push(command.type);
    return { ok: true, json: async () => ({ success: true, data: { commands: [{ name: 'omnigent' }] } }) };
  } });
  assert.equal(result.status, 'started');
  assert.deepEqual(commands, ['get_commands', 'reload', 'get_commands']);
});

test('sibling marker with relative executable does not authorize wrapping its default path', async t => {
  const options = fixture(t);
  const shim = path.join(options.home, '.local/bin/pi-web');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  const original = '// pi-agent-shared-runtime launcher\nconst child=spawn("node",["relative/bin/cli.mjs",\'launch-web\']);\n';
  fs.writeFileSync(shim, original, { mode: 0o755 });
  const installed = await installHost(options);
  assert.equal(installed.mode, 'named-wrapper');
  assert.equal(fs.readFileSync(shim, 'utf8'), original);
});

test('launcher propagates port and terminates its supervised boot worker when Pi Web exits', async t => {
  const options = fixture(t);
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ realWeb: '/fixture/pi-web' }));
  const calls = [], processes = [];
  const spawn = (command, args, settings) => {
    calls.push({ command, args, settings });
    const process = new EventEmitter();
    process.signals = [];
    process.kill = signal => { process.signals.push(signal); };
    processes.push(process);
    return process;
  };
  const resultPromise = launchWeb(['--port=43210'], { ...options, spawn });
  await new Promise(resolve => setImmediate(resolve));
  processes[0].emit('exit', 0, null);
  const result = await resultPromise;
  assert.equal(result.code, 0);
  assert.equal(calls[1].settings.env.PI_OMNIGENT_PI_WEB_URL, 'http://127.0.0.1:43210');
  assert.equal(calls[1].settings.detached, true);
  assert.ok(processes[1].signals.includes('SIGTERM'));
});

test('launcher observes re-enable without any loaded extension and stops only its boot worker on disable', async t => {
  const options = fixture(t);
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ realWeb: '/fixture/pi-web' }));
  const settings = path.join(options.agentDir, 'settings.json');
  fs.writeFileSync(settings, '{}');
  let active = false;
  const processes = [], observed = [];
  const spawn = () => {
    const child = new EventEmitter(); child.signals = [];
    child.kill = signal => { child.signals.push(signal); child.emit('exit', 0); };
    processes.push(child); return child;
  };
  const result = launchWeb([], { ...options, spawn,
    lifecycle: () => ({ active, reason: active ? 'native-plugin-enabled' : 'native-plugin-disabled' }),
    runtime: { observeLifecycle: async value => observed.push(value.active) },
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(processes.length, 1);
  active = true; fs.writeFileSync(settings, '{"enabled":true}');
  for (let i = 0; i < 20 && processes.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(processes.length, 2);
  active = false; fs.writeFileSync(settings, '{"enabled":false}');
  for (let i = 0; i < 20 && !processes[1].signals.length; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(processes[1].signals.includes('SIGTERM'));
  assert.equal(processes[0].signals.length, 0);
  assert.ok(observed.includes(true));
  processes[0].emit('exit', 0); await result;
});

test('native package disable and removal stop lifecycle activation without loading extension code', async t => {
  const options = fixture(t);
  const sdk = await loadPiSdk();
  const settings = sdk.SettingsManager.create(options.home, options.agentDir, { projectTrusted: false });
  settings.setPackages([options.root]); await settings.flush();
  assert.equal((await packageLifecycle({ ...options, sdk, lifecycle: undefined })).active, true);
  settings.setPackages([{ source: options.root, extensions: [], skills: [], prompts: [], themes: [] }]); await settings.flush();
  assert.deepEqual((await packageLifecycle({ ...options, sdk, lifecycle: undefined })).reason, 'native-plugin-disabled');
  assert.equal((await packageLifecycle({ ...options, sdk, lifecycle: undefined, allowUnregistered: true })).active, false);
  settings.setPackages([]); await settings.flush();
  assert.equal((await packageLifecycle({ ...options, sdk, lifecycle: undefined })).active, false);
  assert.equal((await packageLifecycle({ ...options, sdk, lifecycle: undefined, allowUnregistered: true })).reason, 'explicit-activation-window');
});

test('inactive native package never calls runtime status, installs dependencies, or creates a chat', async t => {
  const options = fixture(t);
  const result = await boot({ ...options, lifecycle: { active: false, reason: 'native-plugin-disabled' }, runtime: {
    status: () => assert.fail('inactive plugin must not inspect adapter'), prepare: () => assert.fail('inactive plugin must not install'),
  } });
  assert.equal(result.startup.status, 'inactive');
  assert.equal(fs.existsSync(options.stateDir), false);
});

test('deleted plugin CLI falls back to captured native Pi Web executable', async t => {
  const options = fixture(t);
  const realWeb = path.join(options.home, 'native-pi-web');
  fs.writeFileSync(realWeb, '#!/bin/sh\nprintf "fallback-ok:%s\\n" "$1"\n', { mode: 0o755 });
  const installed = await installHost({ ...options, root: path.join(options.home, 'removed-package'), realWeb });
  const result = await promisify(execFile)(process.execPath, [installed.shim, 'argument-preserved'], { timeout: 5000 });
  assert.equal(result.stdout.trim(), 'fallback-ok:argument-preserved');
});

test('native settings watcher observes atomic disable and enable replacements and stops cleanly', async t => {
  const options = fixture(t); const sdk = await loadPiSdk();
  const settings = sdk.SettingsManager.create(options.home, options.agentDir, { projectTrusted: false });
  settings.setPackages([options.root]); await settings.flush();
  const observed = [];
  const stop = watchPackageLifecycle(value => observed.push(value.active), { ...options, lifecycle: undefined, sdk });
  t.after(stop);
  // watchFile takes an initial stat asynchronously.
  await new Promise(resolve => setTimeout(resolve, 600));
  settings.setPackages([{ source: options.root, extensions: [] }]); await settings.flush();
  for (let i = 0; i < 20 && !observed.includes(false); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(observed.includes(false));
  settings.setPackages([options.root]); await settings.flush();
  for (let i = 0; i < 20 && observed.at(-1) !== true; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(observed.at(-1), true);
  await stop(); const count = observed.length;
  settings.setPackages([]); await settings.flush();
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(observed.length, count);
});
