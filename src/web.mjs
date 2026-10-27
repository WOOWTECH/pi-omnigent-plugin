import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherMarker = 'pi-omnigent-plugin web launcher';

export function webLocations(options = {}) {
  const source = options.loc || options;
  const env = options.env || process.env;
  const home = source.home || env.HOME || os.homedir();
  const agentDir = source.agentDir || env.PI_CODING_AGENT_DIR || env.PI_AGENT_DATA_DIR || path.join(home, '.pi/agent');
  const omniDir = source.omniDir || env.OMNIGENT_CONFIG_HOME || path.join(home, '.omnigent');
  return { home, agentDir, stateDir: source.stateDir || env.PI_OMNIGENT_STATE_DIR || path.join(agentDir, 'omnigent-plugin'), root: source.root || root,
    omniDir, omniDataDir: source.omniDataDir || env.OMNIGENT_DATA_DIR || env.OMNIGENT_CONFIG_HOME || omniDir };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Plugin metadata is unreadable; inspect the plugin state directory.'); }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

export function readOnboarding(options = {}) {
  // Older images may retain onboarding.json. Never surface it as a navigation target.
  return {};
}

/** Compatibility for images that still call this hook during first boot. */
export async function ensureOnboarding(options = {}) {
  return { status: 'settings-only' };
}

export async function loadPiSdk(options = {}) {
  if (options.sdk) return options.sdk;
  const bases = [webLocations(options).root, options.env?.PI_OMNIGENT_SDK_ROOT || process.env.PI_OMNIGENT_SDK_ROOT, process.cwd(), '/usr/local/lib/node_modules/@agegr/pi-web', '/usr/local/lib/node_modules', '/opt/pi-web'].filter(Boolean);
  for (const base of bases) {
    try {
      const directory = path.join(base, path.basename(base) === 'node_modules' ? '' : 'node_modules', '@earendil-works/pi-coding-agent');
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      const entry = manifest.exports?.['.']?.import || manifest.module || manifest.main;
      if (typeof entry !== 'string') continue;
      return await import(pathToFileURL(path.resolve(directory, entry)).href);
    } catch (error) {
      if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ENOENT'].includes(error.code)) throw error;
    }
  }
  throw new Error('Pi SDK is unavailable. Install this plugin in the Pi Agent / Pi Web container.');
}

async function readNativePackageLifecycle(options, loc) {
  try {
    const sdk = await loadPiSdk(options);
    const settings = sdk.SettingsManager.create(options.cwd || loc.home, loc.agentDir, { projectTrusted: false });
    const manager = new sdk.DefaultPackageManager({ cwd: options.cwd || loc.home, agentDir: loc.agentDir, settingsManager: settings });
    const configured = manager.listConfiguredPackages();
    let packageName = '@woowtech/pi-omnigent-plugin';
    try { packageName = JSON.parse(fs.readFileSync(path.join(loc.root, 'package.json'), 'utf8')).name || packageName; } catch {}
    const canonical = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
    const candidates = configured.filter(entry => entry.installedPath && canonical(entry.installedPath) === canonical(loc.root)
      || entry.source === `npm:${packageName}` || entry.source.startsWith(`npm:${packageName}@`)
      || (!entry.source.includes(':') && canonical(path.resolve(entry.scope === 'project' ? options.cwd || loc.home : loc.agentDir, entry.source)) === canonical(loc.root)));
    if (settings.drainErrors?.().length) return { active: false, registered: false, reason: 'package-settings-unreadable' };
    const candidate = candidates.at(-1);
    if (!candidate) return options.allowUnregistered === true
      ? { active: true, registered: false, reason: 'explicit-activation-window' }
      : { active: false, registered: false, reason: 'package-removed-or-unregistered' };
    const values = candidate.scope === 'project' ? settings.getProjectSettings() : settings.getGlobalSettings();
    const entry = (values.packages || []).find(value => (typeof value === 'string' ? value : value.source) === candidate.source);
    const disabled = typeof entry === 'object' && Array.isArray(entry.extensions) && entry.extensions.length === 0;
    return { active: !disabled, registered: true, source: candidate.source, scope: candidate.scope, reason: disabled ? 'native-plugin-disabled' : 'native-plugin-enabled' };
  } catch { return { active: false, registered: false, reason: 'package-lifecycle-unavailable' }; }
}

/** Read native Pi package state; no extension is loaded or dependency installed. */
export async function packageLifecycle(options = {}) {
  if (options.lifecycle) return typeof options.lifecycle === 'function' ? options.lifecycle() : options.lifecycle;
  const loc = webLocations(options);
  let state = await readNativePackageLifecycle(options, loc);
  // A single failed SDK/settings read must not strand the live UI in disabled.
  // Explicit native disable is authoritative; other inactive results are
  // rechecked briefly and still fail closed if they persist.
  for (const delay of [50, 150, 300, 500]) {
    if (state.active || state.reason === 'native-plugin-disabled') break;
    await new Promise(resolve => setTimeout(resolve, delay));
    state = await readNativePackageLifecycle(options, loc);
  }
  return state;
}

/** Observe atomic settings replacement, including native disable/re-enable. */
export function watchPackageLifecycle(onChange, options = {}) {
  const loc = webLocations(options);
  const files = [...new Set([path.join(loc.agentDir, 'settings.json'), path.join(options.cwd || loc.home, '.pi/settings.json')])];
  let pending = Promise.resolve(), closed = false;
  const listener = () => {
    pending = pending.then(async () => { if (!closed) await onChange(await packageLifecycle(options)); }).catch(() => {});
  };
  for (const file of files) fs.watchFile(file, { persistent: false, interval: 500 }, listener);
  return async () => { closed = true; for (const file of files) fs.unwatchFile(file, listener); await pending; };
}

function findExecutable(command, env, exclude = []) {
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const file = path.resolve(directory, command);
    if (exclude.includes(file)) continue;
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

function isOwnedLauncher(file) {
  try { return fs.readFileSync(file, 'utf8').includes(launcherMarker); } catch { return false; }
}

function writeLauncher(file, pluginRoot, realWeb) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const body = `#!/usr/bin/env node\n// ${launcherMarker}\nimport {spawn} from 'node:child_process';\nimport {existsSync} from 'node:fs';\nconst cli=${JSON.stringify(path.join(pluginRoot, 'bin/cli.mjs'))};\nconst native=${JSON.stringify(realWeb)};\nconst child=existsSync(cli)?spawn(${JSON.stringify(process.execPath)},[cli,'launch-web',...process.argv.slice(2)],{stdio:'inherit',env:process.env}):spawn(native,process.argv.slice(2),{stdio:'inherit',env:process.env});\nfor(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));\nchild.on('error',()=>{process.stderr.write('Omnigent web launcher failed.\\n');process.exitCode=1;});\nchild.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});\n`;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body, { mode: 0o755, flag: 'wx' });
  fs.renameSync(temporary, file);
}

