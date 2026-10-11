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
  try { fs.writeFileSync(temp, contents, { mode, flag: 'wx' }); fs.renameSync(temp, file); }
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
export async function locked(file, callback) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.mkdirSync(file, { mode: 0o700 }); acquired = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = readJSON(path.join(file, 'owner.json')); } catch { return { busy: true }; }
      // A missing receipt may mean another process is between mkdir and write.
      if (!owner.pid) return { busy: true };
      try { process.kill(owner.pid, 0); return { busy: true }; }
      catch (probe) { if (probe.code !== 'ESRCH') return { busy: true }; }
      fs.rmSync(file, { recursive: true, force: true });
    }
  }
  if (!acquired) return { busy: true };
  saveJSON(path.join(file, 'owner.json'), { pid: process.pid });
  try { return await callback(); }
  finally { fs.rmSync(file, { recursive: true, force: true }); }
}
export function runJSON(command, args, input, { env = process.env, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; let bytes = 0; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(Object.assign(new Error('Adapter timed out.'), { code: 'ETIMEDOUT' })); }, timeout);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { child.kill(); finish(new Error('Adapter result exceeded limit.')); } else output.push(chunk); });
    child.stderr.resume(); // Adapter logs and raw failures never enter the chat or CLI output.
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0) return finish(Object.assign(new Error('Omnigent adapter failed.'), { code: 'ADAPTER_FAILED' }));
      try { finish(null, JSON.parse(Buffer.concat(output).toString('utf8'))); }
      catch { finish(new Error('Invalid adapter response.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}
