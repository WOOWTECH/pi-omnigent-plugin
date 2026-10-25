import { spawn } from 'node:child_process';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Pinned releases are changed deliberately, never resolved through "latest" at runtime.
export const DEPENDENCY_VERSIONS = Object.freeze({
  omnigent: '0.16.0',
  uv: '0.12.10',
});

const VERSION_ENV = Object.freeze({
  omnigent: 'PI_OMNIGENT_VERSION',
  uv: 'PI_OMNIGENT_UV_VERSION',
});
const SIMPLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const VERSION = /(?:^|[^0-9])(\d+\.\d+(?:\.\d+)?[a-z]?)(?=$|[^0-9])/i;
const ENGINE_NAMES = ['claude', 'codex', 'pi'];
const DISCOVERY_NAMES = ['omnigent', 'claude', 'codex', 'pi', 'uv', 'python', 'tmux', 'bwrap', 'node', 'npm'];

function environment(env) {
  return Object.fromEntries(Object.entries(env ?? {}).filter(([, value]) => value !== undefined && value !== null).map(([key, value]) => [key, String(value)]));
}

function defaultStateDir(env, home) {
  const agentDir = env.PI_CODING_AGENT_DIR || env.PI_AGENT_DATA_DIR || path.join(home, '.pi', 'agent');
  return path.join(agentDir, 'omnigent-plugin');
}

function managedPaths(stateDir) {
  return [path.join(stateDir, 'bin'), path.join(stateDir, 'bootstrap', 'bin')];
}

async function executable(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return (await stat(candidate)).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

async function locate(name, env, candidates = []) {
  const directories = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // Resolve only explicit executable paths, never a command through a shell.
  for (const candidate of [...candidates, ...directories.map(directory => path.resolve(directory, name))]) {
    const found = await executable(candidate);
    if (found) return found;
  }
  return null;
}

/** Executes an argv array. Raw output is never included in installation status. */
export async function runCommand(command, args, { env = process.env, cwd, timeoutMs = 600_000 } = {}) {
  return new Promise(resolve => {
    let child;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer;
    let killTimer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ stdout, stderr, ...result });
    };
    try {
      child = spawn(command, args, { env: environment(env), cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ code: null, error: error.code ?? 'SPAWN_FAILED' });
      return;
    }
    child.stdout.on('data', chunk => { if (stdout.length < 65_536) stdout += String(chunk).slice(0, 65_536 - stdout.length); });
    child.stderr.on('data', chunk => { if (stderr.length < 65_536) stderr += String(chunk).slice(0, 65_536 - stderr.length); });
    child.on('error', error => finish({ code: null, error: error.code ?? 'SPAWN_FAILED' }));
    child.on('close', (code, signal) => finish({ code, signal }));
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: null, error: 'TIMEOUT' });
      }, 2_000);
      killTimer.unref();
    }, timeoutMs);
    timer.unref();
  });
}