function captureKnownUpstream(shim, stateDir) {
  let contents;
  try { contents = fs.readFileSync(shim, 'utf8'); } catch { return null; }
  if (!contents.includes('// pi-agent-shared-runtime launcher')) return null;
  // The sibling's generated launcher uses absolute executable and CLI paths.
  // Other source with the same comment still remains an unknown user launcher.
  const match = contents.match(/spawn\(("(?:[^"\\]|\\.)*"),\[("(?:[^"\\]|\\.)*"),'launch-web'/);
  const fallback = !match && contents.match(/const cli=("(?:[^"\\]|\\.)*");\s*const present=existsSync\(cli\);\s*const child=spawn\(present\?("(?:[^"\\]|\\.)*"):("(?:[^"\\]|\\.)*"),present\?\[cli,'launch-web',\.\.\.process\.argv\.slice\(2\)\]:process\.argv\.slice\(2\),/);
  if (!match && !fallback) return null;
  let executable, cli, native;
  try {
    executable = JSON.parse(match ? match[1] : fallback[2]);
    cli = JSON.parse(match ? match[2] : fallback[1]);
    if (fallback) native = JSON.parse(fallback[3]);
  } catch { return null; }
  if (!path.isAbsolute(executable) || !path.isAbsolute(cli) || !cli.endsWith('/bin/cli.mjs')
    || (native && (!path.isAbsolute(native) || path.resolve(native) === path.resolve(shim)))) return null;
  const hash = createHash('sha256').update(contents).digest('hex');
  const directory = path.join(stateDir, 'launchers');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let backup = path.join(directory, 'pi-web-before-omnigent');
  if (fs.existsSync(backup) && fs.readFileSync(backup, 'utf8') !== contents) backup = `${backup}-${hash.slice(0, 12)}`;
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, contents, { mode: 0o700, flag: 'wx' });
  return { backup, backupHash: hash, originalShim: shim };
}

