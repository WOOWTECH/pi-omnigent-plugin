import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createPasswordComponent } from '../src/password.ts';

async function extension() {
  let typebox;
  for (const base of [new URL('../package.json', import.meta.url), '/usr/local/lib/node_modules/@agegr/pi-web/package.json']) {
    try { typebox = createRequire(base).resolve('typebox'); break; } catch {}
  }
  if (!typebox) throw new Error('TypeBox host peer is required to test the Pi extension.');
  let source = fs.readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8');
  source = source.replace("from 'typebox'", `from ${JSON.stringify(pathToFileURL(typebox).href)}`)
    .replace("from '../src/password.ts'", `from ${JSON.stringify(new URL('../src/password.ts', import.meta.url).href)}`)
    .replace("from '../src/web.mjs'", `from ${JSON.stringify(new URL('../src/web.mjs', import.meta.url).href)}`)
    .replace("import('../src/runtime.mjs')", `import(${JSON.stringify(new URL('../src/runtime.mjs', import.meta.url).href)})`);
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
}

const { registerOmnigent } = await extension();

function harness({ phase = 'needs-login', id = Math.random().toString(36), hasUI = true, mode = 'rpc' } = {}) {
  const handlers = {}, commands = {}, tools = {}, messages = [], notifications = [], calls = [];
  const state = { phase, server: 'https://omnigent.example.com' };
  const pi = { on: (name, handler) => { handlers[name] = handler; }, registerCommand: (name, command) => { commands[name] = command; }, registerTool: tool => { tools[tool.name] = tool; }, sendMessage: message => { messages.push(message); } };
  const backend = {
    status: async () => ({ ...state }),
    initialize: async input => { calls.push(input); state.phase = 'ready'; return { ok: true, ...state }; },
    catalog: async () => ({ models: ['example-model'], modules: ['code'] }),
    verify: async () => ({ ok: true }),
    repair: async () => ({ ok: true }),
    disconnect: async () => { calls.push({ action: 'disconnect' }); state.phase = 'needs-login'; return { ok: true }; },
  };
  const web = { ensureOnboarding: async () => ({ sessionId: id, url: `/?session=${id}` }), readOnboarding: () => ({ sessionId: id }) };
  const ctx = { cwd: '/fixture', mode, hasUI, sessionManager: { getSessionId: () => id }, ui: {
    notify: message => notifications.push(message), setStatus() {},
    input: async title => title.includes('URL') ? 'https://omnigent.example.com' : 'fixture-account',
    select: async () => '沿用既有登入（建議）',
    custom: async factory => new Promise(resolve => {
      let component;
      const tui = { requestRender: () => { const rendered = component.render(80).join('\n'); assert.equal(rendered.includes('fixture-secret'), false); } };
      component = factory(tui, {}, {}, resolve);
      component.handleInput('fixture-secret');
      assert.equal(component.render(80).join('\n').includes('fixture-secret'), false);
      component.handleInput('\r');
    }),
  } };
  registerOmnigent(pi, backend, web);
  return { handlers, commands, tools, messages, notifications, calls, state, ctx, backend, web };
}

test('password typing, Unicode deletion, pasted values and disposal never render secret text', () => {
  let result;
  const component = createPasswordComponent('Password', () => {}, value => { result = value; });
  component.handleInput('fixture-secret');
  assert.equal(component.render(80).join('\n').includes('fixture-secret'), false);
  component.handleInput('\x15');
  component.handleInput('a🔒');
  component.handleInput('\x7f');
  component.handleInput('\x1b[200~b\n\x1b[201~');
  component.handleInput('\x1b[A');
  component.handleInput('\r');
  assert.equal(result, 'ab');
  assert.equal(component.render(80).join('\n').includes('•'), false);
  component.dispose();
});

test('password cancellation clears the buffer and never submits a value', () => {
  let result = 'sentinel';
  const component = createPasswordComponent('Password', () => {}, value => { result = value; });
  component.handleInput('secret');
  component.handleInput('\x1b');
  assert.equal(result, undefined);
  assert.equal(component.render(80).join('\n').includes('•'), false);
});

test('setup supplies password directly to backend without putting it in messages or tools', async () => {
  const h = harness();
  await h.commands.omnigent.handler('setup', h.ctx);
  assert.equal(h.calls[0].password, 'fixture-secret');
  assert.equal(JSON.stringify(h.messages).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(h.notifications).includes('fixture-secret'), false);
  assert.equal(Object.values(h.tools).some(tool => Object.keys(tool.parameters.properties).some(name => /password|username|server/.test(name))), false);
});

test('successful server login with missing provider auth explains the next step without claiming ready', async () => {
  const h = harness();
  h.backend.initialize = async () => {
    Object.assign(h.state, { phase: 'needs-verification', loginConfirmed: true, host: { connected: true },
      installedEngines: ['claude', 'codex', 'pi'], engines: { claude: { configured: 'needs-auth' }, codex: { configured: 'needs-auth' }, pi: { configured: true } },
      verification: { pi: { ok: false, reason: 'MODELS_UNAVAILABLE' } } });
    return { ok: false };
  };
  await h.commands.omnigent.handler('setup', h.ctx);
  const text = h.messages.map(m => m.content).join('\n');
  assert.match(text, /Server 已登入/);
  assert.match(text, /claude auth login/);
  assert.match(text, /codex login --device-auth/);
  assert.match(text, /Models/);
  assert.equal(text.includes('連線與對話驗證完成'), false);
});

