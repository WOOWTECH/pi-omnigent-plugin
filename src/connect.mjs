import { normalizeServer } from './common.mjs';
import { packageLifecycle } from './web.mjs';
import { initialize } from './runtime.mjs';

const isCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const text = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256) : null;
const failure = code => ({ ok: false, error: { code } });
function serverAccepted(value) {
  try { normalizeServer(value); return true; } catch { return false; }
}

/** Settings form limits for the server and user name; the server must also pass the runtime's normalization. */
export function setupFieldsValid({ server, username } = {}) {
  return typeof server === 'string' && !!server.trim() && server.length <= 2048 && serverAccepted(server.trim())
    && typeof username === 'string' && !!username.trim() && username.length <= 256;
}

/**
 * Runbook form of Settings → Omnigent "connect": the same plugin lifecycle
 * gate, field rules and initialize({ verify: false }) call. The password is
 * handed to the login once; it is never stored, logged or returned.
 */
export async function connectWithPassword({ server, username, password, ...options } = {}) {
  if (!(await packageLifecycle(options)).active) return failure('PLUGIN_UNAVAILABLE');
  if (!setupFieldsValid({ server, username }) || typeof password !== 'string' || !password || password.length > 4096) return failure('INVALID_SETUP');
  let result;
  try { result = await initialize({ ...options, server: server.trim(), username: username.trim(), password, verify: false }); }
  catch (error) { return failure(isCode(error?.code) ? error.code : 'OMNIGENT_FAILED'); }
  const host = result?.connection?.host || {};
  return { ok: result?.ok === true, phase: text(result?.phase), server: text(result?.server),
    host: { id: text(host.id), name: text(host.name), connected: host.connected === true },
    ...(result?.ok === true ? {} : { error: { code: [result?.error?.code, result?.issue?.code].find(isCode)
      || (result?.phase === 'disabled' ? 'PLUGIN_DISABLED' : 'OMNIGENT_FAILED') } }) };
}

/** Read a piped password: one trailing line ending is dropped; a terminal is refused so nothing is echoed. */
export async function readPasswordStdin(stream = process.stdin) {
  if (stream.isTTY) throw Object.assign(new Error('Pipe the password on stdin.'), { code: 'PASSWORD_STDIN_REQUIRED' });
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(bytes); size += bytes.length;
      // Far above the 4096-character Settings limit, so multibyte passwords still fit.
      if (size > 65536) throw Object.assign(new Error('Password input is too large.'), { code: 'INVALID_SETUP' });
    }
    chunks.push(Buffer.concat(chunks));
    let value = chunks.at(-1).toString('utf8');
    if (value.endsWith('\n')) value = value.slice(0, -1);
    if (value.endsWith('\r')) value = value.slice(0, -1);
    return value;
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
