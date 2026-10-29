import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runtime from '../src/runtime.mjs';
import { boot, loadPiSdk, packageLifecycle } from '../src/web.mjs';

// Two copies of the same package, as on a tenant whose git pin is switched to
// the image bundle (or back). The real Pi SDK reads the real settings.json; only
// the Omnigent adapter and the dependency inventory are injected.
const NAME = '@woowtech/pi-omnigent-plugin';
const GIT = 'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.29';

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-source-switch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agentDir = path.join(home, '.pi/agent');
  const loc = { home, agentDir, stateDir: path.join(agentDir, 'omnigent-plugin'),
    omniDir: path.join(home, '.omnigent'), omniDataDir: path.join(home, '.omnigent') };
  const copy = (directory, version) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: NAME, version }));
    return directory;
  };
  const gitRoot = copy(path.join(agentDir, 'git/github.com/WOOWTECH/pi-omnigent-plugin'), '0.3.29');
  const bundleRoot = copy(path.join(home, 'opt/woow/pi-omnigent-plugin'), '0.3.30');
  const sdk = await loadPiSdk();
  const settings = sdk.SettingsManager.create(home, agentDir, { projectTrusted: false });
  const use = async packages => { settings.setPackages(packages); await settings.flush(); };
  const lifecycleOf = root => packageLifecycle({ ...loc, root, cwd: home, env: { HOME: home, PATH: '' }, sdk });
  const host = { online: false }, calls = [];
  const callAdapter = async input => {
    calls.push(input.action);
    if (['connect', 'resume'].includes(input.action)) host.online = true;
    if (input.action === 'verify') return { ok: true, data: { engine: input.engine, ok: true, reply: 'OMNIGENT_CONNECTION_OK',
      sessionId: `check-${input.engine}`, cleanup: 'stopped' } };
    return { ok: true, data: { server: 'https://omni.test', workspace: home,
      host: { id: 'original-host', connected: host.online }, engines: { pi: { ready: true } } } };
  };
  const dependencies = { ok: true, omnigent: { available: true }, pi: { available: true },
    claude: { available: false }, codex: { available: false } };
  const ctx = root => ({ loc: { ...loc, root }, dependencies, callAdapter });
  const observe = async root => runtime.observeLifecycle(await lifecycleOf(root), ctx(root));
  const login = async root => {
    await runtime.initialize({ ...ctx(root), server: 'https://omni.test', username: 'synthetic', password: 'synthetic-only', verify: true });
    await observe(root);
    host.online = false; calls.length = 0;
  };
  // Every file name and byte in the plugin state directory.
  const snapshot = () => Object.fromEntries(fs.readdirSync(loc.stateDir).sort()
    .map(name => [name, fs.statSync(path.join(loc.stateDir, name)).isFile() ? fs.readFileSync(path.join(loc.stateDir, name), 'utf8') : 'dir']));
  return { home, loc, gitRoot, bundleRoot, sdk, use, lifecycleOf, ctx, observe, login, snapshot, calls, host };
}

async function assertLoginKept(f, root) {
  const current = await runtime.status(f.ctx(root));
  assert.equal(current.loginConfirmed, true, 'switching the package source must keep the approved login');
  assert.equal(current.verification.pi?.ok, true, 'switching the package source must keep the chat receipts');
  const resumed = await runtime.resumeAuthorizedHost({ ...f.ctx(root), lifecycle: () => f.lifecycleOf(root) });
  assert.equal(resumed.resumed, true, 'the copy Pi now loads resumes the approved host without a password');
  assert.deepEqual(f.calls.filter(action => action !== 'status'), ['resume'], 'no password login and no chat');
}

test('git pin switched to the image bundle keeps the approved login and chat receipts', async t => {
  const f = await fixture(t);
  await f.use([GIT]); await f.login(f.gitRoot);
  await f.use([f.bundleRoot]);
  const before = f.snapshot();
  const old = await f.lifecycleOf(f.gitRoot);
  assert.equal(old.superseded, true);
  assert.equal(old.root, fs.realpathSync(f.bundleRoot));
  await runtime.observeLifecycle(old, f.ctx(f.gitRoot));
  assert.deepEqual(f.snapshot(), before, 'the replaced copy writes nothing');
  await f.observe(f.bundleRoot);
  await assertLoginKept(f, f.bundleRoot);
});

test('image bundle switched to a git pin keeps the approved login and chat receipts', async t => {
  const f = await fixture(t);
  await f.use([f.bundleRoot]); await f.login(f.bundleRoot);
  await f.use([GIT]);
  const before = f.snapshot();
  await f.observe(f.bundleRoot);
  assert.deepEqual(f.snapshot(), before, 'the replaced copy writes nothing');
  await f.observe(f.gitRoot);
  await assertLoginKept(f, f.gitRoot);
});

