// Read-only cross-repository verification for a checkout or unpacked package.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PI_WEB_BASE, PI_WEB_REPOSITORY, PI_WEB_VERSION } from './install-ui.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sameBase = (left, right) => ['schemaVersion', 'repository', 'baseCommit', 'piWebVersion']
  .every(key => left[key] === right[key]);
function requireMatch(condition, reason) {
  if (!condition) throw Object.assign(new Error(`Combined adapter mismatch: ${reason}`), { code: 'COMBINED_ADAPTER_MISMATCH' });
}

export function verifyCombined(paseoRoot, packageRoot = ROOT) {
  const integration = path.join(packageRoot, 'integrations/pi-web');
  const combined = read(path.join(integration, 'combined.adapter-meta.json'));
  const own = read(path.join(packageRoot, 'package.json'));
  const ownMeta = read(path.join(integration, 'adapter-meta.json'));
  const paseo = read(path.join(paseoRoot, 'package.json'));
  const paseoMeta = read(path.join(paseoRoot, 'host/adapter-meta.json'));
  const paseoSha = sha(path.join(paseoRoot, 'host/adapter.patch'));
  const ownSha = sha(path.join(integration, 'adapter.patch'));
  const combinedSha = sha(path.join(integration, 'combined.adapter.patch'));
  const candidates = [combined.paseo, ...(combined.paseo.compatibleAdapters ?? [])];
  const compatible = candidates.some(candidate =>
    [candidate.packageVersion, ...(candidate.compatiblePackageVersions ?? [])].includes(paseo.version) &&
    candidate.adapterPatchSha256 === paseoSha);
  requireMatch(combined.schemaVersion === 1 && combined.repository === PI_WEB_REPOSITORY && combined.baseCommit === PI_WEB_BASE && combined.piWebVersion === PI_WEB_VERSION, 'pinned Pi Web base');
  requireMatch(sameBase(combined, ownMeta) && sameBase(combined, paseoMeta), 'Pi Web base');
  requireMatch(combined.patchSha256 === combinedSha, 'combined patch digest');
  requireMatch(ownMeta.patchSha256 === ownSha && combined.omnigent.adapterPatchSha256 === ownSha, 'Omnigent patch digest');
  requireMatch(paseoMeta.patchSha256 === paseoSha && compatible, 'Agent Connect version or patch digest');
  requireMatch(paseo.name === '@woowtech/pi-paseo' && combined.paseo.packageName === paseo.name, 'Agent Connect package name');
  requireMatch(combined.omnigent.packageName === own.name && combined.omnigent.packageVersion === own.version, 'Omnigent package version');
  requireMatch(JSON.stringify(combined.settingsSections) === JSON.stringify(['mcp', 'omnigent', 'paseo']), 'settings sections');
  requireMatch(JSON.stringify(combined.contributors) === JSON.stringify(['@woowtech/pi-paseo', '@woowtech/pi-omnigent-plugin']), 'contributors');
  return { passed: true, paseoVersion: paseo.version, omnigentVersion: own.version,
    baseCommit: combined.baseCommit, paseoAdapterSha256: paseoSha, combinedAdapterSha256: combinedSha };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paseoRoot = process.argv[2];
  if (!paseoRoot) {
    console.error('Usage: node bin/verify-combined.mjs PASEO_SOURCE_OR_UNPACKED_PACKAGE');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(verifyCombined(path.resolve(paseoRoot)), null, 2)); }
    catch (error) { console.error(`${error.code ?? 'VERIFICATION_FAILED'}: ${error.message}`); process.exitCode = 1; }
  }
}
