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
  write(path.join(pkg, 'package.json'), JSON.stringify({ name: '@woowtech/pi-omnigent-plugin', version: '0.3.1' }));
  write(path.join(pkg, 'integrations/pi-web/adapter.patch'), patch);
  write(path.join(pkg, 'integrations/pi-web/adapter-meta.json'), JSON.stringify(meta));
  const native = path.join(root, 'native/pi-web');
  write(native, '#!/usr/bin/env node\nconsole.log(JSON.stringify({launcher:"native",args:process.argv.slice(2)}));\n', 0o755);
  const calls = [];
  let failBuild = false, failAudit = false, buildDelay = 0;
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_AGENT_DATA_DIR: path.join(home, 'agent'), PATH: path.dirname(native) + path.delimiter + process.env.PATH };
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd, nodeEnv: options.env?.NODE_ENV, production: options.env?.npm_config_production, home: options.env?.HOME, buildCpuTotal: options.env?.CIRCLE_NODE_TOTAL, npmCache: options.env?.npm_config_cache, upperNpmCache: options.env?.NPM_CONFIG_CACHE, stage: options.stage });
    if (command === 'npm') {
      if (args[0] === 'ci') write(path.join(options.cwd, 'node_modules/next/dist/bin/next'), '// fixture next\n');
      else if (args[0] === 'audit') {
        if (failAudit) throw new Error('fixture audit failure');
      }
      else {
        await delay(buildDelay);
        if (failBuild) throw new Error('fixture build failure');
        write(path.join(options.cwd, '.next/BUILD_ID'), 'fixture-production-build\n');
        write(path.join(options.cwd, '.next/cache/webpack/build.pack'), 'discard build cache\n');
        write(path.join(options.cwd, '.next/server/app/index.html'), 'keep runtime output\n');
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
  return { root, home, source, pkg, native, calls, meta, options, managed, setFailure(value) { failBuild = value; }, setAuditFailure(value) { failAudit = value; }, setDelay(value) { buildDelay = value; } };
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

test('pinned combined adapter installs the Omnigent and Paseo settings tabs as one reproducible build', async t => {
  const f = fixture(t), overlay = path.join(f.root, 'paseo');
  const paseoPatch = 'paseo contribution';
  const combinedPatch = [
    'diff --git a/combined-adapter.txt b/combined-adapter.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/combined-adapter.txt',
    '@@ -0,0 +1 @@',
    '+Omnigent + Paseo',
    '',
  ].join('\n');
  write(path.join(overlay, 'package.json'), JSON.stringify({ name: '@woowtech/pi-paseo', version: '0.1.3' }));
  write(path.join(overlay, 'host/adapter.patch'), paseoPatch);
  write(path.join(overlay, 'host/adapter-meta.json'), JSON.stringify({ ...f.meta, patchSha256: sha(paseoPatch) }));
  write(path.join(f.pkg, 'integrations/pi-web/combined.adapter.patch'), combinedPatch);
  write(path.join(f.pkg, 'integrations/pi-web/combined.adapter-meta.json'), JSON.stringify({
    schemaVersion: 1, repository: PI_WEB_REPOSITORY, baseCommit: PI_WEB_BASE, piWebVersion: PI_WEB_VERSION,
    paseo: { packageName: '@woowtech/pi-paseo', packageVersion: '0.1.3', adapterPatchSha256: sha(paseoPatch) },
    omnigent: { packageName: '@woowtech/pi-omnigent-plugin', packageVersion: '0.3.1', adapterPatchSha256: f.meta.patchSha256 },
    patchSha256: sha(combinedPatch), settingsSections: ['mcp', 'omnigent', 'paseo'],
    contributors: ['@woowtech/pi-paseo', '@woowtech/pi-omnigent-plugin'],
  }));

  const result = await installUi({ ...f.options, overlayPackageRoot: overlay });
  assert.equal(result.composition, 'omnigent+paseo');
  assert.deepEqual(result.contributors, ['@woowtech/pi-paseo', '@woowtech/pi-omnigent-plugin']);
  assert.deepEqual(result.settingsSections, ['mcp', 'omnigent', 'paseo']);
  assert.equal(fs.readFileSync(path.join(result.releaseRoot, 'combined-adapter.txt'), 'utf8'), 'Omnigent + Paseo\n');
  assert.equal(fs.readFileSync(path.join(result.releaseRoot, 'adapter.txt'), 'utf8'), 'base\n');
  const receipt = JSON.parse(fs.readFileSync(path.join(result.releaseRoot, '.pi-omnigent-web-install.json')));
  assert.equal(receipt.composition, 'omnigent+paseo');
  assert.deepEqual(receipt.settingsSections, ['mcp', 'omnigent', 'paseo']);
  assert.equal((await installUi({ ...f.options, overlayPackageRoot: overlay })).reused, true);
});

test('combined adapter metadata rejects stale contributor patches before any command', async t => {
  const f = fixture(t), overlay = path.join(f.root, 'paseo');
  write(path.join(overlay, 'package.json'), JSON.stringify({ name: '@woowtech/pi-paseo', version: '0.1.3' }));
  const paseoPatch = 'paseo contribution'; write(path.join(overlay, 'host/adapter.patch'), paseoPatch);
  write(path.join(overlay, 'host/adapter-meta.json'), JSON.stringify({ ...f.meta, patchSha256: sha(paseoPatch) }));
  write(path.join(f.pkg, 'integrations/pi-web/combined.adapter.patch'), 'bad patch');
  write(path.join(f.pkg, 'integrations/pi-web/combined.adapter-meta.json'), JSON.stringify({ schemaVersion: 1 }));
  await assert.rejects(installUi({ ...f.options, overlayPackageRoot: overlay }), { code: 'COMBINED_ADAPTER_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('changed existing UI overlay stops before building or changing any routing', async t => {
  const f = fixture(t), overlay = path.join(f.root, 'paseo');
  write(path.join(overlay, 'host/adapter.patch'), 'unverified bytes');
  write(path.join(overlay, 'host/adapter-meta.json'), JSON.stringify(f.meta));
  await assert.rejects(installUi({ ...f.options, overlayPackageRoot: overlay }), { code: 'EXISTING_UI_OVERLAY_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('a live combined UI is preserved when its Paseo overlay package is missing', async t => {
  const f = fixture(t); const first = await installUi(f.options);
  const route = path.join(first.releaseRoot, 'app/api/plugin-paseo/route.ts');
  write(route, '// existing Paseo integration\n');
  const before = fs.realpathSync(first.adapterRoot);
  await assert.rejects(installUi(f.options), { code: 'EXISTING_UI_OVERLAY_MISSING' });
  assert.equal(fs.realpathSync(first.adapterRoot), before);
  assert.equal(fs.readFileSync(route, 'utf8'), '// existing Paseo integration\n');
});

test('build overrides inherited npm caches with a private writable home directory', async t => {
  const f = fixture(t);
  await installUi({ ...f.options, env: { ...f.options.env, npm_config_cache: '/root/unwritable-cache', NPM_CONFIG_CACHE: '/tmp/root-owned-cache' } });
  const cache = path.join(f.managed, 'npm-cache');
  for (const call of f.calls.filter(c => c.command === 'npm')) {
    assert.equal(call.npmCache, cache);
    assert.equal(call.upperNpmCache, cache);
  }
  assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
  fs.accessSync(cache, fs.constants.W_OK);
});

test('a high-severity dependency audit failure prevents publishing a native UI release', async t => {
  const f = fixture(t); f.setAuditFailure(true);
  await assert.rejects(installUi(f.options));
  assert.equal(f.calls.some(c => c.command === 'npm' && c.args[0] === 'audit'), true);
  assert.equal(f.calls.some(c => c.command === 'npm' && c.args[0] === 'run'), false);
  assert.equal(fs.existsSync(path.join(f.managed, 'pi-web')), false);
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
  assert.equal(ci.stage, 'dependencies');
  assert.equal(f.calls.find(c => c.command === 'npm' && c.args[0] === 'audit').stage, 'audit');
  assert.equal(f.calls.find(c => c.command === 'npm' && c.args[0] === 'run').stage, 'build');
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
  write(path.join(f.source, '.next/cache/user-cache'), 'preserve source cache');
  write(path.join(f.source, 'node_modules/next/dist/bin/next'), '// fixture next\n');
  const original = fs.readFileSync(path.join(f.source, 'adapter.txt'), 'utf8');
  const result = await installUi({ ...f.options, prebuiltRoot: f.source });
  assert.equal(f.calls.filter(c => c.command === 'npm' || c.args[0] === 'fetch').length, 0);
  assert.equal(fs.readFileSync(path.join(result.adapterRoot, '.next/BUILD_ID'), 'utf8'), 'existing-production-build\n');
  assert.equal(fs.readFileSync(path.join(f.source, 'adapter.txt'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(result.adapterRoot, '.next/cache')), false);
  assert.equal(fs.readFileSync(path.join(f.source, '.next/cache/user-cache'), 'utf8'), 'preserve source cache');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.adapterRoot, '.pi-omnigent-web-install.json'))).prebuilt, true);
});

test('a managed installed release can be reused as prebuiltRoot without rebuilding', async t => {
  const f = fixture(t), first = await installUi(f.options);
  const home = path.join(f.root, 'upgrade-home'); fs.mkdirSync(home);
  const env = { ...f.options.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_AGENT_DATA_DIR: path.join(home, 'agent') };
  const before = f.calls.length;
  const result = await installUi({ ...f.options, home, env, sharedHostPath: path.join(home, 'absent/host.json'), prebuiltRoot: first.adapterRoot });
  assert.equal(f.calls.slice(before).filter(c => c.command === 'npm' || c.args[0] === 'fetch').length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.adapterRoot, '.pi-omnigent-web-install.json'))).prebuilt, true);
  assert.equal(fs.readFileSync(path.join(result.adapterRoot, '.next/BUILD_ID'), 'utf8'),
               fs.readFileSync(path.join(first.adapterRoot, '.next/BUILD_ID'), 'utf8'));
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

test('resource failures expose only a fixed code and stage, never child output or arguments', async () => {
  for (const [errno, code] of [['ENOSPC', 'INSTALL_DISK_FULL'], ['EDQUOT', 'INSTALL_DISK_FULL'], ['EACCES', 'INSTALL_PERMISSION_DENIED'], ['EPERM', 'INSTALL_PERMISSION_DENIED'], ['ENOMEM', 'INSTALL_MEMORY_EXHAUSTED']]) {
    const script = `process.stdout.write('stdout-secret');process.stderr.write('npm error code ${errno}\\nhttps://user:password-secret@example.invalid/private-path\\n');process.exit(1)`;
    await assert.rejects(runCommand(process.execPath, ['-e', script, 'argument-secret'], { stage: 'dependencies' }), error => {
      assert.equal(error.name, 'UiInstallError');
      assert.equal(error.code, code);
      assert.equal(error.stage, 'dependencies');
      assert.equal(error.message, code);
      assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'stage']);
      const exposed = JSON.stringify(error) + String(error) + error.stack;
      for (const secret of ['stdout-secret', 'password-secret', 'private-path', 'argument-secret', script]) assert.ok(!exposed.includes(secret));
      return true;
    });
  }
});

