import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { locked } from './common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherMarker = 'pi-omnigent-plugin web launcher';
const onboardingTitle = 'Omnigent 連線設定';

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

async function withOnboardingLock(stateDir, callback) {
  const lock = path.join(stateDir, 'onboarding.lock');
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await locked(lock, callback);
    if (!result?.busy) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Another process is preparing the Omnigent onboarding conversation.');
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

export function readOnboarding(options = {}) {
  return readJson(path.join(webLocations(options).stateDir, 'onboarding.json'));
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

/** Create a real SDK session without spending model tokens or storing account data. */
export async function ensureOnboarding(options = {}) {
  const loc = webLocations(options);
  return withOnboardingLock(loc.stateDir, async () => {
    const file = path.join(loc.stateDir, 'onboarding.json');
    const current = readJson(file);
    if (current.sessionId && current.sessionFile && fs.existsSync(current.sessionFile)) {
      return { ...current, status: 'reused', url: `/?session=${encodeURIComponent(current.sessionId)}` };
    }
    if (options.ready) return { status: 'ready', sessionId: null };
    const sdk = await loadPiSdk(options);
    const cwd = path.resolve(options.cwd || loc.home);
    const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    const session = sdk.SessionManager.create(cwd, path.join(loc.agentDir, 'sessions', safePath));
    session.appendSessionInfo(onboardingTitle);
    session.appendCustomEntry('omnigent-onboarding', { version: 1 });
    // Pi does not persist name/custom-only sessions. A harmless initial user message
    // creates the file; no model turn is submitted by this module.
    session.appendMessage({ role: 'user', content: '啟動 Omnigent 連線設定精靈。伺服器與帳號資訊請在設定面板填寫，密碼不要貼在對話裡。', timestamp: Date.now() });
    const record = { version: 1, sessionId: session.getSessionId(), sessionFile: session.getSessionFile(), cwd, createdAt: new Date().toISOString() };
    writeJson(file, record);
    return { ...record, status: 'created', url: `/?session=${encodeURIComponent(record.sessionId)}` };
  });
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

function localWebUrl(options) {
  const env = options.env || process.env;
  const base = new URL(options.webUrl || env.PI_OMNIGENT_PI_WEB_URL || `http://127.0.0.1:${options.port || env.PORT || env.PI_WEB_PORT || '30141'}`);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Pi Web boot endpoint must be a local HTTP origin.');
  }
  return base;
}

/** Start only the saved setup session. The API call does not submit an LLM prompt. */
export async function startOnboardingSession(sessionId, options = {}) {
  const base = localWebUrl(options);
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const password = env.PI_WEB_PASSWORD;
  const headers = { 'Content-Type': 'application/json', ...(password ? { Authorization: `Basic ${Buffer.from(`pi:${password}`).toString('base64')}` } : {}) };
  const request = command => fetchImpl(new URL(`/api/agent/${encodeURIComponent(sessionId)}`, base), {
    method: 'POST', headers, body: JSON.stringify(command), signal: AbortSignal.timeout(5000),
  });
  const attempts = options.attempts ?? 30;
  let restarted = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await request({ type: 'get_commands' });
      if (response.ok) {
        const body = await response.json();
        if (body.data?.commands?.some(command => command.name === 'omnigent') && restarted) return { status: 'started', sessionId };
        // npm postinstall runs before installAndPersist writes the package entry.
        // A loaded command does not prove the wizard is still waiting for input.
        // Restart only this saved setup session once when it is already loaded;
        // the read-only commands check then confirms the restarted binding.
        const reload = await request({ type: 'reload' });
        if ([401, 403].includes(reload.status)) return { status: 'manual-open-required', reason: 'Pi Web did not accept local authentication.', sessionId };
        if (reload.ok) {
          const result = await reload.json();
          if (result.success !== false) {
            restarted = true;
            const checked = await request({ type: 'get_commands' });
            if ([401, 403].includes(checked.status)) return { status: 'manual-open-required', reason: 'Pi Web did not accept local authentication.', sessionId };
            if (checked.ok && (await checked.json()).data?.commands?.some(command => command.name === 'omnigent')) return { status: 'started', sessionId };
          }
        }
      }
      if ([401, 403].includes(response.status)) return { status: 'manual-open-required', reason: 'Pi Web did not accept local authentication.', sessionId };
    } catch {}
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, options.retryDelay ?? 500));
  }
  return { status: 'manual-open-required', reason: 'Pi Web or the plugin was not ready. Reload and open the saved onboarding conversation.', sessionId };
}

