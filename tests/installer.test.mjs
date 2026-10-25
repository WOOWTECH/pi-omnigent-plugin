import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEPENDENCY_VERSIONS, discover, installDependencies, runtimeEnv, runCommand } from '../src/installer.mjs';

function available(name, version, directory = '/image/bin') {
  return { available: true, path: path.join(directory, name), version };
}
function absent() { return { available: false, path: null }; }
function complete() {
  return {
    omnigent: { ...available('omnigent', '0.16.0', '/usr/local/bin'), python: '/opt/omnigent/venv/bin/python' },
    claude: available('claude', '2.1.0'), codex: available('codex', '0.100.0'), pi: available('pi', '0.70.0'),
    uv: available('uv', '0.9.0'), python: available('python3', '3.12.0'),
    tmux: available('tmux', '3.3a'), bwrap: available('bwrap', '0.11.0'),
    node: available('node', '22.20.0'), npm: available('npm', '10.9.0'),
  };
}
async function isolated(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-omnigent-installer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function options(directory, overrides = {}) {
  return { stateDir: directory, home: path.join(directory, 'home'), env: { PATH: '/image/bin', SAFE: 'preserved' }, platform: 'linux', arch: 'x64', ...overrides };
}

test('coalesces version probes, expires them, and detects replaced or removed binaries immediately', async t => {
  const directory = await isolated(t);
  const binary = path.join(directory, 'claude');
  await writeFile(binary, 'first', { mode: 0o700 });
  let clock = 0, probes = 0;
  const run = async command => {
    if (command === binary) { probes++; await new Promise(resolve => setTimeout(resolve, 10)); }
    return { code: 0, stdout: '1.0.0', stderr: '' };
  };
  const env = { HOME: directory, PATH: directory, PI_OMNIGENT_BIN: path.join(directory, 'missing') };
  const options = { run, now: () => clock, cacheMs: 100 };
  const first = await Promise.all([discover(env, options), discover(env, options)]);
  assert.equal(probes, 1); assert.equal(first[0].claude.available, true);
  first[0].claude.version = 'mutated';
  assert.equal((await discover(env, options)).claude.version, '1.0.0');
  clock = 101;
  await discover(env, options); assert.equal(probes, 2);
  await writeFile(binary, 'replacement is a different size');
  await discover(env, options); assert.equal(probes, 3);
  await rm(binary);
  assert.equal((await discover(env, options)).claude.available, false);
});

test('preserves all existing image/global CLIs even when update is requested', async t => {
  const directory = await isolated(t);
  let runs = 0;
  const original = complete();
  const result = await installDependencies(options(directory, {
    update: true, discover: async () => original,
    run: async () => { runs++; throw new Error('existing installations must not be touched'); },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(runs, 0);
  assert.equal(result.omnigent.path, '/usr/local/bin/omnigent');
  assert.equal(result.omnigent.python, '/opt/omnigent/venv/bin/python');
  assert.deepEqual(result.installed, []);
  assert.equal(original.pi.version, '0.70.0');
});

test('installs only missing Omnigent with exact argv and leaves absent engines untouched', async t => {
  const directory = await isolated(t);
  const snapshot = complete();
  for (const name of ['omnigent', 'claude', 'codex', 'pi', 'tmux', 'bwrap', 'node', 'npm']) snapshot[name] = absent();
  const calls = [];
  const result = await installDependencies(options(directory, {
    discover: async () => structuredClone(snapshot),
    run: async (command, args, settings) => {
      calls.push({ command, args, settings });
      snapshot.omnigent = available('omnigent', DEPENDENCY_VERSIONS.omnigent, path.join(directory, 'bin'));
      return { code: 0, stdout: '', stderr: '' };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.installed, ['omnigent']);
  assert.deepEqual(result.installedEngines, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/image/bin/uv');
  assert.deepEqual(calls[0].args, ['tool', 'install', '--python', '3.12', 'omnigent==0.16.0']);
  assert.equal(calls[0].settings.env.UV_CACHE_DIR, path.join(directory, 'uv-cache'));
  assert.equal(calls[0].settings.env.UV_TOOL_DIR, path.join(directory, 'uv', 'tools'));
  assert.equal(calls[0].settings.env.UV_TOOL_BIN_DIR, path.join(directory, 'bin'));
  assert.equal(calls[0].settings.env.UV_PYTHON_INSTALL_DIR, path.join(directory, 'python'));
  for (const name of ['claude', 'codex', 'pi']) assert.equal(result[name].available, false);
  assert.deepEqual(result.steps.map(step => step.status), ['started', 'completed']);
});

test('preserves installed engine versions and paths even in a managed directory on update', async t => {
  const directory = await isolated(t);
  const snapshot = complete();
  snapshot.codex = available('codex', '0.99.0', path.join(directory, 'node', 'node_modules', '.bin'));
  snapshot.pi = available('pi', '0.70.0', path.join(directory, 'bin'));
  const result = await installDependencies(options(directory, {
    update: true, discover: async () => structuredClone(snapshot),
    run: async () => { assert.fail('installed engine versions must never be managed or updated'); },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.installedEngines, ['claude', 'codex', 'pi']);
  assert.equal(result.codex.version, '0.99.0');
  assert.equal(result.codex.path, snapshot.codex.path);
  assert.equal(result.pi.version, '0.70.0');
});

test('uses uv force only for a managed Omnigent update', async t => {
  const directory = await isolated(t);
  const snapshot = complete();
  snapshot.omnigent = available('omnigent', '0.15.0', path.join(directory, 'bin'));
  const calls = [];
  const result = await installDependencies(options(directory, {
    update: true, discover: async () => structuredClone(snapshot),
    run: async (command, args) => { calls.push({ command, args }); snapshot.omnigent.version = '0.16.0'; return { code: 0 }; },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0].args, ['tool', 'install', '--python', '3.12', '--force', 'omnigent==0.16.0']);
});

test('rejects shell syntax and nonexact versions before discovery or execution', async t => {
  const directory = await isolated(t);
  for (const [key, value] of [
    ['PI_OMNIGENT_VERSION', '0.16.0; touch /tmp/injected'],
    ['PI_OMNIGENT_VERSION', '$(id)'],
    ['PI_OMNIGENT_UV_VERSION', '0.12.10; id'],
  ]) {
    const result = await installDependencies(options(directory, {
      env: { PATH: '/image/bin', [key]: value },
      discover: async () => { assert.fail('invalid version must not start discovery'); },
      run: async () => { assert.fail('invalid version must not execute an installer'); },
    }));
    assert.equal(result.ok, false);
    assert.match(result.issues[0], /must be an exact version/);
    assert.ok(!result.issues[0].includes(value));
  }
});

test('accepts a safe exact custom Omnigent version', async t => {
  const directory = await isolated(t);
  const snapshot = complete();
  snapshot.omnigent = absent();
  let received;
  const result = await installDependencies(options(directory, {
    env: { PATH: '/image/bin', PI_OMNIGENT_VERSION: '0.17.1' },
    discover: async () => structuredClone(snapshot),
    run: async (command, args) => { received = args; snapshot.omnigent = available('omnigent', '0.17.1', path.join(directory, 'bin')); return { code: 0 }; },
  }));
  assert.equal(result.ok, true);
  assert.equal(received.at(-1), 'omnigent==0.17.1');
});

test('missing uv and Python report an actionable prerequisite without shell fallback', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), omnigent: absent(), uv: absent(), python: absent() };
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot,
    run: async () => { assert.fail('no curl or shell fallback is allowed'); },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.omnigent.available, false);
  assert.match(result.issues[0], /Python >=3.8 with pip is required/);
});

test('a failed Omnigent install cannot report success or disclose raw output', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), omnigent: absent() };
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot,
    run: async () => ({ code: 1, stdout: 'server password: secret-output', stderr: 'registry token: secret-output' }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.omnigent.available, false);
  assert.deepEqual(result.installed, []);
  assert.equal(result.steps.at(-1).status, 'failed');
  assert.ok(!JSON.stringify(result).includes('secret-output'));
});

test('successful command without a discovered Omnigent executable is still a failed installation', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), omnigent: absent() };
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot, run: async () => ({ code: 0 }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.omnigent.available, false);
  assert.deepEqual(result.installed, []);
  assert.match(result.issues[0], /managed Omnigent executable is unavailable/);
});

test('rejects unsupported operating systems or architectures without discovery or installations', async t => {
  const directory = await isolated(t);
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'ia32']]) {
    const result = await installDependencies(options(directory, {
      platform, arch,
      discover: async () => { assert.fail('unsupported platform must not probe or install'); },
      run: async () => { assert.fail('unsupported platform must not execute'); },
    }));
    assert.equal(result.ok, false);
    assert.match(result.issues[0], /requires a Linux x64 or arm64 container/);
  }
});