test('resource detection spans stderr chunks and drains large output without retaining it', async () => {
  const script = `process.stderr.write('secret-noise'.repeat(800000));process.stderr.write('\\nnpm error code EN');setTimeout(()=>{process.stderr.write('OSPC\\nsecret-tail');process.exitCode=1},25)`;
  await assert.rejects(runCommand(process.execPath, ['-e', script], { stage: 'dependencies' }), { code: 'INSTALL_DISK_FULL', stage: 'dependencies' });
});

test('resource diagnostics support stdout errors, while success retains its original contract', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.log("Error: ENOMEM: allocation failed");process.exitCode=1'], { stage: 'build' }), { code: 'INSTALL_MEMORY_EXHAUSTED', stage: 'build' });
  assert.equal(await runCommand(process.execPath, ['-e', 'console.log("ENOSPC");console.error("npm error code ENOSPC")']), 'ENOSPC');
});

test('unknown failures and untrusted stage labels remain generic without leaking credentials', async () => {
  const stage = 'stage-secret https://user:password@example.invalid';
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.error("npm error code UNKNOWN_SECRET\\ncredential-secret");process.exit(1)'], { stage }), error => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.stage, undefined);
    const exposed = JSON.stringify(error) + String(error) + error.stack;
    for (const secret of [stage, 'UNKNOWN_SECRET', 'credential-secret']) assert.ok(!exposed.includes(secret));
    return true;
  });
});

