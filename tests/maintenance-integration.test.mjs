import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discover, installDependencies, runCommand } from '../src/installer.mjs';
import { ensureMaintenance, MAINTENANCE_AFTER_SHA256 } from '../src/maintenance.mjs';

const root = path.resolve(import.meta.dirname, '..');
const guard = path.join(root, 'src/maintenance_preservation.py');
const targetRelative = 'omnigent/native/native_bridge_common.py';
const consoleBody = await fs.readFile(path.join(root, 'src/native-maintenance/console-entry.body.py'));
const coreMetadata = await fs.readFile(path.join(root, 'tests/fixtures/maintenance-omnigent-METADATA'));
const entryMetadata = await fs.readFile(path.join(root, 'tests/fixtures/maintenance-entry_points.txt'));
const before = await fs.readFile(path.join(root, 'tests/fixtures/maintenance-native-bridge-common.before.py'));
const after = await fs.readFile(path.join(root, 'src/native-maintenance/overlay', targetRelative));
const sha = raw => createHash('sha256').update(raw).digest('hex');
const absent = () => ({ available: false, path: null });
async function writable(directory) {
  await fs.chmod(directory, 0o700);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const p = path.join(directory, entry.name);
    if (entry.isDirectory()) await writable(p);
  }
}
async function fixtureRecord(f) {
  const distribution = path.join(f.purelib, 'omnigent-0.16.0.dist-info');
  const rows = [];
  for (const relative of ['omnigent/__init__.py', 'omnigent/cli.py',
    'omnigent-0.16.0.dist-info/METADATA', 'omnigent-0.16.0.dist-info/entry_points.txt', path.relative(f.purelib, f.binary)]) {
    const raw = await fs.readFile(path.resolve(f.purelib, relative));
    rows.push([relative.split(path.sep).join('/'), 'sha256=' + createHash('sha256').update(raw).digest('base64url'), String(raw.length)]);
  }
  rows.push([targetRelative, 'sha256=' + createHash('sha256').update(before).digest('base64url'), String(before.length)]);
  rows.push(['omnigent-0.16.0.dist-info/RECORD', '', '']);
  await fs.writeFile(path.join(distribution, 'RECORD'), rows.map(row => row.join(',')).join('\n') + '\n');
}
async function fixture(t, { managed = true, source = before } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-seam-'));
  t.after(async () => { await writable(directory); await fs.rm(directory, { recursive: true, force: true }); });
  const stateDir = path.join(directory, 'state');
  const tool = managed ? path.join(stateDir, 'uv/tools/omnigent') : path.join(directory, 'image/omnigent');
  const venv = await runCommand('python3', ['-I', '-B', '-m', 'venv', '--without-pip', tool], { timeoutMs: 15_000 });
  assert.equal(venv.code, 0, venv.stderr);
  const python = path.join(tool, 'bin/python');
  const query = await runCommand(python, ['-I', '-B', '-c', "import sysconfig;print(sysconfig.get_path('purelib'))"]);
  assert.equal(query.code, 0, query.stderr);
  const purelib = query.stdout.trim(), target = path.join(purelib, targetRelative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Any SDK import would fail the test. The common module is only read/compiled.
  await fs.writeFile(path.join(purelib, 'omnigent/__init__.py'), "raise AssertionError('SDK_IMPORT_FORBIDDEN_IN_SYNTHETIC_TEST')\n");
  await fs.writeFile(target, source, { mode: 0o640 });
  const binary = path.join(tool, 'bin/omnigent');
  await fs.writeFile(binary, Buffer.concat([Buffer.from(`#!${python}\n`), consoleBody]), { mode: 0o700 });
  await fs.writeFile(path.join(purelib, 'omnigent/cli.py'), "raise AssertionError('SDK_IMPORT_FORBIDDEN_IN_SYNTHETIC_TEST')\n");
  const distribution = path.join(purelib, 'omnigent-0.16.0.dist-info');
  await fs.mkdir(distribution);
  await fs.writeFile(path.join(distribution, 'METADATA'), coreMetadata);
  await fs.writeFile(path.join(distribution, 'entry_points.txt'), entryMetadata);
  await fixtureRecord({ purelib, binary });
  const entry = { available: true, path: binary, python, version: '0.16.0' };
  return { directory, stateDir, tool, purelib, target, binary, python, entry,
    env: { PATH: process.env.PATH, HOME: directory },
    check(extra = {}) { return ensureMaintenance(entry, { stateDir, env: this.env, run: runCommand, ...extra }); } };
}
async function sourceSnapshot(directory) {
  const rows = {};
  async function scan(p) {
    const info = await fs.lstat(p); const key = path.relative(directory, p);
    if (info.isSymbolicLink()) { rows[key] = { link: await fs.readlink(p) }; return; }
    rows[key] = { dev: info.dev, ino: info.ino, mode: info.mode, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
    if (info.isDirectory()) for (const name of await fs.readdir(p)) await scan(path.join(p, name));
    else rows[key].sha256 = sha(await fs.readFile(p));
  }
  await scan(directory); return rows;
}
function installed(f, available = true) {
  return { omnigent: available ? f.entry : absent(), uv: { available: true, path: '/synthetic/uv' },
    python: { available: true, path: f.python, version: '3.11.2' },
    claude: absent(), codex: absent(), pi: absent(), tmux: absent(), bwrap: absent(), node: absent(), npm: absent() };
}
function installOptions(f, extra) {
  return { home: f.directory, stateDir: f.stateDir, env: f.env, platform: 'linux', arch: 'x64', ...extra };
}

test('locked fixture and payload are the exact reviewed before/after bytes', () => {
  assert.equal(sha(before), '2a80d492f6f844a8da0e7dbb3e8aaec396a2bbd525f6d042ddc3cf2eed6bccc6');
  assert.equal(sha(after), MAINTENANCE_AFTER_SHA256);
});
test('selected managed Python patches known-before and compiles checked-hash caches without SDK import', async t => {
  const f = await fixture(t), result = await f.check();
  assert.equal(result.ok, true); assert.equal(result.state, 'applied');
  assert.deepEqual(await fs.readFile(f.target), after);
  assert.equal((await fs.stat(f.target)).mode & 0o777, 0o640);
  const caches = await fs.readdir(path.join(path.dirname(f.target), '__pycache__'));
  assert.equal(caches.length, 3);
  assert.equal((await f.check()).state, 'verified');
});
test('exact-after bundled SDK verifies read-only without touching files, caches or metadata', async t => {
  const f = await fixture(t, { managed: false, source: after });
  await fs.chmod(f.target, 0o400); await fs.chmod(path.dirname(f.target), 0o500);
  const baseline = await sourceSnapshot(f.tool);
  const result = await f.check();
  assert.equal(result.ok, true); assert.equal(result.state, 'verified');
  assert.deepEqual(await sourceSnapshot(f.tool), baseline);
});
test('read-only exact-after managed SDK verifies with existing checked-hash caches and performs no writes', async t => {
  const f = await fixture(t); assert.equal((await f.check()).ok, true);
  const cache = path.join(path.dirname(f.target), '__pycache__');
  for (const name of await fs.readdir(cache)) await fs.chmod(path.join(cache, name), 0o400);
  await fs.chmod(cache, 0o500); await fs.chmod(f.target, 0o400); await fs.chmod(path.dirname(f.target), 0o500);
  const baseline = await sourceSnapshot(f.tool);
  assert.equal((await f.check()).ok, true);
  assert.deepEqual(await sourceSnapshot(f.tool), baseline);
});
test('known-before bundled SDK is HOLD even when writable; no global/image patch authority', async t => {
  const f = await fixture(t, { managed: false }); const baseline = await sourceSnapshot(f.tool);
  assert.equal((await f.check()).ok, false);
  assert.deepEqual(await sourceSnapshot(f.tool), baseline);
});
test('known-before read-only managed SDK is HOLD before any write', async t => {
  const f = await fixture(t); await fs.chmod(path.dirname(f.target), 0o500);
  const baseline = await sourceSnapshot(f.tool);
  assert.equal((await f.check()).ok, false);
  assert.deepEqual(await sourceSnapshot(f.tool), baseline);
});
test('unknown installed source is HOLD and never overwritten', async t => {
  const f = await fixture(t, { source: Buffer.concat([before, Buffer.from('\n# drift\n')]) });
  const baseline = await sourceSnapshot(f.tool);
  assert.equal((await f.check()).ok, false);
  assert.deepEqual(await sourceSnapshot(f.tool), baseline);
});
test('foreign symlinked target is HOLD and destination remains unchanged', async t => {
  const f = await fixture(t), external = path.join(f.directory, 'foreign.py');
  await fs.writeFile(external, before); await fs.unlink(f.target); await fs.symlink(external, f.target);
  assert.equal((await f.check()).ok, false);
  assert.deepEqual(await fs.readFile(external), before);
});
test('a launcher in managed bin cannot grant patch authority over a bundled SDK', async t => {
  const f = await fixture(t, { managed: false }); const bin = path.join(f.stateDir, 'bin/omnigent');
  await fs.mkdir(path.dirname(bin), { recursive: true }); await fs.symlink(f.binary, bin);
  const baseline = await sourceSnapshot(f.tool); f.entry.path = bin;
  assert.equal((await f.check()).ok, false);
  assert.deepEqual(await sourceSnapshot(f.tool), baseline);
});
test('discover selects the SDK-adjacent Python and its own purelib is guarded', async t => {
  const f = await fixture(t, { source: after, managed: false });
  const tools = await discover({ HOME: f.directory, PATH: path.dirname(f.binary), PI_OMNIGENT_BIN: f.binary }, { cacheMs: 0,
    run: (command, args, options) => command === f.binary
      ? Promise.resolve({ code: 0, stdout: 'omnigent 0.16.0', stderr: '' })
      : runCommand(command, args, options) });
  assert.equal(tools.omnigent.python, f.python);
  const selected = await ensureMaintenance(tools.omnigent, { stateDir: f.stateDir, env: f.env, run: runCommand });
  assert.equal(selected.ok, true);
});
test('fresh uv installation is guarded immediately before installer success', async t => {
  const f = await fixture(t); let present = false; const calls = [];
  const result = await installDependencies(installOptions(f, {
    discover: async () => installed(f, present),
    run: async (command, args, options) => {
      calls.push({ command, args });
      if (command === '/synthetic/uv') { present = true; return { code: 0 }; }
      return runCommand(command, args, options);
    },
  }));
  assert.equal(result.ok, true); assert.equal(result.maintenancePreservation.state, 'applied');
  assert.equal(calls.length, 2); assert.equal(calls[0].command, '/synthetic/uv');
  assert.deepEqual(calls[0].args, ['tool', 'install', '--python', '3.12', 'omnigent==0.16.0']);
  assert.equal(calls[1].command, f.python); assert.deepEqual(await fs.readFile(f.target), after);
});
test('managed force-update is guarded after replacement without changing engine install policy', async t => {
  const f = await fixture(t); const calls = [];
  const result = await installDependencies(installOptions(f, { update: true, discover: async () => installed(f),
    run: async (command, args, options) => {
      calls.push({ command, args });
      return command === '/synthetic/uv' ? { code: 0 } : runCommand(command, args, options);
    } }));
  assert.equal(result.ok, true); assert.equal(result.maintenancePreservation.state, 'applied');
  assert.ok(calls[0].args.includes('--force')); assert.equal(calls[1].command, f.python);
});
test('existing managed install is patched even when uv install is unnecessary', async t => {
  const f = await fixture(t);
  const result = await installDependencies(installOptions(f, { discover: async () => installed(f),
    run: async (command, args, options) => { assert.equal(command, f.python); return runCommand(command, args, options); } }));
  assert.equal(result.ok, true); assert.equal(result.maintenancePreservation.state, 'applied');
});
test('existing bundled exact-after update runs verification only; no uv/network call', async t => {
  const f = await fixture(t, { managed: false, source: after });
  const baseline = await sourceSnapshot(f.tool);
  const result = await installDependencies(installOptions(f, { update: true, discover: async () => installed(f),
    run: async (command, args, options) => { assert.equal(command, f.python); return runCommand(command, args, options); } }));
  assert.equal(result.ok, true); assert.equal(result.changed, false);
  assert.deepEqual(await sourceSnapshot(f.tool), baseline);
});
test('fresh install source drift is not reported as successful dependency readiness', async t => {
  const f = await fixture(t, { source: Buffer.from('UNKNOWN SOURCE\n') }); let present = false;
  const result = await installDependencies(installOptions(f, { discover: async () => installed(f, present),
    run: async (command, args, options) => {
      if (command === '/synthetic/uv') { present = true; return { code: 0 }; }
      return runCommand(command, args, options);
    } }));
  assert.equal(result.ok, false); assert.equal(result.maintenancePreservation.ok, false);
  assert.ok(result.steps.some(s => s.action === 'maintenance-preservation' && s.status === 'blocked'));
});
test('missing selected Python cannot fall back to a system interpreter', async () => {
  let calls = 0;
  assert.equal((await ensureMaintenance({ available: true, path: '/fake/omnigent' }, {
    stateDir: '/fake/state', run: async () => { calls++; }, env: {} })).ok, false);
  assert.equal(calls, 0);
});
test('guard errors, malformed proofs, wrong pins and timeout all fail closed without raw diagnostics', async () => {
  const valid = { schema: 'plugin-native-maintenance-preservation/v2', ok: true, state: 'verified',
    sourceSha256: MAINTENANCE_AFTER_SHA256, purelib: '/own/purelib', sdkImported: false,
    distribution: 'omnigent', coreVersion: '0.16.0', consoleEntryPoint: 'omnigent.cli:main',
    consoleScriptValidated: true, pythonExecutable: '/sdk/bin/python', consoleScript: '/sdk/bin/omnigent',
    consoleScriptSha256: 'a'.repeat(64) };
  const entry = { available: true, path: '/sdk/bin/omnigent', python: '/sdk/bin/python' };
  const refusal = reason => JSON.stringify({ ok: false, code: 'MAINTENANCE_PRESERVATION_REQUIRED', reason });
  for (const [response, reason] of [[{ code: null, error: 'TIMEOUT' }, 'guard-run-failed'], [{ code: null, signal: 'SIGTERM' }, 'guard-run-failed'],
    [{ code: null, signal: 'SIGTERM', stdout: refusal('unsafe-source-file') }, 'guard-run-failed'], [{ code: 1, stdout: 'SENSITIVE' }, 'guard-refused'],
    [{ code: 1, stdout: refusal('/home/SENSITIVE') }, 'guard-refused'], [{ code: 1, stdout: refusal('Unsafe Source') }, 'guard-refused'],
    [{ code: 1, stdout: JSON.stringify({ ok: false, code: 'OTHER', reason: 'unsafe-source-file' }) }, 'guard-refused'],
    [{ code: 1, stdout: refusal('unsafe-source-file') }, 'unsafe-source-file'],
    [{ code: 0, stdout: 'malformed' }, 'unexpected-guard-result'], [{ code: 0, stdout: 'null' }, 'unexpected-guard-result'],
    ...[{ sourceSha256: sha(before) }, { sdkImported: true }, { state: 'checked' }, { purelib: 'relative' }, { coreVersion: '9.9.9' },
      { distribution: 'foreign' }, { consoleScriptValidated: false }, { pythonExecutable: '/foreign/python' }]
      .map(change => [{ code: 0, stdout: JSON.stringify({ ...valid, ...change }) }, 'unexpected-guard-result'])]) {
    const result = await ensureMaintenance(entry, { stateDir: '/state', env: {}, run: async () => response });
    assert.deepEqual(result, { ok: false, code: 'MAINTENANCE_PRESERVATION_REQUIRED', reason });
  }
  assert.deepEqual(await ensureMaintenance(entry, { stateDir: '/state', run: async () => { throw Error('SENSITIVE'); } }),
    { ok: false, code: 'MAINTENANCE_PRESERVATION_REQUIRED', reason: 'guard-run-failed' });
  assert.equal((await ensureMaintenance({ available: true, path: '/sdk/bin/omnigent' }, { stateDir: '/state', run: async () => ({ code: 0 }) }))?.reason, 'guard-not-run');
});
for (const relative of ['apply_maintenance_patch.py', 'source-lock.json', 'overlay/' + targetRelative]) {
  test(`tampered packaged ${relative} is HOLD`, async t => {
    const f = await fixture(t, { source: after }), copied = path.join(f.directory, 'copied-src');
    await fs.mkdir(copied); await fs.copyFile(guard, path.join(copied, 'maintenance_preservation.py'));
    await fs.cp(path.join(root, 'src/native-maintenance'), path.join(copied, 'native-maintenance'), { recursive: true });
    await fs.appendFile(path.join(copied, 'native-maintenance', relative), '\n# DRIFT');
    const baseline = await sourceSnapshot(f.tool);
    const result = await runCommand(f.python, ['-I', '-B', path.join(copied, 'maintenance_preservation.py'),
      '--omnigent-bin', f.binary, '--state-dir', f.stateDir]);
    assert.equal(result.code, 1); assert.deepEqual(await sourceSnapshot(f.tool), baseline);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, code: 'MAINTENANCE_PRESERVATION_REQUIRED', reason: 'packaged-review-pin-mismatch' });
  });
}
test('unchecked stale bytecode cannot override a correct exact-after source', async t => {
  const f = await fixture(t); assert.equal((await f.check()).ok, true);
  const cache = path.join(path.dirname(f.target), '__pycache__');
  const name = (await fs.readdir(cache)).find(n => !n.includes('.opt-'));
  const file = path.join(cache, name), raw = await fs.readFile(file); raw.writeUInt32LE(1, 4); await fs.writeFile(file, raw);
  const baseline = await sourceSnapshot(f.tool);
  assert.equal((await f.check()).ok, false); assert.deepEqual(await sourceSnapshot(f.tool), baseline);
});
test('bytecode with a correct after-source header but foreign executable payload is HOLD', async t => {
  const f = await fixture(t); assert.equal((await f.check()).ok, true);
  const cache = path.join(path.dirname(f.target), '__pycache__');
  const file = path.join(cache, (await fs.readdir(cache)).find(n => !n.includes('.opt-')));
  const compiled = await runCommand(f.python, ['-I', '-B', '-c',
    'import marshal,pathlib,sys;p=pathlib.Path(sys.argv[1]);p.write_bytes(p.read_bytes()[:16]+marshal.dumps(compile("raise RuntimeError()",sys.argv[2],"exec")))', file, f.target]);
  assert.equal(compiled.code, 0); assert.equal((await f.check()).ok, false);
});
test('package explicitly includes exact runtime payload files; brand/version and hook anchor stay intact', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
  assert.equal(pkg.name, '@woowtech/pi-omnigent-plugin'); assert.equal(pkg.version, '0.3.40');
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'src/native-maintenance/bundle-provenance.json')));
  assert.equal(provenance.bundleSha256, 'f9ab01b40c9e72d3110c67b3735deb740e9a07416a86d2e01bd9f7c7d9a60739');
  for (const [name, record] of Object.entries(provenance.files)) {
    assert.ok(pkg.files.includes(name), name); const raw = await fs.readFile(path.join(root, name));
    assert.equal(raw.length, record.bytes); assert.equal(sha(raw), record.sha256);
  }
  assert.ok(pkg.files.includes('src/native-maintenance/bundle-provenance.json'));
  const installer = await fs.readFile(path.join(root, 'src/installer.mjs'), 'utf8');
  const anchor = '        discovery = { ...blankDiscovery(), ...await find(env, { fresh }) };\n        if (discovery.omnigent?.available) {';
  assert.equal(installer.split(anchor).length - 1, 1);
  assert.ok(installer.indexOf('maintenancePreservation = await maintenance') > installer.indexOf(anchor));
});

