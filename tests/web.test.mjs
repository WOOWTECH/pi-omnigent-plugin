import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installHost, uninstallHost, loadPiSdk, boot, launchWeb, packageLifecycle, watchPackageLifecycle, ensureOnboarding, readOnboarding } from '../src/web.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-omnigent-web-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agentDir = path.join(home, '.pi/agent');
  const stateDir = path.join(agentDir, 'omnigent-plugin');
  return { home, agentDir, stateDir, root: fileURLToPath(new URL('../', import.meta.url)), cwd: home, env: { HOME: home, PATH: '' }, lifecycle: { active: true } };
}

function onboardingSdk() {
  let created = 0;
  return { SessionManager: { create(_cwd, directory) {
    created++;
    fs.mkdirSync(directory, { recursive: true });
    const id = `setup-${created}`, file = path.join(directory, `${id}.jsonl`);
    const entries = [];
    return { appendSessionInfo(value) { entries.push({ type: 'info', value }); },
      appendCustomEntry(type, value) { entries.push({ type, value }); },
      appendMessage(value) { entries.push({ type: 'message', value }); fs.writeFileSync(file, entries.map(x => JSON.stringify(x)).join('\n') + '\n'); },
      getSessionId() { return id; }, getSessionFile() { return file; } };
  } }, get created() { return created; } };
}

test('ready boot preserves status without creating a conversation or calling Pi Web', async t => {
  const options = fixture(t);
  const result = await boot({ ...options, runtime: {
    status: async () => ({ phase: 'ready' }),
    prepare: () => assert.fail('ready startup must not prepare dependencies'),
  }, fetch: () => assert.fail('boot must not call Pi Web') });
  assert.equal(result.startup.status, 'ready');
  assert.equal(fs.existsSync(path.join(options.stateDir, 'onboarding.json')), false);
});

test('incomplete boot prepares dependencies and leaves binding in Settings without a conversation', async t => {
  const options = fixture(t);
  const sdk = onboardingSdk();
  let prepared = false, conversationPresentDuringPrepare = false;
  const result = await boot({ ...options, runtime: {
    status: async () => ({ phase: 'needs-login' }),
    prepare: async input => { prepared = input.loc.stateDir === options.stateDir;
      conversationPresentDuringPrepare = fs.existsSync(path.join(options.stateDir, 'onboarding.json'));
      return { phase: 'needs-login' }; },
  }, sdk, fetch: () => assert.fail('boot must not submit a model turn') });
  assert.equal(prepared, true);
  assert.equal(conversationPresentDuringPrepare, false);
  assert.equal(result.startup.status, 'settings-required');
  assert.equal(sdk.created, 0);
  assert.equal(fs.existsSync(path.join(options.stateDir, 'onboarding.json')), false);
  assert.equal(fs.existsSync(path.join(options.agentDir, 'sessions')), false);
});

test('legacy setup metadata cannot trigger or expose a conversation', async t => {
  const options = fixture(t);
  const sdk = onboardingSdk();
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, 'onboarding.json'), JSON.stringify({ sessionId: 'legacy-session' }));
  const result = await boot({ ...options, sdk, runtime: {
    status: async () => ({ phase: 'needs-login' }),
    prepare: async () => ({ phase: 'needs-login' }),
  } });
  assert.equal(result.startup.status, 'settings-required');
  assert.equal(sdk.created, 0);
  assert.deepEqual(readOnboarding(options), {});
  assert.equal((await ensureOnboarding({ ...options, sdk })).status, 'settings-only');
  assert.equal(sdk.created, 0);
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
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ realWeb: executable(path.join(options.home, 'fixture/pi-web')) }));
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
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ realWeb: executable(path.join(options.home, 'fixture/pi-web')) }));
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

test('native lifecycle rechecks a transient SDK read failure before reporting the plugin disabled', async t => {
  const options = fixture(t);
  let calls = 0;
  const sdk = {
    SettingsManager: { create() {
      calls++;
      if (calls === 1) throw new Error('transient settings read');
      return { drainErrors: () => [], getGlobalSettings: () => ({ packages: [options.root] }) };
    } },
    DefaultPackageManager: class {
      listConfiguredPackages() { return [{ source: options.root, scope: 'global', installedPath: options.root }]; }
    },
  };
  const state = await packageLifecycle({ ...options, sdk, lifecycle: undefined });
  assert.equal(state.active, true);
  assert.equal(state.reason, 'native-plugin-enabled');
  assert.equal(calls, 2);
});