test('only complete allowlisted errno literals are classified, including at end of stream', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stderr.write("npm error code ENOSPC");process.exitCode=1']), { code: 'INSTALL_DISK_FULL' });
  for (const text of ['npm error code EUNRECOGNIZED', 'npm error code EMFILE', 'npm error code ENOSPC_SUFFIX', 'token-prefix-ENOSPC']) {
    await assert.rejects(runCommand(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(text)});process.exitCode=1`]), { code: 'COMMAND_FAILED' });
  }
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stderr.write("npm error code ENOSPC");setTimeout(()=>{process.stderr.write("_SUFFIX\\n");process.exitCode=1},25)']), { code: 'COMMAND_FAILED' });
});

test('spawn permission errors use the safe resource code without exposing the executable path', async t => {
  const f = fixture(t), denied = path.join(f.root, 'credential-secret-command');
  write(denied, '#!/bin/sh\nexit 0\n', 0o600);
  await assert.rejects(runCommand(denied, ['argument-secret'], { stage: 'source' }), error => {
    assert.equal(error.code, 'INSTALL_PERMISSION_DENIED');
    assert.equal(error.stage, 'source');
    assert.ok(!(JSON.stringify(error) + error.stack).includes('credential-secret-command'));
    assert.ok(!(JSON.stringify(error) + error.stack).includes('argument-secret'));
    return true;
  });
});

test('installer CLI emits only safe diagnostics on a command resource failure', t => {
  const f = fixture(t), fakeBin = path.join(f.root, 'fake-bin');
  write(path.join(fakeBin, 'git'), '#!/usr/bin/env node\nconsole.log("stdout-secret");console.error("npm error code ENOSPC\\nprivate-registry-secret");process.exitCode=1;\n', 0o755);
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/install-ui.mjs')], {
    encoding: 'utf8', env: { ...f.options.env, PATH: fakeBin + path.delimiter + f.options.env.PATH },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { error: 'UiInstallError', code: 'INSTALL_DISK_FULL', stage: 'source' });
});

test('timeouts and missing commands keep their specific generic diagnostics and safe stage', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.error("npm error code ENOSPC");setInterval(()=>{},1000)'], { stage: 'build', timeoutMs: 100 }), { code: 'COMMAND_TIMEOUT', stage: 'build' });
  await assert.rejects(runCommand('/nonexistent/credential-secret-command', ['argument-secret'], { stage: 'source' }), error => {
    assert.equal(error.code, 'COMMAND_UNAVAILABLE');
    assert.equal(error.stage, 'source');
    assert.ok(!(JSON.stringify(error) + error.stack).includes('credential-secret-command'));
    assert.ok(!(JSON.stringify(error) + error.stack).includes('argument-secret'));
    return true;
  });
});

test('npm ci ENOSPC reports dependencies stage and preserves the live release and routing', async t => {
  const f = fixture(t), first = await installUi(f.options);
  const launcher = fs.readFileSync(first.routing.launcher, 'utf8');
  const receiptFile = path.join(f.managed, 'host-install.json'), receipt = fs.readFileSync(receiptFile, 'utf8');
  const patch = fs.readFileSync(path.join(f.pkg, 'integrations/pi-web/adapter.patch'), 'utf8') + '\n';
  write(path.join(f.pkg, 'integrations/pi-web/adapter.patch'), patch);
  write(path.join(f.pkg, 'integrations/pi-web/adapter-meta.json'), JSON.stringify({ ...f.meta, patchSha256: sha(patch) }));
  const run = async (command, args, options) => command === 'npm' && args[0] === 'ci'
    ? runCommand(process.execPath, ['-e', 'console.error("npm error code ENOSPC\\nprivate-registry-secret");process.exitCode=1'], options)
    : f.options.run(command, args, options);
  await assert.rejects(installUi({ ...f.options, run }), { code: 'INSTALL_DISK_FULL', stage: 'dependencies' });
  assert.equal(fs.realpathSync(first.adapterRoot), first.releaseRoot);
  assert.equal(fs.readFileSync(first.routing.launcher, 'utf8'), launcher);
  assert.equal(fs.readFileSync(receiptFile, 'utf8'), receipt);
  assert.equal(fs.readdirSync(path.join(f.managed, 'pi-web-releases')).some(n => n.startsWith('.build-')), false);
});

test('only a newly successful staged build loses its build cache; active and unrelated files remain intact', async t => {
  const f = fixture(t), first = await installUi(f.options);
  assert.equal(fs.existsSync(path.join(first.releaseRoot, '.next/cache')), false);
  assert.equal(fs.readFileSync(path.join(first.releaseRoot, '.next/server/app/index.html'), 'utf8'), 'keep runtime output\n');
  write(path.join(first.releaseRoot, '.next/cache/user-data'), 'keep active cache');
  write(path.join(f.home, '.next/cache/user-data'), 'keep unrelated cache');
  const reused = await installUi(f.options);
  assert.equal(reused.reused, true);
  assert.equal(fs.readFileSync(path.join(first.releaseRoot, '.next/cache/user-data'), 'utf8'), 'keep active cache');
  const patch = fs.readFileSync(path.join(f.pkg, 'integrations/pi-web/adapter.patch'), 'utf8') + '\n';
  write(path.join(f.pkg, 'integrations/pi-web/adapter.patch'), patch);
  write(path.join(f.pkg, 'integrations/pi-web/adapter-meta.json'), JSON.stringify({ ...f.meta, patchSha256: sha(patch) }));
  const next = await installUi(f.options);
  assert.equal(fs.existsSync(path.join(next.releaseRoot, '.next/cache')), false);
  assert.equal(fs.readFileSync(path.join(next.releaseRoot, '.next/server/app/index.html'), 'utf8'), 'keep runtime output\n');
  assert.equal(fs.readFileSync(path.join(first.releaseRoot, '.next/cache/user-data'), 'utf8'), 'keep active cache');
  assert.equal(fs.readFileSync(path.join(f.home, '.next/cache/user-data'), 'utf8'), 'keep unrelated cache');
});

test('staged cache cleanup never follows symlinks into unrelated directories', async t => {
  for (const linkedNext of [false, true]) {
    const f = fixture(t), outside = path.join(f.home, 'unrelated-next');
    write(path.join(outside, '.next/BUILD_ID'), 'external build');
    write(path.join(outside, '.next/cache/user-data'), 'keep unrelated cache');
    const run = async (command, args, options) => {
      const output = await f.options.run(command, args, options);
      if (command === 'npm' && args[0] === 'run') {
        const relative = linkedNext ? '.next' : '.next/cache';
        fs.rmSync(path.join(options.cwd, relative), { recursive: true });
        fs.symlinkSync(path.join(outside, relative), path.join(options.cwd, relative), 'dir');
      }
      return output;
    };
    if (linkedNext) {
      await assert.rejects(installUi({ ...f.options, run }), { code: 'UNSAFE_BUILD_PATH' });
      assert.equal(fs.existsSync(path.join(f.managed, 'pi-web')), false);
    } else {
      const result = await installUi({ ...f.options, run });
      assert.equal(fs.existsSync(path.join(result.releaseRoot, '.next/cache')), false);
    }
    assert.equal(fs.readFileSync(path.join(outside, '.next/cache/user-data'), 'utf8'), 'keep unrelated cache');
  }
});
