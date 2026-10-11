import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function locations(env = process.env) {
  const home = env.HOME || os.homedir();
  const agentDir = env.PI_CODING_AGENT_DIR || env.PI_AGENT_DATA_DIR || path.join(home, '.pi', 'agent');
  return { root: ROOT, home, agentDir,
    stateDir: env.PI_OMNIGENT_STATE_DIR || path.join(agentDir, 'omnigent-plugin'),
    omniDir: env.OMNIGENT_CONFIG_HOME || path.join(home, '.omnigent'),
    omniDataDir: env.OMNIGENT_DATA_DIR || env.OMNIGENT_CONFIG_HOME || path.join(home, '.omnigent') };
}
export function readJSON(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Plugin state could not be read; inspect or restore the state file.'); }
}
export function atomic(file, contents, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const descriptor = fs.openSync(temp, 'wx', mode);
    try { fs.writeFileSync(descriptor, contents); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temp, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
  finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
export function saveJSON(file, data) { atomic(file, JSON.stringify(data, null, 2) + '\n'); }
export function normalizeServer(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('請輸入完整的 Omnigent Server URL。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Server URL 必須是 HTTP(S)，且不能含帳密、查詢參數或 fragment。');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('遠端 Server 請使用 HTTPS。');
  }
  return url.href.replace(/\/+$/, '');
}
export function safeError(error) {
  const code = error?.code;
  return code && /^[A-Z_0-9]+$/.test(code) ? `Operation failed (${code}).` : '操作未完成；請檢查插件狀態與登入／模型設定。';
}
function processIdentity(pid = process.pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return { processStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  } catch { return {}; }
}
function legacyLockAlive(file) {
  if (!fs.existsSync(file)) return false;
  try {
    const owner = readJSON(path.join(file, 'owner.json'));
    if (!Number.isInteger(owner.pid) || owner.pid <= 1) return Date.now() - fs.statSync(file).mtimeMs < 60_000;
    const identity = processIdentity(owner.pid);
    if (owner.bootId && identity.bootId && owner.bootId !== identity.bootId) return false;
    if (owner.processStart && identity.processStart && owner.processStart !== identity.processStart) return false;
    try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  } catch { return Date.now() - fs.statSync(file).mtimeMs < 60_000; }
}
/** Kernel lock: pipe closure on parent exit releases it, regardless of PID reuse. */
export async function locked(file, callback) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const executable = ['/usr/bin/flock', '/bin/flock'].find(candidate => fs.existsSync(candidate));
  if (!executable) throw Object.assign(new Error('Linux util-linux flock is required.'), { code: 'LOCK_UNAVAILABLE' });
  const kernelFile = `${file}.flock`;
  const descriptor = fs.openSync(kernelFile, 'a', 0o600); fs.closeSync(descriptor);
  // This inode must never be removed: deleting it would permit two kernel locks.
  const helper = spawn(executable, ['-n', '-E', '75', kernelFile, process.execPath, '-e',
    "process.stdout.write('LOCKED\\n'); process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => helper.once('close', resolve));
  helper.stdin.on('error', () => {});
  let acquired;
  try {
    acquired = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { helper.kill('SIGTERM'); reject(Object.assign(new Error('Lock helper timed out.'), { code: 'LOCK_UNAVAILABLE' })); }, 5000);
      helper.once('error', error => { clearTimeout(timer); reject(error); });
      helper.stdout.once('data', chunk => { clearTimeout(timer); resolve(String(chunk).startsWith('LOCKED')); });
      helper.once('close', code => { clearTimeout(timer); code === 75 ? resolve(false) : reject(Object.assign(new Error('Lock helper failed.'), { code: 'LOCK_UNAVAILABLE' })); });
    });
    if (!acquired || legacyLockAlive(file)) return { busy: true };
    fs.rmSync(file, { recursive: true, force: true });
    saveJSON(path.join(file, 'owner.json'), { pid: process.pid, ...processIdentity() });
    try { return await callback(); } finally { fs.rmSync(file, { recursive: true, force: true }); }
  } finally { helper.stdin.end(); await closed; }
}
export function runJSON(command, args, input, { env = process.env, timeout = 120_000, killGraceMs = 2_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; let bytes = 0; let settled = false, terminationError, killTimer;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); error ? reject(error) : resolve(result); };
    const terminate = error => {
      if (terminationError || settled) return;
      terminationError = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    // Do not release the operation lock while an expired adapter is still alive.
    const timer = setTimeout(() => terminate(Object.assign(new Error('Adapter timed out.'), { code: 'ETIMEDOUT' })), timeout);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) terminate(Object.assign(new Error('Adapter result exceeded limit.'), { code: 'RESULT_TOO_LARGE' })); else output.push(chunk); });
    child.stderr.resume(); // Adapter logs and raw failures never enter the chat or CLI output.
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (terminationError) return finish(terminationError);
      if (code !== 0) return finish(Object.assign(new Error('Omnigent adapter failed.'), { code: 'ADAPTER_FAILED' }));
      try { finish(null, JSON.parse(Buffer.concat(output).toString('utf8'))); }
      catch { finish(new Error('Invalid adapter response.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