test('reopening partially configured onboarding continues provider guidance without asking server password again', async () => {
  const h = harness();
  Object.assign(h.state, { phase: 'needs-verification', loginConfirmed: true, host: { connected: true }, installedEngines: ['pi'], verification: { pi: { ok: false } } });
  h.ctx.ui.input = () => assert.fail('existing approved server must not request another password');
  await h.handlers.session_start({}, h.ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.messages.at(-1).content, /Server 已登入/);
  assert.equal(h.calls.length, 0);
});

test('explicit setup freshly asks URL, account and masked password even for an already ready host', async () => {
  const h = harness({ phase: 'ready' });
  const questions = [];
  h.ctx.ui.input = async title => { questions.push(title); return title.includes('URL') ? h.state.server : 'fresh-account'; };
  h.ctx.ui.select = () => assert.fail('ambient-login reuse must never be offered');
  await h.commands.omnigent.handler('setup', h.ctx);
  assert.deepEqual(questions, ['Omnigent Server URL', 'Omnigent 帳號']);
  assert.deepEqual(h.calls[0], { server: h.state.server, username: 'fresh-account', password: 'fixture-secret', verify: false });
});

test('session binding completes while onboarding awaits UI', async () => {
  const h = harness();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  h.ctx.ui.input = () => pending;
  await h.handlers.session_start({}, h.ctx);
  assert.equal(h.calls.length, 0);
  release(undefined);
  await new Promise(resolve => setImmediate(resolve));
  await h.handlers.session_shutdown({}, h.ctx);
});

test('headless and disabled sessions never create onboarding, dialogs, or attention messages', async () => {
  for (const options of [{ hasUI: false, mode: 'print' }, { phase: 'disabled' }]) {
    const h = harness(options);
    h.web.ensureOnboarding = () => assert.fail('must not create onboarding');
    h.ctx.ui.input = () => assert.fail('must not request UI');
    await h.handlers.session_start({}, h.ctx);
    assert.equal(h.messages.length, 0);
  }
});

test('Omnigent Pi-native child session skips setup lifecycle', async () => {
  const previous = process.env.OMNIGENT_PI_NATIVE_CONFIG;
  process.env.OMNIGENT_PI_NATIVE_CONFIG = '/fixture/config.json';
  try {
    const h = harness();
    h.web.ensureOnboarding = () => assert.fail('child session must not create setup');
    await h.handlers.session_start({}, h.ctx);
    assert.equal(h.messages.length, 0);
  } finally { if (previous === undefined) delete process.env.OMNIGENT_PI_NATIVE_CONFIG; else process.env.OMNIGENT_PI_NATIVE_CONFIG = previous; }
});

test('catalog and verify are callable as explicit slash commands and model tools', async () => {
  const h = harness({ phase: 'ready' });
  await h.commands.omnigent.handler('catalog', h.ctx);
  await h.commands.omnigent.handler('verify', h.ctx);
  assert.ok(h.messages.some(message => message.content.includes('example-model')));
  assert.deepEqual((await h.tools.omnigent_verify.execute()).details, { ok: true });
  assert.equal(JSON.parse((await h.tools.omnigent_open.execute()).content[0].text).url, h.state.server);
});

test('reconnect first disconnects then asks fresh URL, account and masked password', async () => {
  const h = harness({ phase: 'ready' });
  await h.commands.omnigent.handler('reconnect', h.ctx);
  assert.deepEqual(h.calls.map(call => call.action || 'initialize'), ['disconnect', 'initialize']);
  assert.equal(h.calls[1].username, 'fixture-account');
  assert.equal(h.calls[1].password, 'fixture-secret');
  assert.equal(JSON.stringify(h.messages).includes('fixture-secret'), false);
});

test('reconnect refuses to login before a failed disconnect is resolved', async () => {
  const h = harness({ phase: 'ready' });
  h.backend.disconnect = async () => ({ ok: false, error: { code: 'HOST_DISCONNECT_TIMEOUT' } });
  h.ctx.ui.input = () => assert.fail('must not reconnect a host whose disconnection failed');
  await h.commands.omnigent.handler('reconnect', h.ctx);
  assert.equal(h.calls.length, 0);
  assert.ok(h.messages[0].content.includes('HOST_DISCONNECT_TIMEOUT'));
});

test('wizard never announces success for rejected or busy setup on a previously ready host', async () => {
  for (const outcome of [{ ok: false, error: { code: 'NEEDS_LOGIN' } }, { busy: true }]) {
    const h = harness({ phase: 'ready' });
    h.backend.initialize = async () => outcome;
    await h.commands.omnigent.handler('setup', h.ctx);
    assert.equal(h.messages.some(m => m.content.startsWith('Omnigent 連線與對話驗證完成。')), false);
  }
});