/** Sync a native settings change with the saved wizard, preserving active turns. */
export async function refreshOnboardingSession(options = {}) {
  const record = readOnboarding(options);
  const sessionId = record.sessionId;
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(sessionId)) return { status: 'no-onboarding' };
  const base = localWebUrl(options);
  const env = options.env || process.env;
  const fetchImpl = options.fetch || fetch;
  const headers = { 'Content-Type': 'application/json', ...(env.PI_WEB_PASSWORD
    ? { Authorization: `Basic ${Buffer.from(`pi:${env.PI_WEB_PASSWORD}`).toString('base64')}` } : {}) };
  try {
    const sessions = await fetchImpl(new URL('/api/sessions?summary=1', base), { headers, signal: AbortSignal.timeout(5000) });
    if (!sessions.ok) return { status: 'manual-open-required' };
    const body = await sessions.json();
    if (!Array.isArray(body.runningSessionIds)) return { status: 'manual-open-required' };
    if (body.runningSessionIds.includes(sessionId)) return { status: 'skipped-running', sessionId };
    const response = await fetchImpl(new URL(`/api/agent/${encodeURIComponent(sessionId)}`, base), {
      method: 'POST', headers, body: JSON.stringify({ type: 'reload', clearExtensionUi: true }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (await response.json()).success === false) return { status: 'manual-open-required' };
    return { status: 'refreshed', sessionId };
  } catch { return { status: 'manual-open-required' }; }
}

export async function boot(options = {}) {
  const lifecycle = await packageLifecycle(options);
  const runtime = options.runtime || await import('./runtime.mjs');
  const runtimeOptions = { loc: webLocations(options), ...(options.env ? { env: options.env } : {}) };
  await runtime.observeLifecycle?.(lifecycle, runtimeOptions);
  if (!lifecycle.active) return { initialization: { phase: 'inactive' }, onboarding: { status: 'inactive' }, startup: { status: 'inactive', reason: lifecycle.reason } };
  let current = await runtime.status(runtimeOptions);
  if (current.phase === 'disabled') return { initialization: { phase: 'disabled' }, onboarding: { status: 'disabled' }, startup: { status: 'disabled' } };
  let initialization;
  try { initialization = current.phase === 'ready' ? { phase: 'ready', checked: true }
    : typeof runtime.prepare === 'function'
    ? await runtime.prepare(runtimeOptions)
    : { phase: 'needs-login', prepared: false }; }
  catch { initialization = { phase: 'error', reason: 'Omnigent initialization needs attention in its setup conversation.' }; }
  let resumption;
  if (initialization.ok !== false && initialization.phase !== 'error' && typeof runtime.resumeAuthorizedHost === 'function') {
    try { resumption = await runtime.resumeAuthorizedHost({ ...runtimeOptions, lifecycle: () => packageLifecycle(options) }); }
    catch { resumption = { ok: false, resumed: false, error: { code: 'RESUME_FAILED' } }; }
  }
  current = await runtime.status(runtimeOptions);
  // A retained server heartbeat and prior model receipt cannot prove that the
  // local host process survived container replacement. Resume verifies it first.
  const ready = current.phase === 'ready' && (!resumption || resumption.resumed === true);
  if (ready) return {
    initialization, ...(resumption ? { resumption } : {}), onboarding: { status: 'ready' }, startup: { status: 'ready' } };
  const onboarding = await ensureOnboarding({ ...options, ready });
  const startup = !ready && onboarding.sessionId
    ? await startOnboardingSession(onboarding.sessionId, options)
    : { status: 'ready' };
  return { initialization, ...(resumption ? { resumption } : {}), onboarding, startup };
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
