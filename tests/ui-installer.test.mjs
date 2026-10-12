import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { installUi, readAdapter, runCommand, PI_WEB_BASE, PI_WEB_REPOSITORY, PI_WEB_VERSION } from '../bin/install-ui.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
function write(file, content, mode) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, mode ? { mode } : undefined); }
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, 'fixture git command failed'); return result.stdout.trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-omnigent-web installer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), source = path.join(root, 'upstream'), pkg = path.join(root, 'plugin');
  fs.mkdirSync(home); fs.mkdirSync(source);
  write(path.join(source, '.gitignore'), 'node_modules/\n.next/\n');
  write(path.join(source, 'package.json'), JSON.stringify({ name: '@agegr/pi-web', version: PI_WEB_VERSION, bin: { 'pi-web': 'bin/pi-web.js' } }));
  write(path.join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
  write(path.join(source, 'bin/pi-web.js'), '#!/usr/bin/env node\nconsole.log(JSON.stringify({launcher:"adapter",args:process.argv.slice(2),home:process.env.HOME,providerDir:process.env.PI_CODING_AGENT_DIR}));\n', 0o755);
  write(path.join(source, 'adapter.txt'), 'base\n');
  git(source, 'init', '--quiet'); git(source, 'add', '.');
  git(source, '-c', 'user.name=Installer Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'base');
  const localBase = git(source, 'rev-parse', 'HEAD');
  write(path.join(source, 'adapter.txt'), 'paseo adapter\n');
  const patch = git(source, 'diff', '--binary') + '\n';
  git(source, 'checkout', '--', 'adapter.txt');
  const meta = { schemaVersion: 1, repository: PI_WEB_REPOSITORY, baseCommit: PI_WEB_BASE, piWebVersion: PI_WEB_VERSION, patchSha256: sha(patch) };
  write(path.join(pkg, 'integrations/pi-web/adapter.patch'), patch);
  write(path.join(pkg, 'integrations/pi-web/adapter-meta.json'), JSON.stringify(meta));
  const native = path.join(root, 'native/pi-web');
  write(native, '#!/usr/bin/env node\nconsole.log(JSON.stringify({launcher:"native",args:process.argv.slice(2)}));\n', 0o755);
  const calls = [];
  let failBuild = false, buildDelay = 0;
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_AGENT_DATA_DIR: path.join(home, 'agent'), PATH: path.dirname(native) + path.delimiter + process.env.PATH };
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd, nodeEnv: options.env?.NODE_ENV, production: options.env?.npm_config_production, home: options.env?.HOME, buildCpuTotal: options.env?.CIRCLE_NODE_TOTAL });
    if (command === 'npm') {
      if (args[0] === 'ci') write(path.join(options.cwd, 'node_modules/next/dist/bin/next'), '// fixture next\n');
      else {
        await delay(buildDelay);
        if (failBuild) throw new Error('fixture build failure');
        write(path.join(options.cwd, '.next/BUILD_ID'), 'fixture-production-build\n');
      }
      return '';
    }
    const adjusted = [...args];
    if (args[0] === 'fetch') {
      assert.equal(args.at(-1), PI_WEB_BASE);
      adjusted[adjusted.indexOf('origin')] = source; adjusted[adjusted.length - 1] = localBase;
    }
    if (args[0] === 'checkout' && args.at(-1) === PI_WEB_BASE) adjusted[adjusted.length - 1] = localBase;
    const output = await runCommand(command, adjusted, { ...options, env });
    if (args[0] === 'rev-parse' && args[1] === 'HEAD' && output === localBase) return PI_WEB_BASE;
    return output;
  };
  const options = { home, env, packageRoot: pkg, run: runner, sharedHostPath: path.join(home, 'absent/host.json') };
  const managed = path.join(home, '.local/share/pi-omnigent-web');
  return { root, home, source, pkg, native, calls, meta, options, managed, setFailure(value) { failBuild = value; }, setDelay(value) { buildDelay = value; } };
}