test('old tmux blocks initialization while missing bwrap is reported as an optional capability', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), tmux: available('tmux', '3.2a'), bwrap: absent() };
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot, run: async () => { assert.fail('system dependencies must not be installed'); },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /tmux >=3.3/);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /bubblewrap/);
});

test('connects only currently installed engines and never invokes npm for absent engines', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), codex: absent(), pi: absent(), node: absent(), npm: absent() };
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot,
    run: async () => { assert.fail('agent engines are discovery-only; npm must never execute'); },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.installedEngines, ['claude']);
  assert.equal(result.claude.version, '2.1.0');
  assert.equal(result.codex.available, false);
  assert.equal(result.pi.available, false);
  assert.deepEqual(result.installed, []);
});

test('builds runtime PATH without changing the engine search order or mutating the input environment', () => {
  const input = { PATH: '/original/bin:/image/bin', SAFE: 'unchanged', PI_OMNIGENT_STATE_DIR: '/plugin/state' };
  const output = runtimeEnv(complete(), input);
  assert.equal(output.PATH.split(path.delimiter)[0], '/original/bin');
  assert.ok(output.PATH.includes('/plugin/state/bin'));
  assert.ok(output.PATH.includes('/plugin/state/bootstrap/bin'));
  assert.equal(output.PI_OMNIGENT_PYTHON, '/opt/omnigent/venv/bin/python');
  assert.equal(output.SAFE, 'unchanged');
  assert.equal(input.PATH, '/original/bin:/image/bin');
  assert.equal(input.PI_OMNIGENT_PYTHON, undefined);
  assert.equal(new Set(output.PATH.split(path.delimiter)).size, output.PATH.split(path.delimiter).length);
});