test('an explicitly disabled native package remains disabled without a retry', async t => {
  const options = fixture(t);
  let calls = 0;
  const sdk = {
    SettingsManager: { create() {
      calls++;
      return { drainErrors: () => [], getGlobalSettings: () => ({ packages: [{ source: options.root, extensions: [] }] }) };
    } },
    DefaultPackageManager: class {
      listConfiguredPackages() { return [{ source: options.root, scope: 'global', installedPath: options.root }]; }
    },
  };
  const state = await packageLifecycle({ ...options, sdk, lifecycle: undefined });
  assert.equal(state.active, false);
  assert.equal(state.reason, 'native-plugin-disabled');
  assert.equal(calls, 1);
});

test('native lifecycle tolerates repeated transient absence but still fails closed after the bound', async t => {
  const options = fixture(t);
  let present = false;
  let calls = 0;
  const sdk = {
    SettingsManager: { create() {
      calls++;
      return { drainErrors: () => [], getGlobalSettings: () => ({ packages: present ? [options.root] : [] }) };
    } },
    DefaultPackageManager: class {
      listConfiguredPackages() {
        if (calls === 3) present = true;
        return present ? [{ source: options.root, scope: 'global', installedPath: options.root }] : [];
      }
    },
  };
  assert.equal((await packageLifecycle({ ...options, sdk, lifecycle: undefined })).active, true);
  assert.equal(calls, 3);
  let removalReads = 0;
  const removedSdk = {
    SettingsManager: { create() { removalReads++; return { drainErrors: () => [] }; } },
    DefaultPackageManager: class { listConfiguredPackages() { return []; } },
  };
  const removed = await packageLifecycle({ ...options, sdk: removedSdk, lifecycle: undefined });
  assert.equal(removed.active, false);
  assert.equal(removed.reason, 'package-removed-or-unregistered');
  assert.equal(removalReads, 5);
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

function executable(file, body = '#!/bin/sh\nexit 0\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function deletedRealWeb(options) {
  const gone = executable(path.join(options.home, 'old-ui-copy/bin/pi-web.js'));
  fs.rmSync(path.dirname(path.dirname(gone)), { recursive: true });
  return gone;
}

const launchReceipt = options => JSON.parse(fs.readFileSync(path.join(options.stateDir, 'launch.json'), 'utf8'));

test('install-host replaces a deleted recorded realWeb with the first healthy pi-web on PATH and records why', async t => {
  const options = fixture(t);
  const gone = deletedRealWeb(options);
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ version: 1, realWeb: gone, mode: 'path-wrapper' }));
  const healthy = executable(path.join(options.home, 'image/bin/pi-web'));
  const installed = await installHost({ ...options, env: { ...options.env, PATH: path.dirname(healthy) } });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.realWeb, healthy);
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.stateDir, 'host.json'))).realWeb, healthy);
  assert.ok(fs.readFileSync(installed.shim, 'utf8').includes(`const native=${JSON.stringify(healthy)};`));
  const receipt = launchReceipt(options);
  assert.equal(receipt.by, 'install-host');
  assert.equal(receipt.realWeb, healthy);
  assert.equal(receipt.source, 'path');
  assert.equal(receipt.recorded, gone);
  assert.deepEqual(receipt.rejected, [{ source: 'recorded', path: gone, problem: 'missing' }]);
});

test('install-host keeps a recorded realWeb that still runs, even when PATH has another pi-web', async t => {
  const options = fixture(t);
  const recorded = executable(path.join(options.home, 'custom/pi-web'));
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ version: 1, realWeb: recorded, mode: 'path-wrapper' }));
  const other = executable(path.join(options.home, 'image/bin/pi-web'));
  const installed = await installHost({ ...options, env: { ...options.env, PATH: path.dirname(other) } });
  assert.equal(installed.realWeb, recorded);
  assert.equal(launchReceipt(options).source, 'recorded');
});

