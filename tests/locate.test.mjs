import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locatePackage, ownPackageName, readPackageName, canonicalRoot, DEFAULT_PACKAGE_NAME } from '../src/locate.mjs';
import { loadPiSdk } from '../src/web.mjs';

const NAME = '@woowtech/pi-omnigent-plugin';

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-locate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agentDir = path.join(home, '.pi/agent');
  const copy = (directory, name = NAME) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '0.0.0' }));
    return fs.realpathSync(directory);
  };
  const sdk = await loadPiSdk();
  const settings = sdk.SettingsManager.create(home, agentDir, { projectTrusted: false });
  const use = async packages => { settings.setPackages(packages); await settings.flush(); };
  const locate = (name = NAME) => locatePackage({ sdk, cwd: home, agentDir, name });
  return { home, agentDir, copy, use, locate, sdk };
}

test('copies are matched by package name, not by the directory they run from', async t => {
  const f = await fixture(t);
  const git = f.copy(path.join(f.agentDir, 'git/github.com/WOOWTECH/pi-omnigent-plugin'));
  const bundle = f.copy(path.join(f.home, 'opt/woow/pi-omnigent-plugin'));
  const fork = f.copy(path.join(f.home, 'forks/pi-omnigent-plugin'), '@someone/pi-omnigent-plugin');
  await f.use(['git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.29', fork, bundle]);
  const located = f.locate();
  assert.equal(located.readable, true);
  assert.deepEqual(located.copies.map(copy => copy.root), [git, bundle], 'a different package at a similar path is not a copy');
  assert.equal(located.loaded.root, bundle, 'the last enabled installed copy is the one Pi loads');
  assert.equal(located.loaded.source, bundle);
  assert.equal(located.loaded.enabled, true);
});

test('a disabled copy defers to an enabled one; with every copy disabled the last one is reported', async t => {
  const f = await fixture(t);
  const git = f.copy(path.join(f.agentDir, 'git/github.com/WOOWTECH/pi-omnigent-plugin'));
  const bundle = f.copy(path.join(f.home, 'opt/woow/pi-omnigent-plugin'));
  const source = 'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.29';
  await f.use([source, { source: bundle, extensions: [] }]);
  assert.equal(f.locate().loaded.root, git);
  await f.use([{ source, extensions: [] }, { source: bundle, extensions: [] }]);
  const disabled = f.locate().loaded;
  assert.equal(disabled.root, bundle);
  assert.equal(disabled.enabled, false);
});

test('sources Pi has not installed yet count by npm name or git repository; a missing path does not', async t => {
  const f = await fixture(t);
  await f.use(['npm:@woowtech/pi-omnigent-plugin@0.3.30']);
  assert.deepEqual(f.locate().loaded, { source: 'npm:@woowtech/pi-omnigent-plugin@0.3.30', scope: 'user', root: null, enabled: true });
  await f.use(['git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.30']);
  assert.equal(f.locate().loaded.root, null);
  await f.use(['https://github.com/WOOWTECH/pi-omnigent-plugin.git']);
  assert.equal(f.locate().copies.length, 1);
  await f.use(['npm:@woowtech/pi-omnigent-plugin-extra', 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.14', path.join(f.home, 'missing/pi-omnigent-plugin')]);
  assert.equal(f.locate().loaded, null);
});

test('a pending git source counts only when it is the official repository', async t => {
  const f = await fixture(t);
  // Every spelling of the official repository is the package.
  for (const source of ['git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.30', 'github:WOOWTECH/pi-omnigent-plugin',
    'https://github.com/woowtech/pi-omnigent-plugin.git#v0.3.30', 'ssh://git@github.com/WOOWTECH/pi-omnigent-plugin.git']) {
    await f.use([source]);
    assert.equal(f.locate().copies.length, 1, source);
  }
  // A same-named fork or another host is not: while nothing is installed it would
  // otherwise mark every running copy as replaced and hold back the revocation.
  for (const source of ['git:github.com/evil/pi-omnigent-plugin', 'https://gitlab.example/anyone/PI-OMNIGENT-PLUGIN.git',
    'git:github.com/WOOWTECH/pi-omnigent-plugin-fork@v0.3.30']) {
    await f.use([source]);
    assert.equal(f.locate().loaded, null, source);
  }
});

test('an installed copy wins over one still waiting for install', async t => {
  const f = await fixture(t);
  const bundle = f.copy(path.join(f.home, 'opt/woow/pi-omnigent-plugin'));
  await f.use([bundle, 'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.30']);
  const located = f.locate();
  assert.equal(located.copies.length, 2);
  assert.equal(located.loaded.root, bundle);
});

test('a repeated or symlinked entry for one install location is one copy', async t => {
  const f = await fixture(t);
  const bundle = f.copy(path.join(f.home, 'opt/woow/pi-omnigent-plugin'));
  const link = path.join(f.home, 'bundle-link');
  fs.symlinkSync(bundle, link);
  await f.use([bundle, link]);
  assert.deepEqual(f.locate().copies.map(copy => copy.root), [bundle]);
  assert.equal(canonicalRoot(link), bundle);
});

test('unreadable package settings list nothing and say so', async t => {
  const f = await fixture(t);
  fs.mkdirSync(f.agentDir, { recursive: true });
  fs.writeFileSync(path.join(f.agentDir, 'settings.json'), '{ not json');
  const located = f.locate();
  assert.equal(located.readable, false);
  assert.equal(located.loaded, null);
});

test('package names come from package.json, with the published name as the fallback', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert.equal(readPackageName(root), NAME);
  assert.equal(ownPackageName(), NAME);
  assert.equal(ownPackageName(path.join(os.tmpdir(), 'no-such-plugin-root')), DEFAULT_PACKAGE_NAME);
  assert.equal(readPackageName(path.join(os.tmpdir(), 'no-such-plugin-root')), null);
});