test('the adapter executes the same engine that discovery found when Omnigent lives elsewhere', async t => {
  const directory = await isolated(t);
  const userBin = path.join(directory, 'user-bin'), imageBin = path.join(directory, 'image-bin');
  await mkdir(userBin); await mkdir(imageBin);
  for (const [bin, name, version] of [[userBin, 'claude', '2.1.292'], [imageBin, 'claude', '2.1.296'], [imageBin, 'omnigent', '0.16.0']]) {
    await writeFile(path.join(bin, name), `#!${process.execPath}\nprocess.stdout.write('${name} ${version}');\n`, { mode: 0o700 });
  }
  const env = { HOME: directory, PATH: [userBin, imageBin].join(path.delimiter), PI_OMNIGENT_BIN: path.join(imageBin, 'omnigent') };
  const found = await discover(env);
  assert.equal(found.claude.version, '2.1.292');
  const executed = await runCommand('claude', ['--version'], { env: runtimeEnv(found, env) });
  assert.equal(executed.stdout, 'claude 2.1.292');
});

test('runCommand passes special characters as literal argv instead of executing a shell', async t => {
  const directory = await isolated(t);
  const marker = path.join(directory, 'injected');
  const literal = `$(touch ${marker}); echo injected`;
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal], { timeoutMs: 5_000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, literal);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});


test('discovers explicit custom binaries in parallel and finds embedded Omnigent Python', async t => {
  const directory = await isolated(t);
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  for (const [name, version] of Object.entries({ omnigent: '0.16.0', claude: '2.1.296', codex: '0.162.1', pi: '1.1.0', uv: '0.9.0', python: '3.12.0', python3: '3.12.0', tmux: '3.3a', bwrap: '0.11.0', npm: '10.9.0' })) {
    await writeFile(path.join(bin, name), `#!${process.execPath}\nprocess.stdout.write('${name} ${version}');\n`, { mode: 0o700 });
  }
  const input = { PATH: bin, HOME: directory, PI_OMNIGENT_BIN: path.join(bin, 'omnigent') };
  const result = await discover(input);
  for (const name of ['omnigent', 'claude', 'codex', 'pi', 'uv', 'python', 'tmux', 'bwrap', 'npm', 'node']) assert.equal(result[name].available, true, `${name} must be discovered`);
  assert.equal(result.omnigent.version, '0.16.0');
  assert.equal(result.omnigent.python, path.join(bin, 'python'));
  assert.equal(result.codex.path, path.join(bin, 'codex'));
  assert.equal(result.tmux.version, '3.3a');
  assert.equal(input.PATH, bin);
});

