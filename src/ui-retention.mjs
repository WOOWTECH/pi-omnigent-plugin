import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const NAME = /^[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const RECEIPT = '.pi-omnigent-web-install.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

// Only inspect installer-owned receipts/artifacts. Never resolve a link while
// proving ownership, and never enumerate directories outside pi-web-releases.
function regularFile(root, relative) {
  let current = root;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error('unsafe artifact');
  }
  return fs.readFileSync(current);
}
function managed(releases, name) {
  if (!NAME.test(name)) return null;
  const dir = path.join(releases, name);
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return null;
    const receipt = JSON.parse(regularFile(dir, RECEIPT));
    if (receipt.schemaVersion !== 1 || receipt.key !== name.slice(0, 64) ||
        receipt.repository !== 'https://github.com/agegr/pi-web' ||
        receipt.baseCommit !== '6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068' || receipt.piWebVersion !== '0.10.0' ||
        !HASH.test(receipt.patchSha256) || !HASH.test(receipt.binSha256) || !HASH.test(receipt.lockSha256) ||
        !Number.isFinite(Date.parse(receipt.installedAt)) ||
        (receipt.activation !== undefined && receipt.activation !== 'complete')) return null;
    const pkg = JSON.parse(regularFile(dir, 'package.json'));
    if (pkg.name !== '@agegr/pi-web' || pkg.version !== receipt.piWebVersion || pkg.bin?.['pi-web'] !== 'bin/pi-web.js' ||
        sha(regularFile(dir, 'bin/pi-web.js')) !== receipt.binSha256 ||
        sha(regularFile(dir, 'package-lock.json')) !== receipt.lockSha256 ||
        regularFile(dir, '.next/BUILD_ID').toString().trim() !== receipt.buildId || !receipt.buildId) return null;
    regularFile(dir, 'node_modules/next/dist/bin/next');
    const time = Date.parse(receipt.activatedAt ?? receipt.installedAt);
    return Number.isFinite(time) ? { name, dir, time, stat } : null;
  } catch { return null; }
}
function activeRelease(root, releases) {
  const destination = path.join(root, 'pi-web');
  if (!fs.lstatSync(destination).isSymbolicLink()) throw new Error('unmanaged active');
  const dir = path.resolve(root, fs.readlinkSync(destination));
  if (path.dirname(dir) !== releases) throw new Error('escaped active');
  const active = managed(releases, path.basename(dir));
  const host = JSON.parse(regularFile(root, 'host-install.json'));
  if (!active || host.releaseRoot !== dir || host.adapterRoot !== destination ||
      !['installed', 'already-installed'].includes(host.status) ||
      !['shared-runtime', 'omnigent', 'user-wrapper'].includes(host.routing?.status)) throw new Error('activation unconfirmed');
  return { ...active, recovery: typeof host.routing.previousNative === 'string' && path.isAbsolute(host.routing.previousNative)
    ? path.resolve(host.routing.previousNative) : null };
}
function runningDirectories() {
  // Next runs with cwd=pkgDir. Reading cwd avoids reading argv, environment or
  // conversation data. If visibility is restricted, decline cleanup entirely.
  if (process.platform !== 'linux') throw new Error('runtime visibility unavailable');
  const dirs = [];
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    try { dirs.push(fs.readlinkSync(`/proc/${pid}/cwd`)); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return dirs;
}
function treeBytes(dir, device) {
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) return 0; // rm unlinks these; the target is never visited.
  if (stat.dev !== device) throw new Error('mounted subtree');
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error('non-build entry');
  return fs.readdirSync(dir).reduce((bytes, name) => bytes + treeBytes(path.join(dir, name), device), 0);
}

/** Caller holds the installer's host lock and has validated the fixed root. */
export function retainManagedBuilds(root, { dryRun = true } = {}) {
  const releases = path.join(root, 'pi-web-releases');
  const result = { schemaVersion: 1, checkedAt: new Date().toISOString(), dryRun, status: 'complete',
    rollbackBuilds: 2, maxRemovals: 4, preserved: [], candidates: [], removed: [],
    skippedEntries: 0, deferred: 0, reclaimableBytes: 0, reclaimedBytes: 0 };
  let active, running;
  try {
    if (fs.realpathSync(releases) !== releases) throw new Error('linked storage');
    active = activeRelease(root, releases);
  }
  catch { return { ...result, status: 'skipped', code: 'ACTIVATION_UNCONFIRMED' }; }
  try { running = runningDirectories(); }
  catch { return { ...result, status: 'skipped', code: 'RUNTIME_VISIBILITY_UNAVAILABLE' }; }
  result.active = active.name;
  const builds = [];
  for (const name of fs.readdirSync(releases)) {
    const build = managed(releases, name);
    if (build) builds.push(build); else result.skippedEntries++;
  }
  const prior = builds.filter(build => build.name !== active.name && build.time <= active.time)
    .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
  const rollback = new Set(prior.slice(0, 2).map(build => build.name));
  const eligible = [];
  for (const build of builds) {
    const reason = build.name === active.name ? 'active' : rollback.has(build.name) ? 'rollback' :
      build.time > active.time ? 'newer-than-active' : active.recovery && inside(build.dir, active.recovery) ? 'routing-fallback' :
      running.some(dir => inside(build.dir, dir)) ? 'running' : null;
    if (reason) { result.preserved.push({ release: build.name, reason }); continue; }
    eligible.push(build);
  }
  eligible.sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));
  result.deferred = Math.max(0, eligible.length - result.maxRemovals);
  for (const build of eligible.slice(0, result.maxRemovals)) {
    // Size walks are bounded too: never scan every older node_modules tree.
    try { build.bytes = treeBytes(build.dir, build.stat.dev); }
    catch { result.skippedEntries++; continue; }
    const item = { release: build.name, bytes: build.bytes };
    result.candidates.push(item);
    result.reclaimableBytes += build.bytes;
    if (dryRun) continue;
    // Recheck the active transaction and runtime immediately before each rm.
    try {
      if (fs.realpathSync(releases) !== releases || activeRelease(root, releases).name !== active.name ||
          runningDirectories().some(dir => inside(build.dir, dir))) throw new Error('state changed');
      const current = managed(releases, build.name);
      if (!current || current.stat.dev !== build.stat.dev || current.stat.ino !== build.stat.ino ||
          treeBytes(build.dir, build.stat.dev) !== build.bytes) throw new Error('build changed');
      fs.rmSync(build.dir, { recursive: true });
      result.removed.push(item);
      result.reclaimedBytes += build.bytes;
    } catch {
      result.status = 'partial'; result.code = 'RETENTION_CHANGED_OR_FAILED'; break;
    }
  }
  return result;
}