/** Capture and wrap the existing Pi Web command. Foreign launchers are preserved. */
export async function installHost(options = {}) {
  const loc = webLocations(options);
  const env = options.env || process.env;
  const shim = path.join(loc.home, '.local/bin/pi-web');
  const namedShim = path.join(loc.home, '.local/bin/pi-omnigent-web');
  const file = path.join(loc.stateDir, 'host.json');
  const previous = readJson(file);
  const owned = isOwnedLauncher(shim);
  const upstream = !owned && fs.existsSync(shim) ? captureKnownUpstream(shim, loc.stateDir) : null;
  const foreign = fs.existsSync(shim) && !owned && !upstream;
  const realWeb = options.realWeb || upstream?.backup || (foreign ? shim : previous.realWeb || findExecutable('pi-web', env, [shim, namedShim]));
  if (!realWeb || path.resolve(realWeb) === namedShim || (owned && path.resolve(realWeb) === shim)) {
    return { status: 'host-unavailable', reason: 'Pi Web executable was not found.', launchCommand: 'pi-omnigent launch-web' };
  }
  if (fs.existsSync(namedShim) && !isOwnedLauncher(namedShim)) {
    return { status: 'conflict', reason: 'Existing pi-omnigent-web command was preserved.', realWeb };
  }
  writeLauncher(namedShim, loc.root, realWeb);
  if (!foreign) writeLauncher(shim, loc.root, realWeb);
  const backup = upstream || (owned && previous.backup ? { backup: previous.backup, backupHash: previous.backupHash, originalShim: previous.originalShim } : {});
  const record = { version: 1, realWeb, shim: foreign ? namedShim : shim, namedShim, ...backup,
    mode: foreign ? 'named-wrapper' : backup.backup ? 'chained-path-wrapper' : 'path-wrapper', installedAt: new Date().toISOString() };
  writeJson(file, record);
  return { ...record, status: foreign ? 'composable-wrapper' : 'installed', launchCommand: foreign ? 'pi-omnigent-web' : 'pi-web', ...(foreign ? { reason: 'Existing Pi Web launcher preserved; the named wrapper runs it.' } : {}) };
}

export async function uninstallHost(options = {}) {
  const loc = webLocations(options);
  const metadata = path.join(loc.stateDir, 'host.json');
  const host = readJson(metadata);
  const shim = path.join(loc.home, '.local/bin/pi-web');
  const namedShim = path.join(loc.home, '.local/bin/pi-omnigent-web');
  let status = 'removed';
  if (isOwnedLauncher(shim)) {
    if (host.backup) {
      const contents = fs.readFileSync(host.backup, 'utf8');
      if (createHash('sha256').update(contents).digest('hex') !== host.backupHash) {
        return { status: 'conflict', reason: 'Saved upstream launcher changed; current wrapper was preserved.' };
      }
      const temporary = `${shim}.${process.pid}.restore`;
      fs.writeFileSync(temporary, contents, { mode: 0o755, flag: 'wx' });
      fs.renameSync(temporary, shim);
      status = 'restored';
    } else fs.unlinkSync(shim);
  } else if (host.mode !== 'named-wrapper' && fs.existsSync(shim)) {
    return { status: 'conflict', reason: 'Current Pi Web launcher is not owned by this plugin and was preserved.' };
  }
  if (isOwnedLauncher(namedShim)) fs.unlinkSync(namedShim);
  if (Object.keys(host).length) writeJson(metadata, { ...host, mode: 'uninstalled', uninstalledAt: new Date().toISOString() });
  return { status };
}