test('metadata rejects wrong base, version, schema and patch hash before any command', async t => {
  const f = fixture(t);
  for (const change of [{ baseCommit: 'a'.repeat(40) }, { piWebVersion: '0.10.1' }, { schemaVersion: 2 }, { patchSha256: 'a'.repeat(64) }, { repository: 'https://example.invalid/pi-web' }]) {
    write(path.join(f.pkg, 'integrations/pi-web/adapter-meta.json'), JSON.stringify({ ...f.meta, ...change }));
    await assert.rejects(installUi(f.options), { code: 'ADAPTER_METADATA_MISMATCH' });
  }
  assert.equal(f.calls.length, 0);
});

test('existing Paseo UI overlay is preserved alongside the Omnigent patch and participates in cache identity', async t => {
  const f = fixture(t), overlay = path.join(f.root, 'paseo');
  const patch = 'diff --git a/paseo-ui.txt b/paseo-ui.txt\nnew file mode 100644\n--- /dev/null\n+++ b/paseo-ui.txt\n@@ -0,0 +1 @@\n+Paseo preserved\n';
  write(path.join(overlay, 'host/adapter.patch'), patch);
  write(path.join(overlay, 'host/adapter-meta.json'), JSON.stringify({ ...f.meta, patchSha256: sha(patch) }));
  const result = await installUi({ ...f.options, overlayPackageRoot: overlay });
  assert.equal(fs.readFileSync(path.join(result.releaseRoot, 'paseo-ui.txt'), 'utf8'), 'Paseo preserved\n');
  assert.equal(fs.readFileSync(path.join(result.releaseRoot, 'adapter.txt'), 'utf8'), 'paseo adapter\n');
  assert.notEqual(result.patchSha256, f.meta.patchSha256);
  assert.equal((await installUi({ ...f.options, overlayPackageRoot: overlay })).reused, true);
});

