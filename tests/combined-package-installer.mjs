// Real installer acceptance: an actual packed Paseo plugin and compiled Pi Web.
// Run after the combined-ui build; no npm/build/daemon/model command is invoked here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { installUi, PI_WEB_BASE } from '../bin/install-ui.mjs';

const [prebuiltArg, paseoArg, outputArg] = process.argv.slice(2);
assert.ok(prebuiltArg && paseoArg && outputArg, 'usage: node tests/combined-package-installer.mjs PREBUILT PASEO_PACKAGE OUTPUT');
const prebuiltRoot = fs.realpathSync(prebuiltArg);
const paseoRoot = fs.realpathSync(paseoArg);
const packageRoot = path.resolve(import.meta.dirname, '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function treeHash(root) {
  const entries = [];
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else {
        assert.ok(stat.isFile(), 'acceptance requires a regular packed package');
        entries.push([path.relative(root, file), sha(fs.readFileSync(file))]);
      }
    }
  }
  visit(root);
  return sha(JSON.stringify(entries));
}
const paseo = json(path.join(paseoRoot, 'package.json'));
assert.equal(paseo.name, '@woowtech/pi-paseo');
assert.ok(['0.1.9', '0.1.10'].includes(paseo.version));
const originalHash = treeHash(paseoRoot);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-combined-package-'));
const home = path.join(temporary, 'home');
const overlay = path.join(temporary, 'paseo');
fs.mkdirSync(home);
fs.cpSync(paseoRoot, overlay, { recursive: true });
const env = {
  PATH: process.env.PATH, HOME: home,
  PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_AGENT_DATA_DIR: path.join(home, 'agent'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const options = {
  home, env, packageRoot, overlayPackageRoot: overlay, prebuiltRoot,
  sharedHostPath: path.join(home, 'absent/shared.json'),
  omnigentHostPath: path.join(home, 'absent/omnigent.json'),
  nativeLauncher: path.join(prebuiltRoot, 'bin/pi-web.js'),
};
let result;
try {
  const installed = await installUi(options);
  assert.equal(installed.status, 'installed');
  assert.equal(installed.composition, 'omnigent+paseo');
  assert.equal(installed.baseCommit, PI_WEB_BASE);
  assert.deepEqual(installed.settingsSections, ['mcp', 'omnigent', 'paseo']);
  assert.deepEqual(installed.contributors, ['@woowtech/pi-paseo', '@woowtech/pi-omnigent-plugin']);
  assert.equal(installed.routing.status, 'user-wrapper');
  const receipt = json(path.join(installed.releaseRoot, '.pi-omnigent-web-install.json'));
  assert.equal(receipt.prebuilt, true);
  assert.equal(receipt.activation, 'complete');
  assert.equal(receipt.buildId, fs.readFileSync(path.join(prebuiltRoot, '.next/BUILD_ID'), 'utf8').trim());
  const reused = await installUi(options);
  assert.equal(reused.reused, true);
  assert.equal(reused.releaseRoot, installed.releaseRoot);
  assert.equal(treeHash(overlay), originalHash);

  const manifest = path.join(overlay, 'package.json');
  const savedManifest = fs.readFileSync(manifest);
  const active = fs.realpathSync(installed.adapterRoot);
  const hostFile = path.join(home, '.local/share/pi-omnigent-web/host-install.json');
  const hostBefore = fs.readFileSync(hostFile);
  const rejected = [];
  for (const version of ['0.1.11', '0.1.10-rc.1']) {
    writeJson(manifest, { ...paseo, version });
    await assert.rejects(installUi(options), { code: 'COMBINED_ADAPTER_MISMATCH' });
    rejected.push(version);
  }
  fs.writeFileSync(manifest, savedManifest);
  // Recompute the overlay's own hash: the combined contributor pin must still reject it.
  const patchFile = path.join(overlay, 'host/adapter.patch');
  const metaFile = path.join(overlay, 'host/adapter-meta.json');
  fs.appendFileSync(patchFile, '\n');
  writeJson(metaFile, { ...json(metaFile), patchSha256: sha(fs.readFileSync(patchFile)) });
  await assert.rejects(installUi(options), { code: 'COMBINED_ADAPTER_MISMATCH' });
  assert.equal(fs.realpathSync(installed.adapterRoot), active);
  assert.deepEqual(fs.readFileSync(hostFile), hostBefore);
  assert.equal(treeHash(paseoRoot), originalHash);
  result = {
    passed: true, paseoVersion: paseo.version,
    omnigentVersion: json(path.join(packageRoot, 'package.json')).version,
    packageFilesSha256: originalHash,
    adapterSha256: sha(fs.readFileSync(path.join(paseoRoot, 'host/adapter.patch'))),
    baseCommit: PI_WEB_BASE, buildId: receipt.buildId,
    realInstaller: true, prebuiltSourceVerified: true, installAndReuse: true,
    rejectedVersions: rejected, changedContributorHashRejected: true,
    activeRoutingPreservedOnRejection: true, inputPackageUnchanged: true,
    daemonOrModelCalls: false,
  };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
result.temporaryHomeRemoved = !fs.existsSync(temporary);
fs.mkdirSync(path.dirname(path.resolve(outputArg)), { recursive: true });
writeJson(outputArg, result);
console.log(JSON.stringify(result, null, 2));