test('does not treat a directory on PATH as an executable', async t => {
  const directory = await isolated(t);
  await mkdir(path.join(directory, 'bwrap'));
  const result = await discover({ PATH: directory, HOME: directory });
  assert.equal(result.bwrap.available, false);
  assert.equal(result.bwrap.path, null);
});


test('missing bwrap does not block native sessions or alter sandbox settings', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), bwrap: absent() };
  const result = await installDependencies(options(directory, {
    env: { PATH: '/image/bin', OMNIGENT_SANDBOX_TYPE: 'bubblewrap' },
    discover: async env => { assert.equal(env.OMNIGENT_SANDBOX_TYPE, 'bubblewrap'); return snapshot; },
    run: async () => { assert.fail('optional bwrap must not trigger system installation'); },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.bwrap.available, false);
  assert.match(result.warnings[0], /bubblewrap/);
});

test('defaults managed dependencies to the configured Pi agent directory', async t => {
  const directory = await isolated(t);
  let discovered;
  const result = await installDependencies({
    home: directory, env: { PATH: '/image/bin', PI_CODING_AGENT_DIR: path.join(directory, 'custom-agent') },
    discover: async env => { discovered = env; return complete(); },
    run: async () => { assert.fail('existing dependencies must not trigger installation'); },
    platform: 'linux', arch: 'arm64',
  });
  assert.equal(result.ok, true);
  assert.equal(discovered.PI_OMNIGENT_STATE_DIR, path.join(directory, 'custom-agent', 'omnigent-plugin'));
});


test('bootstraps pinned uv with Python pip into the plugin directory before installing Omnigent', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), omnigent: absent(), uv: absent() };
  const calls = [];
  const result = await installDependencies(options(directory, {
    discover: async () => structuredClone(snapshot),
    run: async (command, args, settings) => {
      calls.push({ command, args, settings });
      if (args[0] === '-m' && args[2] === 'install') snapshot.uv = available('uv', '0.12.10', path.join(directory, 'bootstrap', 'bin'));
      else if (args[0] === 'tool') snapshot.omnigent = available('omnigent', '0.16.0', path.join(directory, 'bin'));
      return { code: 0 };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.installed, ['uv', 'omnigent']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, '/image/bin/python3');
  assert.deepEqual(calls[0].args, ['-m', 'pip', '--version']);
  assert.equal(calls[1].command, '/image/bin/python3');
  assert.deepEqual(calls[1].args, ['-m', 'pip', 'install', '--target', path.join(directory, 'bootstrap'), '--no-cache-dir', '--disable-pip-version-check', 'uv==0.12.10']);
  assert.equal(calls[1].settings.cwd, directory);
  assert.equal(calls[1].settings.env.PIP_NO_INPUT, '1');
  assert.equal(calls[1].settings.env.PIP_DISABLE_PIP_VERSION_CHECK, '1');
  assert.equal(calls[2].command, path.join(directory, 'bootstrap', 'bin', 'uv'));
  assert.deepEqual(calls[2].args, ['tool', 'install', '--python', '3.12', 'omnigent==0.16.0']);
  assert.ok(calls[2].settings.env.PATH.includes(path.join(directory, 'bootstrap', 'bin')));
  assert.deepEqual(result.steps.map(step => [step.dependency, step.status]), [['uv', 'started'], ['uv', 'completed'], ['omnigent', 'started'], ['omnigent', 'completed']]);
});

test('uses a validated exact custom uv bootstrap version', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), omnigent: absent(), uv: absent() };
  let received;
  const result = await installDependencies(options(directory, {
    env: { PATH: '/image/bin', PI_OMNIGENT_UV_VERSION: '0.13.0' },
    discover: async () => structuredClone(snapshot),
    run: async (command, args) => {
      if (args[2] === 'install') { received = args; snapshot.uv = available('uv', '0.13.0', path.join(directory, 'bootstrap', 'bin')); }
      else if (args[0] === 'tool') snapshot.omnigent = available('omnigent', '0.16.0', path.join(directory, 'bin'));
      return { code: 0 };
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(received.at(-1), 'uv==0.13.0');
});

test('reports missing pip without attempting installation or returning fake uv success', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), omnigent: absent(), uv: absent() };
  const calls = [];
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot,
    run: async (command, args) => { calls.push(args); return { code: 1, stderr: 'private token must not appear' }; },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.deepEqual(calls, [['-m', 'pip', '--version']]);
  assert.deepEqual(result.installed, []);
  assert.equal(result.uv.available, false);
  assert.equal(result.omnigent.available, false);
  assert.match(result.issues[0], /pip is unavailable/);
  assert.ok(!JSON.stringify(result).includes('private token'));
});