const probeCaches = new WeakMap();
async function probe(name, command, env, { run, now, cacheMs }) {
  if (!command) return { available: false, path: null };
  // Re-stat the binary on every lookup. Updating/removing an engine invalidates
  // the version immediately; authentication and host status are never cached.
  let identity;
  try {
    const metadata = await stat(command);
    identity = [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join(':');
  } catch { return { available: false, path: null }; }
  let cache = probeCaches.get(run);
  if (!cache) { cache = new Map(); probeCaches.set(run, cache); }
  const key = JSON.stringify([name, command, env.HOME, env.PATH, env.PI_CODING_AGENT_DIR, identity]);
  const previous = cache.get(key);
  if (cacheMs > 0 && previous && (previous.pending || now() < previous.expires)) return { ...await previous.promise };
  const args = name === 'tmux' ? ['-V'] : ['--version'];
  const entry = { pending: true, expires: 0 };
  entry.promise = (async () => {
    try {
      const result = await run(command, args, { env, timeoutMs: 5_000 });
      const version = `${result.stdout} ${result.stderr}`.match(VERSION)?.[1];
      if (result.code !== 0) cache.delete(key);
      return { available: result.code === 0, path: command, ...(version ? { version } : {}) };
    } catch (error) { cache.delete(key); throw error; }
    finally { entry.pending = false; entry.expires = now() + cacheMs; }
  })();
  // Bound a long-running Pi Web process even after repeated engine upgrades.
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
  return { ...await entry.promise };
}

/** Read-only CLI discovery. No login state or account configuration is opened. */
export async function discover(env = process.env, { run = runCommand, now = Date.now, cacheMs = 15_000 } = {}) {
  env = environment(env);
  const home = env.HOME || homedir();
  const stateDir = env.PI_OMNIGENT_STATE_DIR || defaultStateDir(env, home);
  const discoveryEnv = { ...env, PATH: [...managedPaths(stateDir), env.PATH ?? '', path.join(home, '.local', 'bin')].filter(Boolean).join(path.delimiter) };
  const paths = await Promise.all(DISCOVERY_NAMES.map(async name => {
    if (name === 'omnigent') {
      // An explicit override is useful for testing or a custom container image.
      return locate(name, discoveryEnv, env.PI_OMNIGENT_BIN ? [env.PI_OMNIGENT_BIN] : ['/usr/local/bin/omnigent']);
    }
    if (name === 'python') return await locate('python3', discoveryEnv) || await locate('python', discoveryEnv);
    if (name === 'node') return locate(name, discoveryEnv, [process.execPath]);
    return locate(name, discoveryEnv);
  }));
  const entries = await Promise.all(DISCOVERY_NAMES.map((name, index) => probe(name, paths[index], discoveryEnv, { run, now, cacheMs })));
  const result = Object.fromEntries(DISCOVERY_NAMES.map((name, index) => [name, entries[index]]));
  if (result.omnigent.available) {
    try {
      const resolved = await realpath(result.omnigent.path);
      const python = await executable(path.join(path.dirname(resolved), 'python'));
      if (python) result.omnigent.python = python;
    } catch {
      // CLI availability is separate from optional embedded Python discovery.
    }
  }
  return result;
}

/** Build child-process environment without changing process.env or user settings. */
export function runtimeEnv(discovery, env = process.env) {
  const result = environment(env);
  // Discovery deliberately selects the image Omnigent SDK by absolute path.
  // Prepending its directory also used to replace a user's Claude/Codex/Pi
  // with another image version. The adapter's Python and host binary are
  // already explicit; preserve the engine PATH and append missing tool dirs.
  const directories = (result.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of DISCOVERY_NAMES) {
    const entry = discovery?.[name];
    if (entry?.available && entry.path) directories.push(path.dirname(entry.path));
  }
  if (result.PI_OMNIGENT_STATE_DIR) directories.push(...managedPaths(result.PI_OMNIGENT_STATE_DIR));
  result.PATH = [...new Set(directories)].join(path.delimiter);
  if (discovery?.omnigent?.available && discovery.omnigent.python) result.PI_OMNIGENT_PYTHON = discovery.omnigent.python;
  return result;
}

function versionAtLeast(actual, minimum) {
  const left = String(actual ?? '').match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
  const right = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function isManaged(entry, stateDir) {
  if (!entry?.path) return false;
  const relative = path.relative(stateDir, path.resolve(entry.path));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function blankDiscovery() {
  return Object.fromEntries(DISCOVERY_NAMES.map(name => [name, { available: false, path: null }]));
}

/**
 * Install missing Omnigent and its uv bootstrap into this plugin's state directory.
 * Agent engines are discovered as installed; they are never installed or updated.
 * update refreshes managed Omnigent and preserves image/global CLIs.
 * Inject run/discover in tests; neither performs shell interpolation.
 */
export async function installDependencies({ update = false, env = process.env, home, stateDir, run = runCommand, discover: find = discover, platform = process.platform, arch = process.arch, onProgress } = {}) {
  env = environment(env);
  home = path.resolve(home || env.HOME || homedir());
  stateDir = path.resolve(stateDir || env.PI_OMNIGENT_STATE_DIR || defaultStateDir(env, home));
  env = { ...env, HOME: home, PI_OMNIGENT_STATE_DIR: stateDir };
  env.PATH = [...managedPaths(stateDir), env.PATH ?? ''].filter(Boolean).join(path.delimiter);
  const issues = [];
  const installed = [];
  const warnings = [];
  const steps = [];
  let changed = false;
  let discovery = blankDiscovery();
  const report = (dependency, action, status) => {
    const step = { dependency, action, status };
    steps.push(step);
    if (onProgress) onProgress(step);
  };
  const result = () => ({ ...discovery, ok: issues.length === 0, changed, issues, warnings, installed, installedEngines: ENGINE_NAMES.filter(name => discovery[name]?.available), steps });
  if (platform !== 'linux' || !['x64', 'arm64'].includes(arch)) {
    issues.push(`This plugin requires a Linux x64 or arm64 container (received ${platform}/${arch}).`);
    return result();
  }
  const versions = {};
  for (const [name, key] of Object.entries(VERSION_ENV)) {
    versions[name] = env[key] || DEPENDENCY_VERSIONS[name];
    if (!SIMPLE_SEMVER.test(versions[name])) issues.push(`${key} must be an exact version such as ${DEPENDENCY_VERSIONS[name]}.`);
  }
  if (issues.length) return result();
  discovery = { ...blankDiscovery(), ...await find(env) };
  const needs = name => !discovery[name]?.available || (update && isManaged(discovery[name], stateDir));
  const needsOmnigent = needs('omnigent');
  if (needsOmnigent) {
    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
    } catch {
      issues.push('Cannot create the plugin dependency directory; check its ownership and write permissions.');
      return result();
    }
  }
  if (needsOmnigent && !discovery.uv?.available) {
    if (!discovery.python?.available || !versionAtLeast(discovery.python.version, '3.8.0')) {
      issues.push('Omnigent and uv are missing. Python >=3.8 with pip is required to bootstrap uv; add Python/pip or uv to the container image, then retry.');
      report('uv', 'bootstrap', 'blocked');
    } else {
      const bootstrapEnv = { ...runtimeEnv(discovery, env), PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
      let pip;
      try {
        pip = await run(discovery.python.path, ['-m', 'pip', '--version'], { env: bootstrapEnv, cwd: stateDir, timeoutMs: 10_000 });
      } catch {
        pip = { code: null };
      }
      if (pip?.code !== 0) {
        issues.push('Omnigent and uv are missing, and Python pip is unavailable. Add pip or uv to the container image, then retry.');
        report('uv', 'bootstrap', 'blocked');
      } else {
        report('uv', 'bootstrap', 'started');
        let execution;
        try {
          execution = await run(discovery.python.path, ['-m', 'pip', 'install', '--target', path.join(stateDir, 'bootstrap'), '--no-cache-dir', '--disable-pip-version-check', `uv==${versions.uv}`], { env: bootstrapEnv, cwd: stateDir, timeoutMs: 600_000 });
        } catch {
          execution = { code: null };
        }
        if (execution?.code !== 0) {
          issues.push('The managed uv bootstrap failed. Check container network and PyPI access, then retry.');
          report('uv', 'bootstrap', 'failed');
        } else {
          changed = true;
          discovery = { ...blankDiscovery(), ...await find(env) };
          if (discovery.uv?.available) {
            installed.push('uv');
            report('uv', 'bootstrap', 'completed');
          } else {
            issues.push('pip finished, but the managed uv executable is unavailable. Check the plugin bootstrap directory.');
            report('uv', 'bootstrap', 'failed');
          }
        }
      }
    }
  }
  if (needsOmnigent) {
    if (!discovery.uv?.available) {
      report('omnigent', 'install', 'blocked');
    } else {
      const action = discovery.omnigent?.available ? 'update' : 'install';
      const installEnv = {
        ...runtimeEnv(discovery, env),
        UV_CACHE_DIR: path.join(stateDir, 'uv-cache'),
        UV_TOOL_DIR: path.join(stateDir, 'uv', 'tools'),
        UV_TOOL_BIN_DIR: path.join(stateDir, 'bin'),
        UV_PYTHON_INSTALL_DIR: path.join(stateDir, 'python'),
      };
      const args = ['tool', 'install', '--python', '3.12'];
      if (action === 'update') args.push('--force');
      args.push(`omnigent==${versions.omnigent}`);
      report('omnigent', action, 'started');
      let execution;
      try {
        execution = await run(discovery.uv.path, args, { env: installEnv, cwd: stateDir, timeoutMs: 600_000 });
      } catch {
        execution = { code: null };
      }
      if (execution?.code !== 0) {
        issues.push('Omnigent dependency installation failed. Check container network access, uv, and registry access, then retry.');
        report('omnigent', action, 'failed');
      } else {
        changed = true;
        discovery = { ...blankDiscovery(), ...await find(env) };
        if (discovery.omnigent?.available) {
          installed.push('omnigent');
          report('omnigent', action, 'completed');
        } else {
          issues.push('uv finished, but the managed Omnigent executable is unavailable. Check the plugin dependency directory.');
          report('omnigent', action, 'failed');
        }
      }
    }
  }
  if (ENGINE_NAMES.some(name => discovery[name]?.available)) {
    if (!discovery.tmux?.available) issues.push('tmux >=3.3 is required for the installed native engines. Add it to the container image, then retry.');
    else if (!versionAtLeast(discovery.tmux.version, '3.3.0')) issues.push('tmux >=3.3 is required for the installed native engines. Upgrade tmux in the container image, then retry.');
    if (!discovery.bwrap?.available) warnings.push('bubblewrap (bwrap) is unavailable. Sessions configured to use a bubblewrap sandbox need it in the container image with the required namespaces; native sessions can use their existing sandbox configuration.');
  }
  return result();
}
