import path from 'node:path';

export const MAINTENANCE_AFTER_SHA256 = '68f4c2a3c0a3aa75436a15828e325bd279995435d83931d93b12516cca303962';
const failure = () => ({ ok: false, code: 'MAINTENANCE_PRESERVATION_REQUIRED' });

/** Use only the selected SDK's Python; never import SDK to find site-packages. */
export async function ensureMaintenance(entry, { stateDir, env, run }) {
  if (!entry?.available || !path.isAbsolute(entry.python || '') || !path.isAbsolute(entry.path || '')
      || !path.isAbsolute(stateDir || '') || typeof run !== 'function') return failure();
  try {
    const response = await run(entry.python, ['-I', '-B', path.join(import.meta.dirname, 'maintenance_preservation.py'),
      '--omnigent-bin', entry.path, '--state-dir', stateDir], { env, timeoutMs: 30_000 });
    if (response?.code !== 0 || response.error) return failure();
    const value = JSON.parse(response.stdout);
    if (value?.schema !== 'plugin-native-maintenance-preservation/v2' || value.ok !== true
        || !['applied', 'verified'].includes(value.state) || value.sourceSha256 !== MAINTENANCE_AFTER_SHA256
        || value.sdkImported !== false || !path.isAbsolute(value.purelib || '')
        || value.distribution !== 'omnigent' || value.coreVersion !== '0.16.0'
        || value.consoleEntryPoint !== 'omnigent.cli:main' || value.consoleScriptValidated !== true
        || value.pythonExecutable !== entry.python || !path.isAbsolute(value.consoleScript || '')
        || !/^[a-f0-9]{64}$/.test(value.consoleScriptSha256 || '')) return failure();
    return { ok: true, state: value.state, sourceSha256: value.sourceSha256, coreVersion: value.coreVersion,
      consoleScriptValidated: true };
  } catch { return failure(); }
}
