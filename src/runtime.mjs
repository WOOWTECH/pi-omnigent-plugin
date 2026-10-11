import path from 'node:path';
import fs from 'node:fs';
import { locations, readJSON, saveJSON, normalizeServer, locked, runJSON } from './common.mjs';
import { discover, installDependencies, runtimeEnv } from './installer.mjs';

const ENGINES = ['claude', 'codex', 'pi'];
const statePath = loc => path.join(loc.stateDir, 'state.json');
const stateOf = loc => readJSON(statePath(loc), { phase: 'new', enabled: true });
function writeState(loc, changes) {
  const next = { ...stateOf(loc), ...changes, updatedAt: new Date().toISOString() };
  saveJSON(statePath(loc), next); return next;
}
function hostEnvironment(loc, env) {
  const next = { ...env, OMNIGENT_CONFIG_HOME: loc.omniDir, OMNIGENT_DATA_DIR: loc.omniDataDir };
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
    if (next[key]?.startsWith(path.join(loc.omniDataDir, 'codex-native') + path.sep)
      || next[key]?.startsWith(path.join(loc.omniDataDir, 'claude-native') + path.sep)) delete next[key];
  }
  return next;
}
async function context(options = {}) {
  const loc = { ...locations(options.env || process.env), ...(options.loc || {}) };
  const env = hostEnvironment(loc, options.env || process.env);
  env.PATH = [path.join(loc.stateDir, 'bin'), path.join(loc.stateDir, 'node', 'node_modules', '.bin'), env.PATH].filter(Boolean).join(path.delimiter);
  const dependencies = options.dependencies || await discover(env);
  const execute = options.callAdapter || (async input => {
    const python = dependencies.omnigent?.python;
    if (!python) return { ok: false, error: { code: 'DEPENDENCIES_MISSING', message: 'Omnigent Python 尚未安裝；請執行設定／修復。' } };
    return runJSON(python, [path.join(loc.root, 'src', 'omnigent.py')], input,
      { env: runtimeEnv(dependencies, env), timeout: input.action === 'verify' ? 300_000 : 120_000 });
  });
  const call = async (action, input = {}) => execute({ action, configHome: loc.omniDir, dataDir: loc.omniDataDir,
    stateDir: loc.stateDir, workspace: loc.home, omnigentBin: dependencies.omnigent?.path, ...input });
  return { loc, env, dependencies, call };
}
function successfulReceipt(receipt, state, host) {
  return receipt?.ok === true && receipt.server === state.server && receipt.hostId === host?.id;
}
export async function status(options = {}) {
  const { loc, call, dependencies } = await context(options);
  const state = stateOf(loc);
  const response = await call('status', { ...(state.server ? { server: state.server } : {}) });
  const data = response.ok ? response.data : {};
  const server = state.server || data.server;
  const host = data.host || { connected: false, managed: false };
  const verification = readJSON(path.join(loc.stateDir, 'verification.json'), {});
  const effective = { ...state, server };
  const installed = ENGINES.filter(engine => dependencies[engine]?.available === true);
  const verified = installed.length > 0 && installed.every(engine => successfulReceipt(verification[engine], effective, host));
  const ready = state.loginConfirmed === true && verified && host.connected === true && response.ok === true
    && installed.every(engine => data.engines?.[engine]?.ready === true
      && (!verification[engine].cliVersion || verification[engine].cliVersion === dependencies[engine]?.version));
  return { phase: state.enabled === false ? 'disabled' : ready ? 'ready' : state.phase === 'ready' ? 'needs-verification' : state.phase,
    enabled: state.enabled !== false, loginConfirmed: state.loginConfirmed === true, server, host,
    installedEngines: installed,
    engines: Object.fromEntries(ENGINES.map(engine => [engine, { ...dependencies[engine], ...(data.engines?.[engine] || {}) }])),
    verification, ...(response.ok ? {} : { error: response.error }), ...(state.issue ? { issue: state.issue } : {}) };
}
export async function catalog(options = {}) {
  const { loc, call } = await context(options); const state = stateOf(loc);
  const response = await call('catalog', { ...(state.server ? { server: state.server } : {}) });
  if (response.ok) saveJSON(path.join(loc.stateDir, 'catalog.json'), response.data);
  return response;
}
async function verifyInternal(ctx, { engine, model } = {}) {
  const { loc, call } = ctx; const state = stateOf(loc);
  if (state.loginConfirmed !== true) return { ok: false, phase: 'needs-login', error: { code: 'FRESH_LOGIN_REQUIRED', message: '請在設定對話重新輸入網址、帳號與密碼。' } };
  if (!state.server) return { ok: false, phase: 'needs-setup', error: { code: 'SERVER_REQUIRED', message: '請先設定 Omnigent Server。' } };
  if (engine && !ENGINES.includes(engine)) throw new Error('Unknown engine.');
  const installed = ENGINES.filter(name => ctx.dependencies[name]?.available === true);
  if (!installed.length || (engine && !installed.includes(engine))) {
    writeState(loc, { phase: 'needs-engine', issue: { code: 'NO_AVAILABLE_ENGINE', message: '此環境沒有可連結的指定引擎。插件只連結當下已有的引擎。' } });
    return { ok: false, phase: 'needs-engine', error: stateOf(loc).issue };
  }
  writeState(loc, { phase: 'verifying', issue: null });
  const summary = await call('catalog', { server: state.server });
  if (!summary.ok) {
    writeState(loc, { phase: summary.error?.code === 'NEEDS_LOGIN' ? 'needs-login' : 'error', issue: summary.error });
    return { ok: false, phase: stateOf(loc).phase, error: summary.error };
  }
  const hostId = summary.data.host?.id || summary.data.host?.host_id || summary.data.hostId;
  const receiptPath = path.join(loc.stateDir, 'verification.json');
  const receipts = readJSON(receiptPath, {});
  for (const name of engine ? [engine] : installed) {
    const result = await call('verify', { server: state.server, engine: name, ...(model ? { model } : {}), timeoutSeconds: 120 });
    const proof = result.ok ? result.data : { ok: false, reason: result.error?.code || 'VERIFY_FAILED' };
    receipts[name] = { engine: name, ok: proof.ok === true && proof.reply === 'OMNIGENT_CONNECTION_OK',
      server: state.server, hostId, checkedAt: new Date().toISOString(),
      ...(ctx.dependencies[name]?.version ? { cliVersion: ctx.dependencies[name].version } : {}),
      ...(proof.sessionId ? { sessionId: proof.sessionId, url: proof.url } : {}),
      ...(proof.model ? { model: proof.model } : {}),
      ...(proof.cleanup ? { cleanup: proof.cleanup } : {}),
      ...(proof.reply === 'OMNIGENT_CONNECTION_OK' ? { reply: proof.reply } : {}),
      ...(proof.ok !== true ? { reason: proof.reason || result.error?.code || 'NO_REPLY' } : {}) };
    saveJSON(receiptPath, receipts);
  }
  const ok = !!hostId && installed.every(name => successfulReceipt(receipts[name], state, { id: hostId }));
  writeState(loc, { phase: ok ? 'ready' : 'needs-verification', issue: ok ? null : { code: 'INCOMPLETE_CHAT_VERIFICATION', message: '目前已安裝的引擎必須都收到實際回覆，才能完成設定。' } });
  return { ok, phase: stateOf(loc).phase, server: state.server, installedEngines: installed, verification: receipts };
}
export async function verify(options = {}) {
  const ctx = await context(options);
  return locked(path.join(ctx.loc.stateDir, 'initialize.lock'), () => verifyInternal(ctx, options));
}
export async function initialize(options = {}) {
  const initial = await context(options); const { loc, env } = initial;
  return locked(path.join(loc.stateDir, 'initialize.lock'), async () => {
    const previous = stateOf(loc);
    if (previous.enabled === false && !options.enable) return { ok: false, phase: 'disabled' };
    // Never persist login inputs: only the normalized non-secret server is state.
    const serverInput = options.server || previous.server;
    const server = serverInput ? normalizeServer(serverInput) : undefined;
    writeState(loc, { phase: 'installing', ...(server ? { server } : {}), issue: null, enabled: true });
    const install = options.install || installDependencies;
    const dependencies = options.dependencies || await install({ env, home: loc.home, stateDir: loc.stateDir, update: options.update === true });
    if (dependencies.ok === false || !dependencies.omnigent?.available) {
      writeState(loc, { phase: 'error', issue: { code: 'DEPENDENCIES_MISSING', message: '依賴安裝未完成。', details: dependencies.issues || [] } });
      return { ok: false, ...stateOf(loc), dependencies };
    }
    const ctx = await context({ ...options, dependencies });
    const local = await ctx.call('status', { ...(server ? { server } : {}) });
    const target = server || local.data?.server;
    if (!target) {
      writeState(loc, { phase: 'needs-setup' });
      return { ok: false, phase: 'needs-setup', message: '請在專用設定對話輸入 Omnigent Server。' };
    }
    const normalized = normalizeServer(target);
    const freshLogin = typeof options.username === 'string' && options.username.trim()
      && typeof options.password === 'string' && options.password;
    if (!freshLogin && previous.loginConfirmed !== true) {
      writeState(loc, { phase: 'needs-login', server: normalized, loginConfirmed: false });
      return { ok: false, phase: 'needs-login', server: normalized, error: { code: 'FRESH_LOGIN_REQUIRED', message: '請在設定對話重新輸入網址、帳號與密碼。' } };
    }
    writeState(loc, { phase: 'connecting', server: normalized });
    const connected = await ctx.call('connect', { server: normalized,
      ...(options.username ? { username: options.username } : {}),
      ...(options.password ? { password: options.password } : {}), allowManagedHost: true });
    if (!connected.ok) {
      const phase = ['NEEDS_LOGIN', 'NEEDS_BROWSER_AUTH', 'needs_login', 'needs_browser_auth'].includes(connected.error?.code) ? 'needs-login' : 'error';
      writeState(loc, { phase, issue: connected.error });
      return { ok: false, phase, server: normalized, error: connected.error };
    }
    writeState(loc, { phase: 'needs-verification', loginConfirmed: true, issue: null });
    if (freshLogin) saveJSON(path.join(loc.stateDir, 'verification.json'), {});
    saveJSON(path.join(loc.stateDir, 'connection.json'), connected.data);
    if (options.verify === false) return { ok: true, phase: 'needs-verification', server: normalized, connection: connected.data };
    return verifyInternal(ctx);
  });
}
export async function repair(options = {}) { return initialize({ ...options, enable: true }); }
/** Remove only this server's local login and wait for this host to go offline. */
export async function disconnect(options = {}) {
  const ctx = await context(options); const { loc, call } = ctx;
  return locked(path.join(loc.stateDir, 'initialize.lock'), async () => {
    const previous = stateOf(loc);
    writeState(loc, { phase: 'disconnecting', loginConfirmed: false, issue: null });
    saveJSON(path.join(loc.stateDir, 'verification.json'), {});
    for (const name of ['connection.json', 'catalog.json']) {
      try { fs.unlinkSync(path.join(loc.stateDir, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const result = await call('disconnect', { ...(previous.server ? { server: previous.server } : {}) });
    writeState(loc, { phase: 'needs-login', issue: result.ok ? null : result.error });
    if (!result.ok) return { ok: false, phase: 'needs-login', error: result.error };
    const receipt = { ...result.data, checkedAt: new Date().toISOString() };
    saveJSON(path.join(loc.stateDir, 'disconnection.json'), receipt);
    return { ok: true, phase: 'needs-login', ...receipt };
  });
}
/** Startup installs dependencies only. An existing host login is never consent. */
export async function prepare(options = {}) {
  const ctx = await context(options); const { loc, env } = ctx;
  return locked(path.join(loc.stateDir, 'initialize.lock'), async () => {
    if (stateOf(loc).enabled === false) return { ok: false, phase: 'disabled' };
    const install = options.install || installDependencies;
    const dependencies = options.dependencies || await install({ env, home: loc.home, stateDir: loc.stateDir });
    if (dependencies.ok === false || !dependencies.omnigent?.available) {
      writeState(loc, { phase: 'error', issue: { code: 'DEPENDENCIES_MISSING', message: '依賴安裝未完成。', details: dependencies.issues || [] } });
      return { ok: false, phase: 'error', issues: dependencies.issues || [] };
    }
    const current = stateOf(loc);
    writeState(loc, { phase: current.loginConfirmed === true ? 'needs-verification' : 'needs-login', issue: null });
    return { ok: true, phase: stateOf(loc).phase, dependencies: { changed: dependencies.changed, installed: dependencies.installed || [], warnings: dependencies.warnings || [] } };
  });
}
export function setEnabled(value, options = {}) {
  const loc = options.loc || locations();
  return writeState(loc, { enabled: value === true, loginConfirmed: false, phase: value === true ? 'needs-login' : 'disabled' });
}
export function enabled(options = {}) { return stateOf(options.loc || locations()).enabled !== false; }
