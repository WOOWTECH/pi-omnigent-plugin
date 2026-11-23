import path from 'node:path';

export const MAINTENANCE_AFTER_SHA256 = '68f4c2a3c0a3aa75436a15828e325bd279995435d83931d93b12516cca303962';
// A reason is a fixed token (the guard's own refusal or one of the fallbacks
// below), never raw guard output, paths or OS messages.
export const MAINTENANCE_REASON = /^[a-z0-9][a-z0-9-]{0,63}$/;
const failure = reason => ({ ok: false, code: 'MAINTENANCE_PRESERVATION_REQUIRED', reason });

function refusalReason(stdout) {
  try {
    const value = JSON.parse(stdout);
    if (value?.ok === false && value.code === 'MAINTENANCE_PRESERVATION_REQUIRED'
        && typeof value.reason === 'string' && MAINTENANCE_REASON.test(value.reason)) return value.reason;
  } catch { /* fall through to the fixed token */ }
  return 'guard-refused';
}

/** Use only the selected SDK's Python; never import SDK to find site-packages. */
export async function ensureMaintenance(entry, { stateDir, env, run }) {
  if (!entry?.available || !path.isAbsolute(entry.python || '') || !path.isAbsolute(entry.path || '')
      || !path.isAbsolute(stateDir || '') || typeof run !== 'function') return failure('guard-not-run');
  try {
    const response = await run(entry.python, ['-I', '-B', path.join(import.meta.dirname, 'maintenance_preservation.py'),
      '--omnigent-bin', entry.path, '--state-dir', stateDir], { env, timeoutMs: 30_000 });
    if (response?.error) return failure('guard-run-failed');
    if (response?.code !== 0) return failure(refusalReason(response?.stdout));
    let value;
    try { value = JSON.parse(response.stdout); } catch { return failure('unexpected-guard-result'); }
    if (value?.schema !== 'plugin-native-maintenance-preservation/v2' || value.ok !== true
        || !['applied', 'verified'].includes(value.state) || value.sourceSha256 !== MAINTENANCE_AFTER_SHA256
        || value.sdkImported !== false || !path.isAbsolute(value.purelib || '')
        || value.distribution !== 'omnigent' || value.coreVersion !== '0.16.0'
        || value.consoleEntryPoint !== 'omnigent.cli:main' || value.consoleScriptValidated !== true
        || value.pythonExecutable !== entry.python || !path.isAbsolute(value.consoleScript || '')
        || !/^[a-f0-9]{64}$/.test(value.consoleScriptSha256 || '')) return failure('unexpected-guard-result');
    return { ok: true, state: value.state, sourceSha256: value.sourceSha256, coreVersion: value.coreVersion,
      consoleScriptValidated: true };
  } catch { return failure('guard-run-failed'); }
}