test('changed existing UI overlay stops before building or changing any routing', async t => {
  const f = fixture(t), overlay = path.join(f.root, 'paseo');
  write(path.join(overlay, 'host/adapter.patch'), 'unverified bytes');
  write(path.join(overlay, 'host/adapter-meta.json'), JSON.stringify(f.meta));
  await assert.rejects(installUi({ ...f.options, overlayPackageRoot: overlay }), { code: 'EXISTING_UI_OVERLAY_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('pinned fetch builds with dev dependencies; rerun reuses; wrapper preserves args, environment and fallback', async t => {
  const f = fixture(t), first = await installUi(f.options);
  assert.equal(first.restarted, false); assert.equal(first.restartRequired, true);
  assert.equal(first.pendingRestart, path.join(f.managed, 'pi-web/bin/pi-web.js'));
  assert.equal(first.pathUpdateRequired, true);
  assert.equal(first.launcherDirectory, path.join(f.home, '.local/bin'));
  assert.equal(first.routing.previousNative, f.native);
  assert.deepEqual(f.calls.find(c => c.args[0] === 'fetch').args, ['fetch', '--quiet', '--depth=1', 'origin', PI_WEB_BASE]);
  assert.deepEqual(f.calls.find(c => c.args[0] === 'remote').args, ['remote', 'add', 'origin', PI_WEB_REPOSITORY]);
  const ci = f.calls.find(c => c.command === 'npm' && c.args[0] === 'ci');
  assert.ok(ci.args.includes('--include=dev')); assert.equal(ci.nodeEnv, 'development'); assert.equal(ci.production, 'false');
  assert.equal(f.calls.find(c => c.command === 'npm' && c.args[0] === 'run').nodeEnv, 'production');
  assert.equal(f.calls.find(c => c.command === 'npm' && c.args[0] === 'run').buildCpuTotal, '3');
  assert.equal(fs.readFileSync(path.join(first.adapterRoot, 'adapter.txt'), 'utf8'), 'paseo adapter\n');
  const count = f.calls.length, next = await installUi(f.options);
  assert.equal(next.status, 'already-installed'); assert.equal(next.releaseRoot, first.releaseRoot);
  assert.equal(f.calls.slice(count).filter(c => c.command === 'npm' || c.args[0] === 'fetch').length, 0);
  const onPath = await installUi({ ...f.options, env: { ...f.options.env, PATH: first.launcherDirectory + path.delimiter + f.options.env.PATH } });
  assert.equal(onPath.pathUpdateRequired, false);
  const output = JSON.parse(await runCommand(process.execPath, [next.routing.launcher, '--port', '30141', 'argument with spaces'], { env: f.options.env }));
  assert.equal(output.launcher, 'adapter'); assert.deepEqual(output.args, ['--port', '30141', 'argument with spaces']);
  assert.equal(output.home, f.home); assert.equal(output.providerDir, f.options.env.PI_CODING_AGENT_DIR);
  fs.unlinkSync(first.adapterRoot);
  const fallback = JSON.parse(await runCommand(process.execPath, [next.routing.launcher, '--help'], { env: f.options.env }));
  assert.deepEqual(fallback, { launcher: 'native', args: ['--help'] });
});

test('shared-runtime updates only realWeb and its original backup; keeps user launcher bytes', async t => {
  const f = fixture(t), shim = path.join(f.home, '.local/bin/pi-web'), metadata = path.join(f.home, 'shared-runtime/host.json');
  const source = '#!/usr/bin/env node\n// omnigent -> shared-runtime\n';
  write(shim, source, 0o755);
  const old = { realWeb: f.native, shim, root: '/preserved/shared-runtime', installedAt: 'preserved', setting: { tools: ['existing-provider'] } };
  write(metadata, JSON.stringify(old), 0o640);
  const result = await installUi({ ...f.options, sharedHostPath: metadata });
  assert.equal(result.routing.status, 'shared-runtime');
  assert.deepEqual(JSON.parse(fs.readFileSync(metadata)), { ...old, realWeb: result.pendingRestart, realWebBeforeOmnigentUi: f.native });
  assert.equal(fs.readFileSync(shim, 'utf8'), source); assert.equal(fs.statSync(metadata).mode & 0o777, 0o640);
  await installUi({ ...f.options, sharedHostPath: metadata });
  assert.equal(JSON.parse(fs.readFileSync(metadata)).realWebBeforeOmnigentUi, f.native);
});

test('failed build retains previous release and routing; a retry completes cleanly', async t => {
  const f = fixture(t), first = await installUi(f.options), shim = fs.readFileSync(first.routing.launcher, 'utf8');
  // A changed adapter requires a fresh release while the old release remains usable.
  write(path.join(f.pkg, 'integrations/pi-web/adapter.patch'), fs.readFileSync(path.join(f.pkg, 'integrations/pi-web/adapter.patch'), 'utf8') + '\n');
  const meta = { ...f.meta, patchSha256: sha(fs.readFileSync(path.join(f.pkg, 'integrations/pi-web/adapter.patch'))) };
  write(path.join(f.pkg, 'integrations/pi-web/adapter-meta.json'), JSON.stringify(meta)); f.setFailure(true);
  await assert.rejects(installUi(f.options));
  assert.equal(fs.realpathSync(first.adapterRoot), first.releaseRoot);
  assert.equal(fs.readFileSync(first.routing.launcher, 'utf8'), shim);
  assert.equal(fs.readdirSync(path.join(f.managed, 'pi-web-releases')).filter(n => n.startsWith('.build-')).length, 0);
  f.setFailure(false); const next = await installUi(f.options);
  assert.notEqual(next.releaseRoot, first.releaseRoot); assert.ok(fs.existsSync(first.releaseRoot));
});

test('known Omnigent launcher chains through its metadata without replacing the launcher', async t => {
  const f = fixture(t), shim = path.join(f.home, '.local/bin/pi-web');
  const metadata = path.join(f.options.env.PI_CODING_AGENT_DIR, 'omnigent-plugin/host.json');
  const launcher = '#!/usr/bin/env node\n// pi-omnigent-plugin web launcher\n';
  write(shim, launcher, 0o755);
  const original = { version: 1, realWeb: f.native, shim, mode: 'path-wrapper', installedAt: 'preserved' };
  write(metadata, JSON.stringify(original));
  const result = await installUi(f.options);
  assert.equal(result.routing.status, 'omnigent');
  assert.deepEqual(JSON.parse(fs.readFileSync(metadata)), { ...original, realWeb: result.pendingRestart, realWebBeforeOmnigentUi: f.native });
  assert.equal(fs.readFileSync(shim, 'utf8'), launcher);
  await installUi(f.options);
  assert.equal(JSON.parse(fs.readFileSync(metadata)).realWebBeforeOmnigentUi, f.native);
});

test('unmatched Omnigent metadata leaves a foreign launcher intact', async t => {
  const f = fixture(t), shim = path.join(f.home, '.local/bin/pi-web');
  const metadata = path.join(f.options.env.PI_CODING_AGENT_DIR, 'omnigent-plugin/host.json');
  const launcher = '#!/bin/sh\nexec existing-web "$@"\n';
  write(shim, launcher, 0o755);
  const original = JSON.stringify({ version: 1, realWeb: f.native, shim, mode: 'path-wrapper' });
  write(metadata, original);
  const result = await installUi(f.options);
  assert.equal(result.routing.status, 'manual-routing-required');
  assert.equal(fs.readFileSync(shim, 'utf8'), launcher);
  assert.equal(fs.readFileSync(metadata, 'utf8'), original);
});

test('unknown existing launcher stays intact and reports a concrete manual route', async t => {
  const f = fixture(t), shim = path.join(f.home, '.local/bin/pi-web');
  const source = '#!/bin/sh\nexec /existing/wrapper "$@"\n'; write(shim, source, 0o755);
  const result = await installUi(f.options);
  assert.equal(result.routing.status, 'manual-routing-required'); assert.ok(fs.existsSync(result.pendingRestart));
  assert.equal(fs.readFileSync(shim, 'utf8'), source);
});

test('parallel installs serialize publication and build exactly once', async t => {
  const f = fixture(t); f.setDelay(150);
  const results = await Promise.all([installUi(f.options), installUi(f.options)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['already-installed', 'installed']);
  assert.equal(f.calls.filter(c => c.command === 'npm' && c.args[0] === 'ci').length, 1);
  assert.equal(results[0].releaseRoot, results[1].releaseRoot);
});

test('explicit matching prebuiltRoot copies its build without fetch or npm', async t => {
  const f = fixture(t);
  git(f.source, 'apply', path.join(f.pkg, 'integrations/pi-web/adapter.patch'));
  write(path.join(f.source, '.next/BUILD_ID'), 'existing-production-build\n');
  write(path.join(f.source, 'node_modules/next/dist/bin/next'), '// fixture next\n');
  const original = fs.readFileSync(path.join(f.source, 'adapter.txt'), 'utf8');
  const result = await installUi({ ...f.options, prebuiltRoot: f.source });
  assert.equal(f.calls.filter(c => c.command === 'npm' || c.args[0] === 'fetch').length, 0);
  assert.equal(fs.readFileSync(path.join(result.adapterRoot, '.next/BUILD_ID'), 'utf8'), 'existing-production-build\n');
  assert.equal(fs.readFileSync(path.join(f.source, 'adapter.txt'), 'utf8'), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.adapterRoot, '.pi-omnigent-web-install.json'))).prebuilt, true);
});