test('a recorded realWeb that is not executable falls back to the captured upstream launcher before PATH', async t => {
  const options = fixture(t);
  const shim = path.join(options.home, '.local/bin/pi-web');
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, '#!/usr/bin/env node\n// pi-agent-shared-runtime launcher\nimport {spawn} from "node:child_process";\nconst child=spawn("/usr/bin/node",["/workspace/pi-agent-shared-runtime/bin/cli.mjs",\'launch-web\',...process.argv.slice(2)],{stdio:"inherit"});\n', { mode: 0o755 });
  const first = await installHost(options);
  assert.equal(first.mode, 'chained-path-wrapper');
  const host = path.join(options.stateDir, 'host.json');
  const notExecutable = path.join(options.home, 'not-executable/pi-web');
  fs.mkdirSync(path.dirname(notExecutable), { recursive: true });
  fs.writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });
  fs.writeFileSync(host, JSON.stringify({ ...JSON.parse(fs.readFileSync(host)), realWeb: notExecutable }));
  const other = executable(path.join(options.home, 'image/bin/pi-web'));
  const repaired = await installHost({ ...options, env: { ...options.env, PATH: path.dirname(other) } });
  assert.equal(repaired.realWeb, first.backup);
  assert.equal(repaired.mode, 'chained-path-wrapper');
  assert.equal(repaired.backup, first.backup);
  const receipt = launchReceipt(options);
  assert.equal(receipt.source, 'backup');
  assert.deepEqual(receipt.rejected, [{ source: 'recorded', path: notExecutable, problem: 'not-executable' }]);
});

test('launch-web runs the first healthy pi-web on PATH when the recorded realWeb was deleted, skipping this plugin\'s launcher', async t => {
  const options = fixture(t);
  const gone = deletedRealWeb(options);
  const installed = await installHost({ ...options, realWeb: executable(path.join(options.home, 'seed/pi-web')) });
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(options.stateDir, 'host.json'))), realWeb: gone }));
  const healthy = executable(path.join(options.home, 'image/bin/pi-web'));
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter(); child.kill = () => {};
    if (calls.length === 1) setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  const env = { ...options.env, PATH: [path.dirname(installed.shim), path.dirname(healthy)].join(path.delimiter) };
  const result = await launchWeb(['--port', '30141'], { ...options, env, spawn, lifecycle: { active: false, reason: 'native-plugin-disabled' },
    runtime: { observeLifecycle: async () => {} } });
  assert.equal(result.code, 0);
  assert.equal(calls[0].command, healthy);
  assert.deepEqual(calls[0].args, ['--port', '30141']);
  const receipt = launchReceipt(options);
  assert.equal(receipt.by, 'launch-web');
  assert.equal(receipt.realWeb, healthy);
  assert.equal(receipt.source, 'path');
  assert.deepEqual(receipt.rejected, [
    { source: 'recorded', path: gone, problem: 'missing' },
    { source: 'path', path: installed.shim, problem: 'launcher-path' },
  ]);
});

test('a recorded realWeb that is this plugin\'s own launcher is never started again', async t => {
  const options = fixture(t);
  const installed = await installHost({ ...options, realWeb: executable(path.join(options.home, 'seed/pi-web')) });
  const host = path.join(options.stateDir, 'host.json');
  fs.writeFileSync(host, JSON.stringify({ ...JSON.parse(fs.readFileSync(host)), realWeb: installed.namedShim }));
  const healthy = executable(path.join(options.home, 'image/bin/pi-web'));
  const calls = [];
  const spawn = command => {
    calls.push(command);
    const child = new EventEmitter(); child.kill = () => {};
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  await launchWeb([], { ...options, env: { ...options.env, PATH: path.dirname(healthy) }, spawn,
    lifecycle: { active: false, reason: 'native-plugin-disabled' }, runtime: { observeLifecycle: async () => {} } });
  assert.deepEqual(calls, [healthy]);
  assert.deepEqual(launchReceipt(options).rejected, [{ source: 'recorded', path: installed.namedShim, problem: 'plugin-launcher' }]);
});

test('launch-web fails with PI_WEB_UNAVAILABLE and records every rejected candidate when nothing can run', async t => {
  const options = fixture(t);
  const gone = deletedRealWeb(options);
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ version: 1, realWeb: gone, mode: 'path-wrapper' }));
  let spawned = 0;
  await assert.rejects(launchWeb([], { ...options, spawn: () => { spawned++; }, lifecycle: { active: false, reason: 'native-plugin-disabled' },
    runtime: { observeLifecycle: async () => {} } }), { code: 'PI_WEB_UNAVAILABLE' });
  assert.equal(spawned, 0);
  const receipt = launchReceipt(options);
  assert.equal(receipt.realWeb, null);
  assert.deepEqual(receipt.rejected, [{ source: 'recorded', path: gone, problem: 'missing' }]);
});

