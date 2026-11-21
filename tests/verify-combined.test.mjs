import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyCombined } from '../bin/verify-combined.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-combined-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const own = path.join(temporary, 'own'), paseo = path.join(temporary, 'paseo');
  fs.mkdirSync(path.join(own, 'integrations'), { recursive: true });
  fs.cpSync(path.join(root, 'integrations/pi-web'), path.join(own, 'integrations/pi-web'), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(own, 'package.json'));
  fs.mkdirSync(path.join(paseo, 'host'), { recursive: true });
  const manifestFile = path.join(own, 'integrations/pi-web/combined.adapter-meta.json');
  const manifest = read(manifestFile), patch = 'fixture Agent Connect adapter\n';
  manifest.paseo.adapterPatchSha256 = sha(patch);
  write(manifestFile, manifest);
  write(path.join(paseo, 'package.json'), { name: manifest.paseo.packageName, version: manifest.paseo.packageVersion });
  fs.writeFileSync(path.join(paseo, 'host/adapter.patch'), patch);
  write(path.join(paseo, 'host/adapter-meta.json'), { schemaVersion: manifest.schemaVersion, repository: manifest.repository,
    baseCommit: manifest.baseCommit, piWebVersion: manifest.piWebVersion, patchSha256: sha(patch) });
  return { own, paseo, manifestFile };
}

test('local candidate verification checks both actual contributor files and the combined patch', t => {
  const { own, paseo } = fixture(t);
  assert.equal(verifyCombined(paseo, own).passed, true);
});

for (const [name, mutate] of [
  ['unexpected package version', ({ paseo }) => {
    const file = path.join(paseo, 'package.json'); write(file, { ...read(file), version: '999.0.0' });
  }],
  ['tampered contributor with recomputed own digest', ({ paseo }) => {
    const patch = path.join(paseo, 'host/adapter.patch'), meta = path.join(paseo, 'host/adapter-meta.json');
    fs.appendFileSync(patch, 'changed'); write(meta, { ...read(meta), patchSha256: sha(fs.readFileSync(patch)) });
  }],
  ['different upstream base', ({ paseo }) => {
    const meta = path.join(paseo, 'host/adapter-meta.json'); write(meta, { ...read(meta), baseCommit: 'other-base' });
  }],
  ['matching but unpinned upstream base', ({ own, paseo, manifestFile }) => {
    for (const file of [manifestFile, path.join(own, 'integrations/pi-web/adapter-meta.json'), path.join(paseo, 'host/adapter-meta.json')])
      write(file, { ...read(file), baseCommit: 'other-base' });
  }],
  ['tampered combined patch', ({ own }) => fs.appendFileSync(path.join(own, 'integrations/pi-web/combined.adapter.patch'), 'changed')],
]) test(`local candidate verification refuses ${name}`, t => {
  const setup = fixture(t); mutate(setup);
  assert.throws(() => verifyCombined(setup.paseo, setup.own), { code: 'COMBINED_ADAPTER_MISMATCH' });
});
