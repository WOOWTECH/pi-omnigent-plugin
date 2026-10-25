#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const PI_WEB_REPOSITORY = 'https://github.com/agegr/pi-web';
export const PI_WEB_BASE = '6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068';
export const PI_WEB_VERSION = '0.10.0';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '// pi-omnigent-web managed web launcher';
const sha = value => createHash('sha256').update(value).digest('hex');

export class UiInstallError extends Error {
  constructor(code) { super(code); this.name = 'UiInstallError'; this.code = code; }
}
const fail = code => { throw new UiInstallError(code); };
function exists(file) { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function executable(file) { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } }
function within(parent, child) { const rel = path.relative(parent, child); return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); }
function safeDirectory(dir, home) {
  if (!within(home, dir)) fail('HOME_PATH_REQUIRED');
  const relative = path.relative(home, dir).split(path.sep);
  let current = home;
  for (const part of relative) {
    current = path.join(current, part);
    if (exists(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_INSTALL_PATH');
    } else fs.mkdirSync(current, { mode: 0o700 });
  }
  fs.accessSync(dir, fs.constants.W_OK);
}
function atomic(file, value, mode = 0o600, expected) {
  if (exists(file) && fs.lstatSync(file).isSymbolicLink()) fail('UNSAFE_METADATA_PATH');
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', mode);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (expected !== undefined && (!exists(file) || fs.readFileSync(file, 'utf8') !== expected)) fail('ROUTING_CHANGED_RETRY');
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
function json(file, value) { atomic(file, JSON.stringify(value, null, 2) + '\n'); }

// Child output is deliberately drained without being logged: npm/git can echo
// credentials from external configuration or lifecycle scripts on failure.
export function runCommand(command, args, { cwd, env, timeoutMs = 900000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '', oversized = false, timedOut = false;
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length <= 4 * 1024 * 1024) output += chunk.toString();
      else oversized = true;
    });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new UiInstallError('COMMAND_UNAVAILABLE')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || oversized || code !== 0) reject(new UiInstallError(timedOut ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED'));
      else resolve(output.trim());
    });
  });
}
function identity(pid) {
  try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; }
}
async function locked(root, fn, timeoutMs) {
  const file = path.join(root, '.install-host.lock');
  const token = randomUUID(), deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: identity(process.pid), token })); } finally { fs.closeSync(fd); }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (fs.lstatSync(file).isSymbolicLink()) fail('UNSAFE_INSTALL_PATH');
      let owner, original;
      try { original = fs.readFileSync(file, 'utf8'); owner = JSON.parse(original); } catch {}
      let live = false;
      if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); live = !owner.identity || !identity(owner.pid) || owner.identity === identity(owner.pid); }
        catch (e) { live = e.code !== 'ESRCH'; }
      }
      const old = Date.now() - fs.statSync(file).mtimeMs > 30000;
      if (!live && old && fs.readFileSync(file, 'utf8') === original) { fs.unlinkSync(file); continue; }
      if (Date.now() >= deadline) fail('HOST_INSTALL_BUSY');
      await delay(100);
    }
  }
  try { return await fn(); }
  finally { try { if (readJson(file).token === token) fs.unlinkSync(file); } catch {} }
}
export function readAdapter(packageRoot = ROOT) {
  const metaFile = path.join(packageRoot, 'integrations/pi-web/adapter-meta.json');
  const patchFile = path.join(packageRoot, 'integrations/pi-web/adapter.patch');
  if (!exists(metaFile) || !exists(patchFile)) fail('ADAPTER_FILES_MISSING');
  let meta;
  try { meta = readJson(metaFile); } catch { fail('ADAPTER_METADATA_INVALID'); }
  const patch = fs.readFileSync(patchFile);
  if (meta.schemaVersion !== 1 || meta.repository?.replace(/\.git$/, '').replace(/\/$/, '') !== PI_WEB_REPOSITORY ||
      meta.baseCommit !== PI_WEB_BASE || meta.piWebVersion !== PI_WEB_VERSION ||
      !/^[a-f0-9]{64}$/.test(meta.patchSha256 || '') || sha(patch) !== meta.patchSha256 || patch.length === 0) fail('ADAPTER_METADATA_MISMATCH');
  return { ...meta, patchFile, patchSha256: sha(patch) };
}
function verifyPackage(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg.name !== '@agegr/pi-web' || pkg.version !== PI_WEB_VERSION || pkg.bin?.['pi-web'] !== 'bin/pi-web.js') fail('PI_WEB_VERSION_MISMATCH');
  return path.join(dir, 'bin/pi-web.js');
}
function verifyBuild(dir) {
  verifyPackage(dir);
  if (!fs.readFileSync(path.join(dir, '.next/BUILD_ID'), 'utf8').trim() ||
      !fs.statSync(path.join(dir, 'node_modules/next/dist/bin/next')).isFile()) fail('BUILD_ARTIFACTS_MISSING');
}
function cached(dir, meta, key) {
  try {
    const receipt = readJson(path.join(dir, '.pi-omnigent-web-install.json'));
    verifyBuild(dir);
    return receipt.key === key && receipt.baseCommit === meta.baseCommit && receipt.patchSha256 === meta.patchSha256 &&
      receipt.binSha256 === sha(fs.readFileSync(path.join(dir, 'bin/pi-web.js'))) &&
      receipt.lockSha256 === sha(fs.readFileSync(path.join(dir, 'package-lock.json'))) &&
      receipt.buildId === fs.readFileSync(path.join(dir, '.next/BUILD_ID'), 'utf8').trim();
  } catch { return false; }
}
async function copyPrebuilt(source, stage, run, env, meta) {
  verifyBuild(source);
  if (await run('git', ['rev-parse', 'HEAD'], { cwd: source, env }) !== PI_WEB_BASE) fail('PREBUILT_BASE_MISMATCH');
  for (const patchFile of [...meta.patchFiles].reverse()) await run('git', ['apply', '--reverse', '--check', patchFile], { cwd: source, env });
  // Compare every tracked/new source file, including the lockfile, against the
  // freshly patched checkout. Reusing arbitrary .next directories is rejected.
  const files = (await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: stage, env })).split('\0').filter(Boolean).sort();
  const actual = (await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: source, env })).split('\0').filter(Boolean).sort();
  const present = files.filter(file => exists(path.join(stage, file)));
  if (JSON.stringify(present) !== JSON.stringify(actual.filter(file => exists(path.join(source, file))))) fail('PREBUILT_SOURCE_MISMATCH');
  for (const file of present) {
    const left = path.join(stage, file), right = path.join(source, file);
    if (fs.lstatSync(left).isSymbolicLink()) {
      if (!fs.lstatSync(right).isSymbolicLink() || fs.readlinkSync(left) !== fs.readlinkSync(right)) fail('PREBUILT_SOURCE_MISMATCH');
    } else if (!fs.lstatSync(right).isFile() || sha(fs.readFileSync(left)) !== sha(fs.readFileSync(right))) fail('PREBUILT_SOURCE_MISMATCH');
  }
  for (const directory of ['node_modules', '.next']) fs.cpSync(path.join(source, directory), path.join(stage, directory), {
    recursive: true, dereference: false, verbatimSymlinks: true,
    filter: file => !file.startsWith(path.join(source, '.next/cache') + path.sep) && file !== path.join(source, '.next/cache'),
  });
  verifyBuild(stage);
}
function findNative(home, root, env, explicit) {
  const shim = path.join(home, '.local/bin/pi-web');
  const candidates = explicit ? [explicit] : (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, 'pi-web'));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || candidate === shim || within(root, candidate) || !executable(candidate)) continue;
    const real = fs.realpathSync(candidate);
    if (real === shim || within(root, real)) continue;
    return candidate;
  }
  return null;
}
function wrapper(nativeBin, fallback) {
  return `#!/usr/bin/env node\n${MARKER}\nimport fs from 'node:fs';\nimport {spawn} from 'node:child_process';\nconst adapter=${JSON.stringify(nativeBin)};\nconst fallback=${JSON.stringify(fallback)};\nconst ready=fs.existsSync(adapter)&&fs.existsSync(${JSON.stringify(path.resolve(nativeBin, '../../.next/BUILD_ID'))});\nconst child=ready?spawn(${JSON.stringify(process.execPath)},[adapter,...process.argv.slice(2)],{stdio:'inherit',env:process.env}):spawn(fallback,process.argv.slice(2),{stdio:'inherit',env:process.env});\nfor(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));\nchild.on('error',()=>{process.stderr.write('Omnigent UI web launcher failed.\\n');process.exitCode=1;});\nchild.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});\n`;
}
function installRouting({ home, root, nativeBin, env, sharedHostPath, omnigentHostPath, nativeLauncher }) {
  const shim = path.join(home, '.local/bin/pi-web');
  let metadata = sharedHostPath && exists(sharedHostPath) ? sharedHostPath : null;
  let routingStatus = 'shared-runtime';
  if (!metadata && omnigentHostPath && exists(omnigentHostPath) && exists(shim)) {
    const launcher = fs.readFileSync(shim, 'utf8');
    if (launcher.includes('// pi-omnigent-plugin web launcher')) {
      if (fs.lstatSync(omnigentHostPath).isSymbolicLink()) fail('UNSAFE_METADATA_PATH');
      const config = readJson(omnigentHostPath);
      if (config.version === 1 && config.mode === 'path-wrapper' && config.shim === shim) {
        metadata = omnigentHostPath;
        routingStatus = 'omnigent';
      }
    }
  }
  if (metadata) {
    if (fs.lstatSync(metadata).isSymbolicLink()) fail('UNSAFE_METADATA_PATH');
    const original = fs.readFileSync(metadata, 'utf8');
    const config = JSON.parse(original);
    if (typeof config.realWeb !== 'string' || !path.isAbsolute(config.realWeb)) fail('SHARED_ROUTING_INVALID');
    if (config.realWeb !== nativeBin) {
      if (!Object.hasOwn(config, 'realWebBeforeOmnigentUi')) config.realWebBeforeOmnigentUi = config.realWeb;
      config.realWeb = nativeBin;
      atomic(metadata, JSON.stringify(config, null, 2) + '\n', fs.statSync(metadata).mode & 0o777, original);
    }
    return { status: routingStatus, launcher: config.shim || shim, metadata, previousNative: config.realWebBeforeOmnigentUi || null };
  }
  const routingFile = path.join(root, 'host-routing.json');
  let record;
  if (exists(routingFile)) record = readJson(routingFile);
  const current = exists(shim) ? fs.readFileSync(shim, 'utf8') : null;
  if (current !== null && (!record || sha(current) !== record.wrapperSha256 || !current.includes(MARKER))) {
    return { status: 'manual-routing-required', launcher: shim, reason: 'Existing launcher preserved; chain it to pendingRestart explicitly.' };
  }
  const fallback = record?.previousNative || findNative(home, root, env, nativeLauncher || env.PI_OMNIGENT_UI_NATIVE_WEB);
  if (!fallback || !executable(fallback)) fail('NATIVE_PI_WEB_UNAVAILABLE');
  safeDirectory(path.dirname(shim), home);
  const source = wrapper(nativeBin, fallback);
  if (current !== source) atomic(shim, source, 0o755, current ?? undefined);
  json(routingFile, { schemaVersion: 1, launcher: shim, previousNative: fallback, wrapperSha256: sha(source) });
  return { status: 'user-wrapper', launcher: shim, previousNative: fallback };
}