test('the installed pi-web wrapper starts the healthy PATH Pi Web instead of exiting with ENOENT after the recorded copy is deleted', async t => {
  const options = fixture(t);
  const old = executable(path.join(options.home, 'old-ui-copy/bin/pi-web.js'));
  const installed = await installHost({ ...options, realWeb: old });
  fs.rmSync(path.join(options.home, 'old-ui-copy'), { recursive: true });
  const marker = path.join(options.home, 'started.txt');
  const healthy = executable(path.join(options.home, 'image/bin/pi-web'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\n`);
  const result = await promisify(execFile)(process.execPath, [installed.shim, '--port', '30141'], { timeout: 20000,
    env: { HOME: options.home, PI_CODING_AGENT_DIR: options.agentDir, PATH: [path.dirname(healthy), '/usr/bin', '/bin'].join(path.delimiter) } })
    .catch(error => error);
  assert.equal(result.code ?? 0, 0, `wrapper failed: ${result.stdout ?? ''}`);
  assert.equal(fs.readFileSync(marker, 'utf8'), '--port\n30141\n');
  assert.equal(launchReceipt(options).realWeb, healthy);
});

function exitingSpawn(calls) {
  return (command, args, settings) => {
    calls.push({ command, settings });
    const child = new EventEmitter(); child.kill = () => {};
    if (calls.length === 1) setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
}
const inactive = { lifecycle: { active: false, reason: 'native-plugin-disabled' }, runtime: { observeLifecycle: async () => {} } };

test('launch-web never falls back to the launchers through a PATH alias of ~/.local/bin or a link to pi-omnigent-web', async t => {
  const options = fixture(t);
  const gone = deletedRealWeb(options);
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ version: 1, realWeb: gone, mode: 'path-wrapper' }));
  // Foreign launchers that call back into the plugin; starting either would loop.
  const bin = path.join(options.home, '.local/bin');
  executable(path.join(bin, 'pi-web'), '#!/bin/sh\nexec pi-omnigent-web "$@"\n');
  executable(path.join(bin, 'pi-omnigent-web'), '#!/bin/sh\nexec pi-web "$@"\n');
  const alias = path.join(options.home, 'alias-bin'), links = path.join(options.home, 'links');
  fs.symlinkSync(bin, alias);
  fs.mkdirSync(links);
  fs.symlinkSync(path.join(bin, 'pi-omnigent-web'), path.join(links, 'pi-web'));
  const healthy = executable(path.join(options.home, 'image/bin/pi-web'));
  const calls = [];
  const env = { ...options.env, PATH: [alias, links, path.dirname(healthy)].join(path.delimiter) };
  await launchWeb([], { ...options, ...inactive, env, spawn: exitingSpawn(calls) });
  assert.deepEqual(calls.map(call => call.command), [healthy]);
  assert.deepEqual(launchReceipt(options).rejected, [
    { source: 'recorded', path: gone, problem: 'missing' },
    { source: 'path', path: path.join(alias, 'pi-web'), problem: 'launcher-path' },
    { source: 'path', path: path.join(links, 'pi-web'), problem: 'launcher-path' },
  ]);
});

test('launch-web skips relative PATH entries, which name the working directory instead of an installation', async t => {
  const options = fixture(t);
  const gone = deletedRealWeb(options);
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ version: 1, realWeb: gone, mode: 'path-wrapper' }));
  // PATH=node_modules/.bin:... while the launcher runs inside some project.
  const project = executable(path.join(options.home, 'project/node_modules/.bin/pi-web'));
  const relative = path.relative(process.cwd(), path.dirname(project));
  assert.equal(path.isAbsolute(relative), false);
  assert.equal(path.resolve(relative, 'pi-web'), project);
  const healthy = executable(path.join(options.home, 'image/bin/pi-web'));
  const calls = [];
  const env = { ...options.env, PATH: ['', relative, path.dirname(healthy)].join(path.delimiter) };
  await launchWeb([], { ...options, ...inactive, env, spawn: exitingSpawn(calls) });
  assert.deepEqual(calls.map(call => call.command), [healthy]);
  assert.deepEqual(launchReceipt(options).rejected, [{ source: 'recorded', path: gone, problem: 'missing' }]);
});

test('launch-web marks only the Pi Web it starts and refuses to run again inside it', async t => {
  const options = fixture(t);
  const realWeb = executable(path.join(options.home, 'image/bin/pi-web'));
  await installHost({ ...options, realWeb });
  const calls = [];
  await launchWeb([], { ...options, runtime: { observeLifecycle: async () => {} }, spawn: exitingSpawn(calls) });
  assert.equal(calls[0].command, realWeb);
  assert.equal(calls[0].settings.env.PI_OMNIGENT_LAUNCH_WEB, String(process.pid));
  assert.equal(Object.hasOwn(calls[1].settings.env, 'PI_OMNIGENT_LAUNCH_WEB'), false, 'the boot worker is not marked');
  const receipt = fs.readFileSync(path.join(options.stateDir, 'launch.json'), 'utf8');
  let spawned = 0;
  await assert.rejects(launchWeb([], { ...options, ...inactive, env: calls[0].settings.env, spawn: () => { spawned++; } }), { code: 'PI_WEB_LAUNCH_LOOP' });
  assert.equal(spawned, 0);
  assert.equal(fs.readFileSync(path.join(options.stateDir, 'launch.json'), 'utf8'), receipt, 'the outer launch receipt is kept');
});

test('a chosen pi-web that runs the plugin launcher again stops after one round with PI_WEB_LAUNCH_LOOP', async t => {
  const options = fixture(t);
  const counter = path.join(options.home, 'rounds');
  // A foreign wrapper that calls back into pi-web. It gives up by itself after three rounds, so a
  // missing guard ends with exit 99 instead of recursing forever.
  const looping = path.join(options.home, 'wrapper/pi-web');
  const installed = await installHost({ ...options, realWeb: executable(looping) });
  executable(looping, `#!/bin/sh\ncount=0\n[ -f ${JSON.stringify(counter)} ] && read -r count < ${JSON.stringify(counter)}\ncount=$((count + 1))\n`
    + `echo "$count" > ${JSON.stringify(counter)}\n[ "$count" -gt 3 ] && exit 99\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(installed.shim)} "$@"\n`);
  const result = await promisify(execFile)(process.execPath, [installed.shim], { timeout: 60000,
    env: { HOME: options.home, PI_CODING_AGENT_DIR: options.agentDir, PATH: '' } }).catch(error => error);
  assert.equal(result.code, 1, `launcher output: ${result.stdout ?? ''}`);
  assert.equal(fs.readFileSync(counter, 'utf8').trim(), '1');
  const output = JSON.parse(result.stdout);
  assert.equal(output.error, 'Operation failed (PI_WEB_LAUNCH_LOOP).');
  assert.match(output.hint, /pi-omnigent doctor/);
});

test('launch-web CLI keeps a fixed doctor hint when no Pi Web can run', async t => {
  const options = fixture(t);
  const gone = deletedRealWeb(options);
  fs.mkdirSync(options.stateDir, { recursive: true });
  fs.writeFileSync(path.join(options.stateDir, 'host.json'), JSON.stringify({ version: 1, realWeb: gone, mode: 'path-wrapper' }));
  const result = await promisify(execFile)(process.execPath, [path.join(options.root, 'bin/cli.mjs'), 'launch-web'], { timeout: 60000,
    env: { HOME: options.home, PI_CODING_AGENT_DIR: options.agentDir, PATH: '' } }).catch(error => error);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), { phase: 'error', error: 'Operation failed (PI_WEB_UNAVAILABLE).', hint: 'run pi-omnigent doctor' });
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