export async function boot(options = {}) {
  const lifecycle = await packageLifecycle(options);
  const runtime = options.runtime || await import('./runtime.mjs');
  const runtimeOptions = { loc: webLocations(options), ...(options.env ? { env: options.env } : {}) };
  await runtime.observeLifecycle?.(lifecycle, runtimeOptions);
  if (!lifecycle.active) return { initialization: { phase: 'inactive' }, startup: { status: 'inactive', reason: lifecycle.reason } };
  let current = await runtime.status(runtimeOptions);
  if (current.phase === 'disabled') return { initialization: { phase: 'disabled' }, startup: { status: 'disabled' } };
  let initialization;
  try { initialization = current.phase === 'ready' ? { phase: 'ready', checked: true }
    : typeof runtime.prepare === 'function'
    ? await runtime.prepare(runtimeOptions)
    : { phase: 'needs-login', prepared: false }; }
  catch { initialization = { phase: 'error', reason: 'Omnigent initialization needs attention in Settings.' }; }
  let resumption;
  if (initialization.ok !== false && initialization.phase !== 'error' && typeof runtime.resumeAuthorizedHost === 'function') {
    try { resumption = await runtime.resumeAuthorizedHost({ ...runtimeOptions, lifecycle: () => packageLifecycle(options) }); }
    catch { resumption = { ok: false, resumed: false, error: { code: 'RESUME_FAILED' } }; }
  }
  current = await runtime.status(runtimeOptions);
  // A retained server heartbeat and prior model receipt cannot prove that the
  // local host process survived container replacement. Resume verifies it first.
  const ready = current.phase === 'ready' && (!resumption || resumption.resumed === true);
  return { initialization, ...(resumption ? { resumption } : {}),
    startup: { status: ready ? 'ready' : 'settings-required' } };
}

/** Compose with any captured executable, including another plugin's Pi Web shim. */
export async function launchWeb(args = [], options = {}) {
  const loc = webLocations(options);
  const host = readJson(path.join(loc.stateDir, 'host.json'));
  if (!host.realWeb) throw new Error('Run pi-omnigent install-host before launch-web.');
  const spawnImpl = options.spawn || spawn;
  const env = options.env || process.env;
  const lifecycle = await packageLifecycle(options);
  const runtime = options.runtime || await import('./runtime.mjs');
  const lifecycleOptions = { loc, env };
  await runtime.observeLifecycle?.(lifecycle, lifecycleOptions);
  const child = spawnImpl(host.realWeb, args, { stdio: 'inherit', env });
  const parsedPort = args.findIndex(argument => argument === '--port' || argument === '-p');
  const port = parsedPort >= 0 ? args[parsedPort + 1] : args.find(argument => argument.startsWith('--port='))?.slice(7);
  const workerEnv = { ...env, PI_CODING_AGENT_DIR: loc.agentDir, PI_OMNIGENT_STATE_DIR: loc.stateDir,
    OMNIGENT_CONFIG_HOME: loc.omniDir, OMNIGENT_DATA_DIR: loc.omniDataDir,
    ...(options.webUrl ? { PI_OMNIGENT_PI_WEB_URL: options.webUrl } : port ? { PI_OMNIGENT_PI_WEB_URL: `http://127.0.0.1:${port}` } : {}) };
  // Keep installers/API polling out of the launcher process. The worker owns a
  // process group so stopping Pi Web also stops its unfinished downloads.
  let worker = null, workerExited = true;
  let startup = { status: 'inactive', reason: lifecycle.reason };
  const startWorker = () => {
    if (!workerExited) return;
    worker = spawnImpl(process.execPath, [path.join(loc.root, 'bin/cli.mjs'), 'boot'], { stdio: 'ignore', env: workerEnv, detached: true });
    workerExited = false; startup = { status: 'worker-running' };
    worker.once('error', () => { workerExited = true; startup = { status: 'setup-required' }; });
    worker.once('exit', code => { workerExited = true; startup = { status: 'worker-exited', code }; });
  };
  if (lifecycle.active) startWorker();
  const stopWorker = signal => {
    if (workerExited || !worker) return;
    if (process.platform !== 'win32' && !options.spawn && worker.pid) {
      try { process.kill(-worker.pid, signal); return; } catch {}
    }
    worker.kill(signal);
  };
  const forward = signal => { child.kill(signal); stopWorker(signal); };
  let active = lifecycle.active;
  const stopWatching = watchPackageLifecycle(async next => {
    await runtime.observeLifecycle?.(next, lifecycleOptions);
    if (next.active && !active) startWorker();
    if (!next.active && active) stopWorker('SIGTERM');
    active = next.active;
  }, options);
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map(signal => { const handler = () => forward(signal); process.on(signal, handler); return [signal, handler]; });
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
    });
    stopWorker('SIGTERM');
    return { status: 'web-exited', ...result, boot: startup };
  } finally {
    await stopWatching();
    stopWorker('SIGTERM');
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