test('failed pip bootstrap keeps uv unavailable and does not expose raw package-manager output', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), omnigent: absent(), uv: absent() };
  const calls = [];
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot,
    run: async (command, args) => {
      calls.push(args);
      return args[2] === 'install' ? { code: 1, stdout: 'secret credential', stderr: 'secret credential' } : { code: 0 };
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.installed, []);
  assert.equal(result.uv.available, false);
  assert.equal(result.omnigent.available, false);
  assert.match(result.issues[0], /managed uv bootstrap failed/);
  assert.ok(!JSON.stringify(result).includes('secret credential'));
  assert.deepEqual(result.steps.map(step => step.status), ['started', 'failed', 'blocked']);
});

test('pip success without a discovered uv executable does not start Omnigent installation', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), omnigent: absent(), uv: absent() };
  const calls = [];
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot,
    run: async (command, args) => { calls.push(args); return { code: 0 }; },
  }));
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
  assert.equal(result.uv.available, false);
  assert.deepEqual(result.installed, []);
  assert.match(result.issues[0], /managed uv executable is unavailable/);
});

test('Python below the supported uv bootstrap version blocks pip execution', async t => {
  const directory = await isolated(t);
  const snapshot = { ...complete(), omnigent: absent(), uv: absent(), python: available('python3', '3.7.17') };
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot,
    run: async () => { assert.fail('Python 3.7 cannot bootstrap this uv release'); },
  }));
  assert.equal(result.ok, false);
  assert.match(result.issues[0], /Python >=3.8/);
});

test('existing Omnigent and uv never trigger a pip bootstrap or global upgrade', async t => {
  const directory = await isolated(t);
  const result = await installDependencies(options(directory, {
    update: true, discover: async () => complete(),
    run: async () => { assert.fail('image uv and Omnigent must be preserved'); },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.uv.path, '/image/bin/uv');
  assert.deepEqual(result.installed, []);
});

test('discovers a managed pip-target uv binary on a subsequent invocation', async t => {
  const directory = await isolated(t);
  const bin = path.join(directory, 'bootstrap', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'uv'), `#!${process.execPath}\nprocess.stdout.write('uv 0.12.10');\n`, { mode: 0o700 });
  const result = await discover({ PATH: '/unavailable', HOME: directory, PI_OMNIGENT_STATE_DIR: directory });
  assert.equal(result.uv.available, true);
  assert.equal(result.uv.version, '0.12.10');
  assert.equal(result.uv.path, path.join(bin, 'uv'));
});


test('no installed engine is an acceptable installer state without tmux or bwrap', async t => {
  const directory = await isolated(t);
  const snapshot = complete();
  for (const name of ['claude', 'codex', 'pi', 'tmux', 'bwrap', 'node', 'npm']) snapshot[name] = absent();
  const result = await installDependencies(options(directory, {
    discover: async () => snapshot,
    run: async () => { assert.fail('missing agent engines must not trigger package downloads'); },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.installedEngines, []);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.installed, []);
});

test('obsolete engine version override values are ignored rather than imposing install requirements', async t => {
  const directory = await isolated(t);
  const result = await installDependencies(options(directory, {
    env: { PATH: '/image/bin', PI_OMNIGENT_CLAUDE_VERSION: 'latest', PI_OMNIGENT_CODEX_VERSION: '^0.1', PI_OMNIGENT_PI_VERSION: 'not-a-version' },
    discover: async () => complete(),
    run: async () => { assert.fail('engine pins must not control installer behavior'); },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.installedEngines, ['claude', 'codex', 'pi']);
});
