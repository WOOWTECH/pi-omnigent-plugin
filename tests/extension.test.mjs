import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';

async function extension() {
  let typebox;
  for (const base of [new URL('../package.json', import.meta.url), '/usr/local/lib/node_modules/@agegr/pi-web/package.json']) {
    try { typebox = createRequire(base).resolve('typebox'); break; } catch {}
  }
  if (!typebox) throw new Error('TypeBox host peer is required to test the Pi extension.');
  let source = fs.readFileSync(new URL('../extensions/index.ts', import.meta.url), 'utf8');
  source = source.replace("from 'typebox'", `from ${JSON.stringify(pathToFileURL(typebox).href)}`)
    .replace("from '../src/web.mjs'", `from ${JSON.stringify(new URL('../src/web.mjs', import.meta.url).href)}`)
    .replace("import('../src/runtime.mjs')", `import(${JSON.stringify(new URL('../src/runtime.mjs', import.meta.url).href)})`);
  return import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
}
const { registerOmnigent } = await extension();

function harness({ phase = 'needs-login', hasUI = true } = {}) {
  const handlers = {}, commands = {}, tools = {}, messages = [], notifications = [], calls = [];
  const state = { phase, server: 'https://omnigent.example.com' };
  const backend = {
    status: async () => ({ ...state }),
    catalog: async () => ({ models: ['example-model'], modules: ['code'] }),
    verify: async () => ({ ok: true }),
    observeLifecycle: async lifecycle => calls.push(lifecycle),
  };
  const web = {
    packageLifecycle: async () => ({ active: true }),
    watchPackageLifecycle: () => async () => {},
  };
  const pi = {
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command; },
    registerTool: tool => { tools[tool.name] = tool; },
    sendMessage: message => messages.push(message),
  };
  const ctx = { cwd: '/fixture', hasUI, ui: {
    notify: message => notifications.push(message),
    input: () => assert.fail('session startup must not prompt for credentials'),
    custom: () => assert.fail('session startup must not show a password dialog'),
  } };
  registerOmnigent(pi, backend, web);
  return { handlers, commands, tools, messages, notifications, calls, state, backend, web, ctx };
}

test('session startup observes lifecycle but never creates or opens a conversation', async () => {
  const h = harness();
  await h.handlers.session_start({}, h.ctx);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.messages, []);
  await h.handlers.session_shutdown({}, h.ctx);
});

test('setup and connection commands direct users to Settings without asking for credentials', async () => {
  const h = harness();
  for (const command of ['setup', 'reconnect', 'disconnect', 'repair']) {
    await h.commands.omnigent.handler(command, h.ctx);
    assert.match(h.messages.at(-1).content, /\/omnigent/);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(Object.values(h.tools).some(tool => Object.keys(tool.parameters.properties).some(name => /password|username|server/.test(name))), false);
});

test('headless and native child sessions do not prompt or message', async () => {
  for (const options of [{ hasUI: false }, { hasUI: true }]) {
    const previous = process.env.PI_OMNIGENT_CHILD;
    if (options.hasUI) process.env.PI_OMNIGENT_CHILD = '1';
    try {
      const h = harness(options);
      await h.handlers.session_start({}, h.ctx);
      assert.deepEqual(h.messages, []);
      assert.equal(h.calls.length, 0);
    } finally {
      if (previous === undefined) delete process.env.PI_OMNIGENT_CHILD;
      else process.env.PI_OMNIGENT_CHILD = previous;
    }
  }
});

test('status, catalog, verify and open remain available after setup conversation removal', async () => {
  const h = harness({ phase: 'ready' });
  for (const command of ['status', 'catalog', 'verify', 'open']) await h.commands.omnigent.handler(command, h.ctx);
  assert.equal(h.messages.length, 4);
  assert.match(h.messages[1].content, /example-model/);
  assert.deepEqual((await h.tools.omnigent_verify.execute()).details, { ok: true });
  assert.equal(JSON.parse((await h.tools.omnigent_open.execute()).content[0].text).url, h.state.server);
});
