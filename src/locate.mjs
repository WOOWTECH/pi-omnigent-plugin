import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Which copy of a Pi package does Pi load? A git pin, an image-bundled directory
// and an npm install of the same package are copies of one package, so copies are
// matched by package name, never by the path this code happens to run from.
// Shared by web.mjs and by hosts (Pi Web settings, HA) that import the plugin.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PACKAGE_NAME = '@woowtech/pi-omnigent-plugin';
const REMOTE_SOURCE = /^(?:git|github|https?|ssh):/;

/** Canonical directory of a copy; a symlinked path names the same copy. */
export function canonicalRoot(directory) {
  try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
}

/** The `name` in `<root>/package.json`, or null when it cannot be read. */
export function readPackageName(root) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))?.name;
    return typeof name === 'string' && name ? name : null;
  } catch { return null; }
}

/** Package name of the copy at `root` (default: this running copy). */
export function ownPackageName(root = ROOT) {
  return readPackageName(root) || DEFAULT_PACKAGE_NAME;
}

// A configured source Pi has not installed yet has no package.json to read:
// npm:<name>[@range] names its package, a git source is matched by repository
// name, and a missing local path is nothing Pi can load.
function namesPackage(source, name) {
  if (source.startsWith('npm:')) return source.slice(4).trim().match(/^(@?[^@]+(?:\/[^@]+)?)/)?.[1] === name;
  if (!REMOTE_SOURCE.test(source)) return false;
  const repository = source.replace(/#.*$/, '').replace(/@[^/@:]*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  return repository.split(/[/:]/).pop().toLowerCase() === name.split('/').pop().toLowerCase();
}

/**
 * List every configured copy of a package and the one Pi loads.
 *
 * `sdk` is the Pi SDK module (SettingsManager, DefaultPackageManager). Copies keep
 * Pi's settings order; a copy is `{ source, scope, root, enabled }`, where `root`
 * is the canonical install directory or null while Pi has yet to install it.
 * The loaded copy is the last installed copy that is enabled, else the last
 * installed copy (every copy disabled), else the last copy awaiting install.
 * `readable` is false when Pi reports a settings error; nothing is listed then.
 */
export function locatePackage({ sdk, cwd, agentDir, name = ownPackageName() }) {
  const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const manager = new sdk.DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const configured = manager.listConfiguredPackages();
  if (settings.drainErrors?.().length) return { name, readable: false, copies: [], loaded: null };
  const copies = [];
  for (const entry of configured) {
    if (typeof entry?.source !== 'string') continue;
    const root = entry.installedPath ? canonicalRoot(entry.installedPath) : null;
    if (!(root ? readPackageName(root) === name : namesPackage(entry.source, name))) continue;
    // Pi loads an install location once; a repeated entry adds no copy.
    if (root && copies.some(copy => copy.root === root)) continue;
    const values = (entry.scope === 'project' ? settings.getProjectSettings() : settings.getGlobalSettings()).packages || [];
    const value = values.find(item => (typeof item === 'string' ? item : item?.source) === entry.source);
    const enabled = !(value && typeof value === 'object' && Array.isArray(value.extensions) && value.extensions.length === 0);
    copies.push({ source: entry.source, scope: entry.scope, root, enabled });
  }
  const installed = copies.filter(copy => copy.root);
  const loaded = installed.filter(copy => copy.enabled).at(-1) ?? installed.at(-1) ?? copies.at(-1) ?? null;
  return { name, readable: true, copies, loaded };
}
