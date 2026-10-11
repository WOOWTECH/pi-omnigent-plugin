#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { locations, saveJSON, safeError } from '../src/common.mjs';
import path from 'node:path';
import { initialize, status, catalog, verify, repair, setEnabled, enabled } from '../src/runtime.mjs';
import { ensureOnboarding, installHost, uninstallHost, packageLifecycle, boot, launchWeb } from '../src/web.mjs';
import { installDependencies } from '../src/installer.mjs';

const [command = 'status', ...args] = process.argv.slice(2);
const loc = locations();
function option(name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  if (['verify', 'initialize', 'repair', 'install-dependencies'].includes(command) && value?.ok === false) process.exitCode = 1;
}
try {
  if (command === 'status') print(await status());
  else if (command === 'catalog') print(await catalog());
  else if (command === 'verify') print(await verify({ engine: option('--engine'), model: option('--model') }));
  else if (command === 'initialize' || command === 'repair') {
    // Passwords are collected by the Pi extension's masked component, never argv.
    print(await (command === 'repair' ? repair : initialize)({ server: option('--server'), update: args.includes('--update'), verify: !args.includes('--no-verify') }));
  } else if (command === 'install-dependencies') {
    print(await installDependencies({ home: loc.home, stateDir: loc.stateDir, update: args.includes('--update') }));
  } else if (command === 'install-host') print(await installHost({ loc }));
  else if (command === 'uninstall-host') print(await uninstallHost({ loc }));
  else if (command === 'onboarding') print(await ensureOnboarding({ loc }));
  else if (command === 'boot') {
    if (enabled()) print(await boot({ loc, allowUnregistered: args.includes('--activation-worker') }));
    else print({ phase: 'disabled' });
  } else if (command === 'launch-web') {
    const result = await launchWeb(args, { loc }); process.exitCode = result.code;
  } else if (command === 'enable' || command === 'disable') print(setEnabled(command === 'enable'));
  else if (command === 'activate') {
    if (args.includes('--auto') && process.env.PI_OMNIGENT_SKIP_ACTIVATION === '1') {
      print({ phase: 'activation-skipped' });
    } else {
      const lifecycle = await packageLifecycle({ loc, allowUnregistered: args.includes('--auto') });
      if (!lifecycle.active) { print({ phase: 'inactive', reason: lifecycle.reason }); process.exit(0); }
      const host = await installHost({ loc });
      const onboarding = await ensureOnboarding({ loc });
      saveJSON(path.join(loc.stateDir, 'activation.json'), { activatedAt: new Date().toISOString(), host, onboarding });
      // Pi Web imposes an install timeout. Downloads and server checks run in a
      // separate worker; creating the visible setup conversation stays bounded.
      const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'boot', ...(args.includes('--auto') ? ['--activation-worker'] : [])], { env: process.env, detached: true, stdio: 'ignore' });
      worker.on('error', () => {}); worker.unref();
      print({ phase: 'activated', host, onboarding });
    }
  } else {
    print({ usage: 'pi-omnigent activate | status | catalog | verify [--engine claude|codex|pi] | initialize [--server URL] | repair | install-dependencies | install-host | onboarding | launch-web | enable | disable' });
    process.exitCode = 2;
  }
} catch (error) {
  print({ phase: 'error', error: safeError(error) });
  // Installation should remain available for remediation when first-run setup
  // needs credentials or the host launcher is not available in this process.
  process.exitCode = command === 'activate' && args.includes('--auto') ? 0 : 1;
}
