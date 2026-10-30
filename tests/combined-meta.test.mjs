import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { installUi, PI_WEB_BASE, PI_WEB_REPOSITORY, PI_WEB_VERSION } from '../bin/install-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const shipped = JSON.parse(fs.readFileSync(path.join(root, 'integrations/pi-web/combined.adapter-meta.json'), 'utf8'));

// Paseo v0.1.13 and v0.1.14 ship a byte-identical host/adapter.patch (#18).
const PASEO_ADAPTER = '348f0b34118deca5a42ea47e2c98fc92a85dc9354bcaee8c5a41ac249360ed19';

test('the combined adapter lists Paseo 0.1.13 and 0.1.14 under their shared adapter digest', () => {
  assert.equal(shipped.paseo.packageName, '@woowtech/pi-paseo');
  assert.equal(shipped.paseo.adapterPatchSha256, PASEO_ADAPTER);
  assert.deepEqual([shipped.paseo.packageVersion, ...shipped.paseo.compatiblePackageVersions], ['0.1.13', '0.1.14']);
});

// The real installer gate with the shipped plugin files and manifest. Only the
// Paseo digest is swapped for a stand-in patch, since the Paseo package is not
// part of this repository; CI's combined-ui job checks the real Paseo bytes.
function packageWithPaseo(t, version) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-combined-meta-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pkg = path.join(home, 'plugin'), paseo = path.join(home, 'paseo');
  fs.mkdirSync(path.join(pkg, 'integrations'), { recursive: true });
  fs.cpSync(path.join(root, 'integrations/pi-web'), path.join(pkg, 'integrations/pi-web'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(pkg, 'package.json'));
  const stand = 'stand-in Paseo contribution\n';
  fs.writeFileSync(path.join(pkg, 'integrations/pi-web/combined.adapter-meta.json'),
    JSON.stringify({ ...shipped, paseo: { ...shipped.paseo, adapterPatchSha256: sha(stand) } }));
  fs.mkdirSync(path.join(paseo, 'host'), { recursive: true });
  fs.writeFileSync(path.join(paseo, 'package.json'), JSON.stringify({ name: '@woowtech/pi-paseo', version }));
  fs.writeFileSync(path.join(paseo, 'host/adapter.patch'), stand);
  fs.writeFileSync(path.join(paseo, 'host/adapter-meta.json'), JSON.stringify({ schemaVersion: 1, repository: PI_WEB_REPOSITORY,
    baseCommit: PI_WEB_BASE, piWebVersion: PI_WEB_VERSION, patchSha256: sha(stand) }));
  const passed = Object.assign(new Error('gate passed'), { code: 'GATE_PASSED' });
  return installUi({ home, packageRoot: pkg, overlayPackageRoot: paseo, sharedHostPath: path.join(home, 'absent/host.json'),
    env: { HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), PATH: process.env.PATH },
    // The first build command proves the manifest was accepted; nothing is built.
    run: async () => { throw passed; } });
}

for (const version of ['0.1.13', '0.1.14']) test(`the installer accepts Paseo ${version} with the shipped manifest`, async t => {
  await assert.rejects(packageWithPaseo(t, version), { code: 'GATE_PASSED' });
});

test('an unlisted Paseo version is still refused even with the same adapter', async t => {
  await assert.rejects(packageWithPaseo(t, '0.1.15'), { code: 'COMBINED_ADAPTER_MISMATCH' });
});
