import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locked, saveJSON, runJSON } from '../src/common.mjs';

test('adapter timeout kills a process that ignores SIGTERM before releasing the operation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnigent-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'pid');
  const code = "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);";
  await assert.rejects(runJSON(process.execPath, ['-e', code, pidFile], {}, { timeout: 300, killGraceMs: 100 }), { code: 'ETIMEDOUT' });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('lock from an earlier container process recovers even when its PID has been reused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnigent-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'operation.lock');
  saveJSON(path.join(lock, 'owner.json'), { pid: process.pid, processStart: 'not-this-process', bootId: 'previous-boot' });
  assert.equal(await locked(lock, async () => 'recovered'), 'recovered');
});

test('kernel lock permits only one callback across competing processes', async t => {
  const { spawn } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnigent-lock-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'operation.lock');
  const moduleUrl = new URL('../src/common.mjs', import.meta.url).href;
  const code = `import {locked} from ${JSON.stringify(moduleUrl)}; const r=await locked(process.argv[1], async()=>{process.stdout.write('entered\\n');await new Promise(r=>setTimeout(r,250));return 'done'});process.stdout.write(JSON.stringify(r));`;
  const runs = Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, lock]);
    let output = ''; child.stdout.on('data', x => { output += x; }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error('Lock child failed')));
  }));
  const results = await Promise.all(runs);
  assert.equal(results.filter(result => result.includes('entered')).length, 1);
  assert.equal(results.filter(result => result.includes('busy')).length, 7);
});

test('kernel lock is released when its parent is killed abruptly', async t => {
  const { spawn } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnigent-lock-crash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lock = path.join(root, 'operation.lock');
  const code = `import {locked} from ${JSON.stringify(new URL('../src/common.mjs', import.meta.url).href)}; await locked(process.argv[1], async()=>{process.stdout.write('entered');await new Promise(()=>{})});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, lock]);
  const closed = new Promise(resolve => child.on('close', resolve));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  child.kill('SIGKILL'); await closed;
  // EOF releases the helper; old diagnostic owner is provably dead.
  let result;
  for (let i = 0; i < 20; i++) {
    result = await locked(lock, async () => 'recovered');
    if (!result?.busy) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(result, 'recovered');
});