test('prebuilt source drift fails before routing or publication', async t => {
  const f = fixture(t); git(f.source, 'apply', path.join(f.pkg, 'integrations/pi-web/adapter.patch'));
  write(path.join(f.source, '.next/BUILD_ID'), 'existing-production-build\n');
  write(path.join(f.source, 'node_modules/next/dist/bin/next'), '// fixture next\n');
  write(path.join(f.source, 'bin/pi-web.js'), '// unrelated changes\n');
  await assert.rejects(installUi({ ...f.options, prebuiltRoot: f.source }), { code: 'PREBUILT_SOURCE_MISMATCH' });
  assert.equal(fs.existsSync(path.join(f.managed, 'pi-web')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.local/bin/pi-web')), false);
});

test('unmanaged adapter directory and linked storage are preserved', async t => {
  const f = fixture(t);
  const destination = path.join(f.managed, 'pi-web'); write(path.join(destination, 'user-data'), 'keep');
  await assert.rejects(installUi(f.options), { code: 'UNMANAGED_ADAPTER_PATH' });
  assert.equal(fs.readFileSync(path.join(destination, 'user-data'), 'utf8'), 'keep');
  fs.rmSync(path.join(f.home, '.local'), { recursive: true });
  fs.symlinkSync(f.source, path.join(f.home, '.local'), 'dir');
  await assert.rejects(installUi(f.options), { code: 'UNSAFE_INSTALL_PATH' });
  assert.equal(f.calls.length, 0);
});

test('child failure never includes stderr or external credentials', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stderr.write("credential-sentinel");process.exit(7)']), error => {
    assert.equal(error.code, 'COMMAND_FAILED'); assert.ok(!String(error).includes('credential-sentinel')); return true;
  });
});