test('a 0.3.29 tenant moved from its git pin to the image bundle resumes without a password', async t => {
  const f = await fixture(t);
  await f.use([GIT]); await f.login(f.gitRoot);
  // Rewrite the state as 0.3.29 left it: no installation id, paths as identity.
  const stateFile = path.join(f.loc.stateDir, 'state.json'), proofFile = path.join(f.loc.stateDir, 'connection.json');
  const { installationId: _id, ...state } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  fs.writeFileSync(stateFile, JSON.stringify(state)); fs.chmodSync(stateFile, 0o600);
  fs.writeFileSync(proofFile, JSON.stringify({ ...proof, installation: { home: proof.installation.home,
    configHome: proof.installation.configHome, dataDir: proof.installation.dataDir } }));
  fs.chmodSync(proofFile, 0o600);
  // As the image seed does it: the pin is rewritten before any copy is running.
  await f.use([f.bundleRoot]);
  await f.observe(f.bundleRoot);
  await assertLoginKept(f, f.bundleRoot);
  assert.equal(JSON.parse(fs.readFileSync(proofFile, 'utf8')).installation.schema, 2);
});

test('a replaced copy neither resumes the host nor boots on its own view', async t => {
  const f = await fixture(t);
  await f.use([GIT]); await f.login(f.gitRoot);
  await f.use([f.bundleRoot]);
  const before = f.snapshot();
  const skipped = await runtime.resumeAuthorizedHost({ ...f.ctx(f.gitRoot), lifecycle: () => f.lifecycleOf(f.gitRoot) });
  assert.equal(skipped.resumed, false);
  assert.equal(skipped.reason, 'superseded');
  // Pi has not loaded the bundle's code here, so the hand-over target is a stub.
  fs.mkdirSync(path.join(f.bundleRoot, 'src'));
  fs.writeFileSync(path.join(f.bundleRoot, 'src/web.mjs'), 'export async function boot(options) {\n'
    + '  return { initialization: { phase: "stub" }, startup: { status: "stub-ready" },\n'
    + '    received: { delegated: options.delegatedBoot === true, root: options.root ?? options.loc?.root ?? null, lifecycle: options.lifecycle ?? null } };\n}\n');
  const result = await boot({ ...f.loc, root: f.gitRoot, cwd: f.home, env: { HOME: f.home, PATH: '' }, sdk: f.sdk,
    runtime: { status: () => assert.fail('a replaced copy must not inspect the adapter'),
      prepare: () => assert.fail('a replaced copy must not install dependencies') } });
  assert.equal(result.startup.status, 'stub-ready', 'startup is handed to the copy Pi loads');
  assert.deepEqual(result.received, { delegated: true, root: null, lifecycle: null });
  assert.equal(result.delegatedTo, fs.realpathSync(f.bundleRoot));
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.snapshot(), before);
});

test('a copy replaced by a git source that is not cloned yet stays inert', async t => {
  const f = await fixture(t);
  await f.use([f.bundleRoot]); await f.login(f.bundleRoot);
  fs.rmSync(f.gitRoot, { recursive: true });
  await f.use([GIT]);
  const before = f.snapshot();
  const pending = await f.lifecycleOf(f.bundleRoot);
  assert.equal(pending.superseded, true);
  assert.equal(pending.root, null);
  await runtime.observeLifecycle(pending, f.ctx(f.bundleRoot));
  const result = await boot({ ...f.loc, root: f.bundleRoot, cwd: f.home, env: { HOME: f.home, PATH: '' }, sdk: f.sdk });
  assert.equal(result.startup.status, 'superseded');
  assert.deepEqual(f.snapshot(), before);
  assert.equal((await runtime.status(f.ctx(f.bundleRoot))).loginConfirmed, true);
});

test('removing every copy of the package still revokes the approved login', async t => {
  const f = await fixture(t);
  await f.use([f.bundleRoot]); await f.login(f.bundleRoot);
  await f.use([]);
  const removed = await f.lifecycleOf(f.bundleRoot);
  assert.equal(removed.reason, 'package-removed-or-unregistered');
  await runtime.observeLifecycle(removed, f.ctx(f.bundleRoot));
  const current = await runtime.status(f.ctx(f.bundleRoot));
  assert.equal(current.loginConfirmed, false);
  assert.deepEqual(current.verification, {});
});

test('disabling the copy Pi loads revokes the login, even when a replaced copy observes it', async t => {
  const f = await fixture(t);
  await f.use([GIT]); await f.login(f.gitRoot);
  await f.use([{ source: f.bundleRoot, extensions: [], skills: [], prompts: [], themes: [] }]);
  const disabled = await f.lifecycleOf(f.gitRoot);
  assert.equal(disabled.reason, 'native-plugin-disabled');
  await runtime.observeLifecycle(disabled, f.ctx(f.gitRoot));
  assert.equal((await runtime.status(f.ctx(f.gitRoot))).loginConfirmed, false);
});

test('another enabled copy keeps the package active when one copy is disabled', async t => {
  const f = await fixture(t);
  await f.use([GIT]); await f.login(f.gitRoot);
  await f.use([GIT, { source: f.bundleRoot, extensions: [] }]);
  const bundle = await f.lifecycleOf(f.bundleRoot);
  assert.equal(bundle.superseded, true);
  assert.equal(bundle.root, fs.realpathSync(f.gitRoot));
  await runtime.observeLifecycle(bundle, f.ctx(f.bundleRoot));
  await f.observe(f.gitRoot);
  assert.equal((await runtime.status(f.ctx(f.gitRoot))).loginConfirmed, true);
});