const invalidIdentityCases = [
  ['missing metadata', async f => fs.rm(path.join(f.purelib, 'omnigent-0.16.0.dist-info'), { recursive: true })],
  ['wrong version metadata', async f => fs.writeFile(path.join(f.purelib, 'omnigent-0.16.0.dist-info/METADATA'), coreMetadata.toString().replace('Version: 0.16.0', 'Version: 9.9.9'))],
  ['wrong distribution metadata', async f => fs.writeFile(path.join(f.purelib, 'omnigent-0.16.0.dist-info/METADATA'), coreMetadata.toString().replace('Name: omnigent\n', 'Name: foreign-sdk\n'))],
  ['ambiguous duplicate metadata', async f => fs.cp(path.join(f.purelib, 'omnigent-0.16.0.dist-info'), path.join(f.purelib, 'foreign-core-0.16.0.dist-info'), { recursive: true })],
  ['foreign metadata directory name', async f => fs.rename(path.join(f.purelib, 'omnigent-0.16.0.dist-info'), path.join(f.purelib, 'foreign-0.16.0.dist-info'))],
  ['duplicate version headers', async f => fs.writeFile(path.join(f.purelib, 'omnigent-0.16.0.dist-info/METADATA'), 'Metadata-Version: 2.4\nName: omnigent\nVersion: 0.16.0\nVersion: 9.9.9\n\n')],
  ['foreign console entry declaration', async f => fs.writeFile(path.join(f.purelib, 'omnigent-0.16.0.dist-info/entry_points.txt'), '[console_scripts]\nomnigent = foreign.cli:main\n')],
  ['missing RECORD ownership', async f => fs.writeFile(path.join(f.purelib, 'omnigent-0.16.0.dist-info/RECORD'), '')],
  ['foreign common RECORD path', async f => {
    const p = path.join(f.purelib, 'omnigent-0.16.0.dist-info/RECORD');
    await fs.writeFile(p, (await fs.readFile(p, 'utf8')).replace(targetRelative, '../foreign/native_bridge_common.py'));
  }],
  ['wrong CLI RECORD bytes', async f => fs.appendFile(path.join(f.purelib, 'omnigent/cli.py'), '# unrecorded drift\n')],
  ['metadata symlink to foreign root', async f => {
    const p = path.join(f.purelib, 'omnigent-0.16.0.dist-info/METADATA'), foreign = path.join(f.directory, 'foreign-METADATA');
    await fs.copyFile(p, foreign); await fs.unlink(p); await fs.symlink(foreign, p);
  }],
  ['package root symlink', async f => {
    const p = path.join(f.purelib, 'omnigent/cli.py'), foreign = path.join(f.directory, 'foreign-cli.py');
    await fs.copyFile(p, foreign); await fs.unlink(p); await fs.symlink(foreign, p);
  }],
  ['Node console launcher', async f => { await fs.writeFile(f.binary, '#!' + process.execPath + '\nconsole.log("foreign");\n'); await fixtureRecord(f); }],
  ['shell console launcher', async f => { await fs.writeFile(f.binary, '#!/bin/sh\nexec /foreign/python -m omnigent "$@"\n'); await fixtureRecord(f); }],
  ['redirecting Python entry', async f => { await fs.writeFile(f.binary, '#!' + f.python + '\nimport sys\nsys.path.insert(0,"/foreign/sdk")\nfrom omnigent.cli import main\nmain()\n'); await fixtureRecord(f); }],
  ['wrong Python shebang', async f => { await fs.writeFile(f.binary, Buffer.concat([Buffer.from('#!/foreign/python\n'), consoleBody])); await fixtureRecord(f); }],
  ['oversized console entry', async f => { await fs.appendFile(f.binary, '#'.repeat(5000)); await fixtureRecord(f); }],
  ['foreign scripts path beside own Python', async f => {
    const foreign = path.join(path.dirname(f.binary), 'foreign-omnigent'); await fs.copyFile(f.binary, foreign); await fs.chmod(foreign, 0o700); f.entry.path = foreign;
  }],
];
for (const source of [before, after]) {
  for (const [name, mutate] of invalidIdentityCases) {
    test(`${name} blocks ${source === before ? 'before' : 'after'} SDK before writes/success`, async t => {
      const f = await fixture(t, { source }); await mutate(f);
      const baseline = await sourceSnapshot(f.tool);
      assert.equal((await f.check()).ok, false);
      assert.deepEqual(await sourceSnapshot(f.tool), baseline);
    });
  }
}
test('correct managed launcher symlink binds the resolved reviewed SDK script and metadata', async t => {
  const f = await fixture(t); const link = path.join(f.stateDir, 'bin/omnigent');
  await fs.mkdir(path.dirname(link), { recursive: true }); await fs.symlink(f.binary, link); f.entry.path = link;
  const proof = await f.check(); assert.equal(proof.ok, true); assert.equal(proof.coreVersion, '0.16.0');
  assert.equal(proof.consoleScriptValidated, true); assert.deepEqual(await fs.readFile(f.target), after);
});

test('existing hardlinked managed SDK stays blocked without reinstall or cache mutation', async t => {
  const f = await fixture(t), cached = path.join(f.directory, 'cache-common.py');
  await fs.link(f.target, cached);
  const baseline = await sourceSnapshot(f.directory);
  const calls = [];
  const result = await installDependencies(installOptions(f, {
    discover: async () => installed(f),
    run: async (command, args, options) => {
      calls.push(command); assert.equal(command, f.python, 'must never detach or silently reinstall');
      return runCommand(command, args, options);
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(result.maintenancePreservation.ok, false);
  // The real guard names the cause, so status shows why instead of only "dependencies missing".
  assert.equal(result.maintenancePreservation.reason, 'unsafe-source-file');
  assert.ok(result.issues.some(issue => issue.includes('(reason: unsafe-source-file)') && issue.includes('pi-omnigent repair --update')));
  assert.deepEqual(calls, [f.python]);
  assert.deepEqual(await sourceSnapshot(f.directory), baseline);
  assert.equal((await fs.stat(f.target)).ino, (await fs.stat(cached)).ino);
  assert.equal((await fs.stat(f.target)).nlink, 2);
});
