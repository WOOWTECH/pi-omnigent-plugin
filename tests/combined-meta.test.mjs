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

// Keep one exact package pair for the Agent Connect 0.17.5 candidate.
test('the combined adapter pins exactly Agent Connect 0.1.27-rc.2', () => {
  assert.equal(shipped.paseo.packageName, '@woowtech/pi-paseo');
  assert.match(shipped.paseo.adapterPatchSha256, /^[a-f0-9]{64}$/);
  assert.equal(shipped.paseo.packageVersion, '0.1.27-rc.2');
  assert.equal(shipped.omnigent.packageVersion, '0.3.42-rc.2');
  assert.deepEqual(shipped.paseo.compatiblePackageVersions ?? [], []);
  assert.equal(shipped.paseo.compatibleAdapters, undefined);
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

for (const version of ['0.1.27-rc.2']) test(`the installer accepts Paseo ${version} with the shipped manifest`, async t => {
  await assert.rejects(packageWithPaseo(t, version), { code: 'GATE_PASSED' });
});

for (const version of ['0.1.13', '0.1.14', '0.1.15', '0.1.16', '0.1.17', '0.1.18', '0.1.19', '0.1.20', '0.1.21', '0.1.22', '0.1.23', '0.1.24', '0.1.25', '0.1.26', '0.1.27', '0.1.27-rc.1']) test(`the installer refuses a runtime outside the exact combined candidate ${version} even with matching patch bytes`, async t => {
  await assert.rejects(packageWithPaseo(t, version), { code: 'COMBINED_ADAPTER_MISMATCH' });
});
