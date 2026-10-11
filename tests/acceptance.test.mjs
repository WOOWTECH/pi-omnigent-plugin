import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptance } from '../src/acceptance.mjs';

function fixture() {
  const calls = [];
  const runtime = {
    status: async () => ({ enabled: true, loginConfirmed: true, phase: 'ready', server: 'https://server.example', host: { id: 'own-host', connected: true }, installedEngines: ['pi'] }),
    catalog: async () => ({ ok: true, data: { host: { connected: true }, engines: { pi: { ready: true, agentId: 'pi-module', models: [{ id: 'model-a' }] } }, unexpectedSecret: 'never-output' } }),
    verify: async options => { calls.push(options); return { verification: { pi: { ok: true, reply: 'OMNIGENT_CONNECTION_OK', cleanup: 'stopped', sessionId: 'own-check', model: options.model } } }; },
  };
  return { calls, runtime };
}
test('default acceptance checks inventory and readiness without running chats or exposing raw catalog', async () => {
  const ctx = fixture(); const result = await acceptance(ctx);
  assert.equal(result.ok, true); assert.equal(ctx.calls.length, 0);
  assert.equal(JSON.stringify(result).includes('never-output'), false);
});
test('explicit model acceptance uses only requested installed engine and checks stopped-session evidence', async () => {
  const ctx = fixture(); const result = await acceptance({ ...ctx, chat: true, engine: 'pi', model: 'model-a' });
  assert.equal(result.ok, true); assert.equal(ctx.calls[0].model, 'model-a');
  assert.equal(ctx.calls.length, 1);
  ctx.runtime.verify = async () => ({ verification: { pi: { ok: true, reply: 'OMNIGENT_CONNECTION_OK', cleanup: 'stop_failed' } } });
  assert.equal((await acceptance({ ...ctx, chat: true })).ok, false);
});
test('incomplete setup cannot be accepted or send a chat using ambient authentication', async () => {
  const ctx = fixture(); ctx.runtime.status = async () => ({ enabled: true, loginConfirmed: false, phase: 'needs-login' });
  ctx.runtime.catalog = () => assert.fail('must not access authenticated catalog');
  assert.equal((await acceptance({ ...ctx, chat: true })).ok, false);
  assert.equal(ctx.calls.length, 0);
});
test('busy operation cannot reuse earlier successful chat evidence', async () => {
  const ctx = fixture();
  ctx.runtime.verify = async () => ({ busy: true, verification: { pi: { ok: true, reply: 'OMNIGENT_CONNECTION_OK', cleanup: 'stopped' } } });
  assert.equal((await acceptance({ ...ctx, chat: true })).ok, false);
});