/** Prepare a persistent host adapter and next-start routing; never restart Pi Web. */
export async function installUi(options = {}) {
  const env = { ...process.env, ...options.env };
  const home = fs.realpathSync(path.resolve(options.home || env.HOME || os.homedir()));
  if (process.platform === 'win32') fail('POSIX_HOST_REQUIRED');
  const node = process.versions.node.split('.').map(Number);
  if (node[0] < 22 || (node[0] === 22 && (node[1] < 19 || (node[1] === 19 && node[2] < 0)))) fail('NODE_VERSION_UNSUPPORTED');
  const root = path.join(home, '.local/share/pi-omnigent-web');
  const releases = path.join(root, 'pi-web-releases');
  const destination = path.join(root, 'pi-web');
  const meta = readAdapter(path.resolve(options.packageRoot || ROOT));
  meta.ownPatchSha256 = meta.patchSha256;
  safeDirectory(releases, home);
  const run = options.run || runCommand;
  const sharedHostPath = options.sharedHostPath ?? env.PI_OMNIGENT_UI_SHARED_HOST_METADATA ?? path.join(
    env.PI_CODING_AGENT_DIR || env.PI_AGENT_DATA_DIR || (home.startsWith('/data/pi-agent/') ? '/data/pi-agent' : path.join(home, '.pi/agent')), 'shared-runtime/host.json');
  const omnigentHostPath = options.omnigentHostPath ?? path.join(
    env.PI_CODING_AGENT_DIR || env.PI_AGENT_DATA_DIR || (home.startsWith('/data/pi-agent/') ? '/data/pi-agent' : path.join(home, '.pi/agent')), 'omnigent-plugin/host.json');
  const patchFiles = [meta.patchFile];
  const agentDir = env.PI_CODING_AGENT_DIR || env.PI_AGENT_DATA_DIR || path.join(home, '.pi/agent');
  const overlayRoot = options.overlayPackageRoot ?? env.PI_PASEO_PLUGIN_ROOT ?? path.join(agentDir, 'git/github.com/WOOWTECH/pi-paseo-plugin');
  const overlayMeta = path.join(overlayRoot, 'host/adapter-meta.json');
  let overlayHash = null;
  if (exists(overlayMeta)) {
    const overlay = readJson(overlayMeta), file = path.join(overlayRoot, 'host/adapter.patch');
    if (overlay.schemaVersion !== 1 || overlay.repository?.replace(/\.git$/, '').replace(/\/$/, '') !== PI_WEB_REPOSITORY || overlay.baseCommit !== PI_WEB_BASE || overlay.piWebVersion !== PI_WEB_VERSION || !exists(file) || sha(fs.readFileSync(file)) !== overlay.patchSha256) fail('EXISTING_UI_OVERLAY_MISMATCH');
    overlayHash = overlay.patchSha256;
    const ownPackage = readJson(path.join(path.resolve(options.packageRoot || ROOT), 'package.json'));
    const paseoPackageFile = path.join(overlayRoot, 'package.json');
    const paseoPackage = exists(paseoPackageFile) ? readJson(paseoPackageFile) : null;
    if (paseoPackage && paseoPackage.name !== '@woowtech/pi-paseo') fail('EXISTING_UI_OVERLAY_MISMATCH');
    const combinedManifestFile = path.join(path.resolve(options.packageRoot || ROOT), 'integrations/pi-web/combined.adapter-meta.json');
    const combinedPatchFile = path.join(path.resolve(options.packageRoot || ROOT), 'integrations/pi-web/combined.adapter.patch');
    if (exists(combinedManifestFile) || exists(combinedPatchFile)) {
      if (!paseoPackage || !exists(combinedManifestFile) || !exists(combinedPatchFile)) fail('COMBINED_ADAPTER_MISMATCH');
      const combined = readJson(combinedManifestFile);
      const combinedPatchHash = sha(fs.readFileSync(combinedPatchFile));
      if (combined.schemaVersion !== 1 || combined.repository?.replace(/\.git$/, '').replace(/\/$/, '') !== PI_WEB_REPOSITORY ||
          combined.baseCommit !== PI_WEB_BASE || combined.piWebVersion !== PI_WEB_VERSION ||
          combined.paseo?.packageName !== paseoPackage.name || combined.paseo.packageVersion !== paseoPackage.version || combined.paseo.adapterPatchSha256 !== overlayHash ||
          combined.omnigent?.packageName !== ownPackage.name || combined.omnigent.packageVersion !== ownPackage.version || combined.omnigent.adapterPatchSha256 !== meta.ownPatchSha256 ||
          combined.patchSha256 !== combinedPatchHash ||
          JSON.stringify(combined.contributors) !== JSON.stringify(['@woowtech/pi-paseo', '@woowtech/pi-omnigent-plugin']) ||
          JSON.stringify(combined.settingsSections) !== JSON.stringify(['mcp', 'omnigent', 'paseo'])) fail('COMBINED_ADAPTER_MISMATCH');
      patchFiles.splice(0, patchFiles.length, combinedPatchFile);
      meta.patchSha256 = sha(JSON.stringify({ manifest: combined, patchSha256: combinedPatchHash }));
      meta.composition = 'omnigent+paseo';
      meta.contributors = combined.contributors;
      meta.settingsSections = combined.settingsSections;
    } else {
      patchFiles.unshift(file);
      meta.patchSha256 = sha(JSON.stringify([meta.patchSha256, overlayHash]));
      meta.composition = 'legacy-omnigent+paseo';
      meta.contributors = [paseoPackage?.name ?? '@woowtech/pi-paseo', ownPackage.name];
    }
  }
  meta.patchFiles = patchFiles;
  if (!overlayHash) {
    meta.composition = 'omnigent';
    meta.contributors = ['@woowtech/pi-omnigent-plugin'];
    meta.settingsSections = ['mcp', 'omnigent'];
  }
  const key = sha(JSON.stringify([PI_WEB_BASE, meta.patchSha256, process.version, process.platform, process.arch]));
  return locked(root, async () => {
    let active = null;
    if (exists(destination)) {
      if (!fs.lstatSync(destination).isSymbolicLink()) fail('UNMANAGED_ADAPTER_PATH');
      active = path.resolve(root, fs.readlinkSync(destination));
      if (!within(releases, active) || !exists(path.join(active, '.pi-omnigent-web-install.json'))) fail('UNMANAGED_ADAPTER_PATH');
    }
    let reused = active !== null && cached(active, meta, key);
    if (reused && await run('git', ['rev-parse', 'HEAD'], { cwd: active, env }) !== PI_WEB_BASE) reused = false;
    let release = active;
    if (!reused) {
      const stage = fs.mkdtempSync(path.join(releases, '.build-'));
      try {
        if (options.prebuiltRoot) {
          const prebuilt = fs.realpathSync(path.resolve(options.prebuiltRoot));
          await run('git', ['clone', '--no-hardlinks', '--no-checkout', '--', prebuilt, stage], { env });
          await run('git', ['remote', 'set-url', 'origin', PI_WEB_REPOSITORY], { cwd: stage, env });
        } else {
          await run('git', ['init', '--quiet'], { cwd: stage, env });
          await run('git', ['remote', 'add', 'origin', PI_WEB_REPOSITORY], { cwd: stage, env });
          await run('git', ['fetch', '--quiet', '--depth=1', 'origin', PI_WEB_BASE], { cwd: stage, env });
        }
        await run('git', ['checkout', '--quiet', '--detach', PI_WEB_BASE], { cwd: stage, env });
        if (await run('git', ['rev-parse', 'HEAD'], { cwd: stage, env }) !== PI_WEB_BASE) fail('PI_WEB_BASE_MISMATCH');
        verifyPackage(stage);
        for (const patchFile of meta.patchFiles) {
          await run('git', ['apply', '--check', patchFile], { cwd: stage, env });
          await run('git', ['apply', patchFile], { cwd: stage, env });
        }
        verifyPackage(stage);
        if (options.prebuiltRoot) await copyPrebuilt(fs.realpathSync(path.resolve(options.prebuiltRoot)), stage, run, env, meta);
        else {
          // Container images may point npm at a root-owned /tmp cache. Keep
          // build downloads in a private, writable directory under this home.
          const npmCache = path.join(root, 'npm-cache');
          safeDirectory(npmCache, home);
          // Next's default counts host CPUs, which can exceed container quotas.
          const buildEnv = { ...env, HOME: home, CI: '1', CIRCLE_NODE_TOTAL: '3', NEXT_TELEMETRY_DISABLED: '1', PI_OMNIGENT_UI_SKIP_POSTINSTALL: '1', npm_config_production: 'false', NPM_CONFIG_PRODUCTION: 'false', npm_config_cache: npmCache, NPM_CONFIG_CACHE: npmCache };
          await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: stage, env: { ...buildEnv, NODE_ENV: 'development' } });
          await run('npm', ['run', 'build'], { cwd: stage, env: { ...buildEnv, NODE_ENV: 'production' } });
        }
        verifyBuild(stage);
        fs.chmodSync(path.join(stage, 'bin/pi-web.js'), 0o755);
        json(path.join(stage, '.pi-omnigent-web-install.json'), { schemaVersion: 1, key, repository: PI_WEB_REPOSITORY, baseCommit: PI_WEB_BASE, piWebVersion: PI_WEB_VERSION,
          patchSha256: meta.patchSha256, composition: meta.composition, contributors: meta.contributors, settingsSections: meta.settingsSections,
          binSha256: sha(fs.readFileSync(path.join(stage, 'bin/pi-web.js'))), lockSha256: sha(fs.readFileSync(path.join(stage, 'package-lock.json'))),
          buildId: fs.readFileSync(path.join(stage, '.next/BUILD_ID'), 'utf8').trim(), prebuilt: !!options.prebuiltRoot, installedAt: new Date().toISOString() });
        release = path.join(releases, `${key}-${randomUUID()}`);
        fs.renameSync(stage, release);
        const tempLink = path.join(root, `.pi-web-${randomUUID()}`);
        try { fs.symlinkSync(path.relative(root, release), tempLink, 'dir'); fs.renameSync(tempLink, destination); }
        finally { fs.rmSync(tempLink, { force: true }); }
      } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
    }
    const nativeBin = path.join(destination, 'bin/pi-web.js');
    const routing = installRouting({ home, root, nativeBin, env, sharedHostPath, omnigentHostPath, nativeLauncher: options.nativeLauncher });
    const firstLauncher = (env.PATH || '').split(path.delimiter).filter(Boolean)
      .map(dir => path.resolve(dir, 'pi-web')).find(executable);
    const result = { status: reused ? 'already-installed' : 'installed', adapterRoot: destination, releaseRoot: release, baseCommit: PI_WEB_BASE, piWebVersion: PI_WEB_VERSION,
      patchSha256: meta.patchSha256, composition: meta.composition, contributors: meta.contributors, settingsSections: meta.settingsSections, reused, routing, pendingRestart: nativeBin, restartRequired: true, restarted: false,
      launcherDirectory: path.dirname(routing.launcher), pathUpdateRequired: firstLauncher !== routing.launcher };
    json(path.join(root, 'host-install.json'), result);
    return result;
  }, options.lockTimeoutMs ?? 900000);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const index = args.indexOf('--prebuilt-root');
    if (args.some((arg, i) => arg !== '--prebuilt-root' && i !== index + 1) || (index >= 0 && !args[index + 1])) fail('INVALID_ARGUMENTS');
    console.log(JSON.stringify(await installUi(index < 0 ? {} : { prebuiltRoot: args[index + 1] }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: 'UiInstallError', code: error instanceof UiInstallError ? error.code : 'HOST_INSTALL_FAILED' }));
    process.exitCode = 1;
  }
}
