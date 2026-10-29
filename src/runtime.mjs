import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { locations, readJSON, saveJSON, normalizeServer, locked, runJSON } from './common.mjs';
import { discover, installDependencies, runCommand, runtimeEnv } from './installer.mjs';
import { DEFAULT_PACKAGE_NAME, ownPackageName } from './locate.mjs';

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
  const call = async (action, input = {}) => {
    try { return await execute({ action, configHome: loc.omniDir, dataDir: loc.omniDataDir,
      stateDir: loc.stateDir, workspace: loc.home, omnigentBin: dependencies.omnigent?.path,
      engineInventory: Object.fromEntries(ENGINES.map(name => [name, {
        installed: dependencies[name]?.available === true, version: dependencies[name]?.version || null,
      }])), ...input }); }
    catch (error) { return { ok: false, error: { code: /^[A-Z_0-9]+$/.test(error?.code || '') ? error.code : 'ADAPTER_FAILED',
      message: 'Omnigent 程序未完成；請查看狀態並重試修復。' } }; }
  };
  return { loc, env, dependencies, call, runPiModelRefresh: options.runPiModelRefresh };
}
function successfulReceipt(receipt, state, host, dependency) {
  return receipt?.ok === true && receipt.cleanup === 'stopped' && receipt.server === state.server && receipt.hostId === host?.id
    && (!receipt.cliVersion || receipt.cliVersion === dependency?.version);
}
async function operation(ctx, callback) {
  const result = await locked(path.join(ctx.loc.stateDir, 'initialize.lock'), callback);
  return result?.busy ? { ok: false, busy: true, phase: 'busy', error: { code: 'OPERATION_BUSY', message: '另一個 Omnigent 操作正在執行，請稍後重試。' } } : result;
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
  const verified = installed.length > 0 && installed.every(engine => successfulReceipt(verification[engine], effective, host, dependencies[engine]));
  const ready = state.loginConfirmed === true && verified && host.connected === true && response.ok === true
    && installed.every(engine => data.engines?.[engine]?.ready === true
      && (!verification[engine].cliVersion || verification[engine].cliVersion === dependencies[engine]?.version));
  const phase = state.enabled === false ? 'disabled' : ['installing', 'connecting', 'verifying', 'disconnecting', 'error', 'needs-login'].includes(state.phase)
    ? state.phase : ready ? 'ready' : state.phase === 'ready' ? 'needs-verification' : state.phase;
  return { phase,
    enabled: state.enabled !== false, loginConfirmed: state.loginConfirmed === true, server, host,
    installedEngines: installed,
    engines: Object.fromEntries(ENGINES.map(engine => [engine, { ...dependencies[engine], ...(data.engines?.[engine] || {}) }])),
    verification, ...(response.ok ? {} : { error: response.error }), ...(state.issue ? { issue: state.issue } : {}) };
}
function nativePiLoginFingerprint(loc) {
  try {
    const file = path.join(loc.agentDir, 'auth.json');
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) return null;
    const credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)
      || !Object.keys(credentials).length) return null;
    return `${metadata.mtimeMs}:${metadata.size}`;
  } catch { return null; }
}

async function queryCatalog(ctx, state) {
  const input = { ...(state.server ? { server: state.server } : {}) };
  const response = await ctx.call('catalog', input);
  const pi = response.data?.engines?.pi;
  if (!response.ok || !response.data?.host?.connected || pi?.installed !== true || pi.configured !== true
    || !Array.isArray(pi.models) || pi.models.length || pi.modelError || !ctx.dependencies.pi?.path
    || ctx.env.PI_OFFLINE) return response;
  const login = nativePiLoginFingerprint(ctx.loc);
  if (!login) return response;
  const marker = path.join(ctx.loc.stateDir, 'pi-model-refresh.json');
  const recent = () => {
    const last = readJSON(marker, {});
    return last.login === login && Number.isFinite(last.at) && Date.now() - last.at < 15 * 60_000;
  };
  if (recent()) return response;
  let refreshed;
  try {
    refreshed = await locked(path.join(ctx.loc.stateDir, 'pi-model-refresh.lock'), async () => {
      if (recent()) return null;
      saveJSON(marker, { login, at: Date.now() });
      const env = { ...ctx.env, HOME: ctx.loc.home, PI_CODING_AGENT_DIR: ctx.loc.agentDir };
      const result = ctx.runPiModelRefresh
        ? await ctx.runPiModelRefresh(ctx.dependencies.pi.path, env)
        : await runCommand(ctx.dependencies.pi.path, ['update', '--models'], { env, timeoutMs: 30_000 });
      return result?.code === 0 ? await ctx.call('catalog', input) : null;
    });
  } catch { return response; }
  return refreshed?.ok === true ? refreshed : response;
}

export async function catalog(options = {}) {
  const ctx = await context(options); const { loc } = ctx; const state = stateOf(loc);
  const response = await queryCatalog(ctx, state);
  if (response.ok) saveJSON(path.join(loc.stateDir, 'catalog.json'), response.data);
  return response;
}
// The installation is named by a random id kept in state.json and the package
// name, so moving the plugin (git pin <-> image bundle) or its paths changes
// nothing. The path fields are what 0.3.16–0.3.29 compare; they stay in each
// receipt only so a rollback can still resume, and are never compared here.
const INSTALLATION_ID = /^[0-9a-f]{32}$/;
const PACKAGE = ownPackageName();
function installationId(state) {
  return INSTALLATION_ID.test(state?.installationId || '') ? state.installationId : randomBytes(16).toString('hex');
}
function installation(loc, id) {
  return { schema: 2, id, package: PACKAGE,
    home: path.resolve(loc.home), configHome: path.resolve(loc.omniDir), dataDir: path.resolve(loc.omniDataDir) };
}
function sameInstallation(recorded, state) {
  // Receipts from 0.3.16–0.3.29 (paths) and earlier (none) were written only by
  // this package. They migrate when server, workspace and host match; the
  // adapter still proves the token and that /v1/me is the host owner.
  const legacy = PACKAGE === DEFAULT_PACKAGE_NAME;
  if (recorded === undefined) return legacy;
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return false;
  if (recorded.schema === undefined) return legacy;
  return recorded.schema === 2 && recorded.package === PACKAGE
    && INSTALLATION_ID.test(recorded.id || '') && recorded.id === state.installationId;
}
function privateReceipt(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())) return null;
    return readJSON(file);
  } catch { return null; }
}
/** Resume this installation's recorded consent; SDK credentials alone are never consent. */
export async function resumeAuthorizedHost(options = {}) {
  const ctx = await context(options); const { loc, call } = ctx;
  return operation(ctx, async () => {
    const lifecycle = typeof options.lifecycle === 'function' ? await options.lifecycle()
      : options.lifecycle || await (await import('./web.mjs')).packageLifecycle({ ...options, loc });
    const skip = reason => ({ ok: true, resumed: false, reason });
    // The copy Pi loads resumes the host; a superseded copy stays out of it.
    if (lifecycle.superseded === true) return skip('superseded');
    if (!lifecycle.active || lifecycle.registered !== true) return skip('inactive');
    const state = privateReceipt(statePath(loc));
    if (state?.enabled !== true || state.nativeActive === false || state.loginConfirmed !== true) return skip('fresh-login-required');
    const proof = privateReceipt(path.join(loc.stateDir, 'connection.json'));
    const mismatch = () => {
      const error = { code: 'CONNECTION_IDENTITY_MISMATCH' };
      writeState(loc, { phase: 'error', issue: error });
      return { ok: false, resumed: false, error };
    };
    // Server, workspace, host and installation must all match the receipt.
    // Never manufacture consent from SDK config or a token.
    if (!proof?.host?.id || !state.server || proof.server !== state.server || proof.workspace !== loc.home
      || !sameInstallation(proof.installation, state)) {
      return mismatch();
    }
    let server;
    try { server = normalizeServer(state.server); }
    catch { return mismatch(); }
    if (server !== state.server) return mismatch();
    const result = await call('resume', { server, resumeHostId: proof.host.id, allowManagedHost: true });
    if (!result.ok) {
      const loginRequired = ['NEEDS_LOGIN', 'UNAUTHORIZED', 'HTTP_401'].includes(result.error?.code);
      writeState(loc, { phase: loginRequired ? 'needs-login' : 'error', issue: result.error,
        ...(loginRequired ? { loginConfirmed: false } : {}) });
      return { ok: false, resumed: false, error: result.error };
    }
    if (result.data?.host?.id !== proof.host.id || result.data?.server !== server || result.data?.host?.connected !== true) {
      return mismatch();
    }
    const id = installationId(state);
    writeState(loc, { phase: 'needs-verification', issue: null, installationId: id });
    saveJSON(path.join(loc.stateDir, 'connection.json'), { ...proof, installation: installation(loc, id) });
    return { ok: true, resumed: true, server, host: { id: proof.host.id, connected: true } };
  });
}
function terminalDiagnostic(proof, engine) {
  const value = proof.terminalDiagnostic;
  if (proof.ok === true || !['pi', 'claude'].includes(engine) || !value
    || value.resourceId !== `terminal_${engine}_main` || value.event !== 'session.resource.deleted'
    || value.phase !== 'before_cleanup') return {};
  return { terminalDiagnostic: { resourceId: value.resourceId, event: value.event, phase: value.phase,
    exitCode: Number.isInteger(value.exitCode) && value.exitCode >= -(2 ** 31) && value.exitCode < 2 ** 31 ? value.exitCode : null } };
}
async function verifyInternal(ctx, { engine, model } = {}) {
  const { loc, call } = ctx; const state = stateOf(loc);
  if (state.enabled === false) return { ok: false, phase: 'disabled' };
  if (state.loginConfirmed !== true) return { ok: false, phase: 'needs-login', error: { code: 'FRESH_LOGIN_REQUIRED', message: '請在 Settings → Omnigent 重新輸入網址、帳號與密碼。' } };
  if (!state.server) return { ok: false, phase: 'needs-setup', error: { code: 'SERVER_REQUIRED', message: '請先設定 Omnigent Server。' } };
  if (engine && !ENGINES.includes(engine)) throw new Error('Unknown engine.');
  const installed = ENGINES.filter(name => ctx.dependencies[name]?.available === true);
  if (!installed.length || (engine && !installed.includes(engine))) {
    writeState(loc, { phase: 'needs-engine', issue: { code: 'NO_AVAILABLE_ENGINE', message: '此環境沒有可連結的指定引擎。插件只連結當下已有的引擎。' } });
    return { ok: false, phase: 'needs-engine', error: stateOf(loc).issue };
  }
  writeState(loc, { phase: 'verifying', issue: null });
  const summary = await queryCatalog(ctx, state);
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
      ...(typeof proof.resolvedModel === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:+-]{0,255}$/.test(proof.resolvedModel)
        ? { resolvedModel: proof.resolvedModel } : {}),
      ...terminalDiagnostic(proof, name),
      ...(proof.cleanup ? { cleanup: proof.cleanup } : {}),
      ...(proof.nativeSubmitRecovered === true ? { nativeSubmitRecovered: true } : {}),
      ...(proof.reply === 'OMNIGENT_CONNECTION_OK' ? { reply: proof.reply } : {}),
      ...(proof.ok !== true || proof.cleanup !== 'stopped' ? { reason: proof.sessionId && proof.cleanup !== 'stopped' ? 'SESSION_STOP_FAILED' : proof.reason || result.error?.code || 'NO_REPLY' } : {}) };
    saveJSON(receiptPath, receipts);
  }
  const ok = !!hostId && installed.every(name => successfulReceipt(receipts[name], state, { id: hostId }, ctx.dependencies[name]));
  writeState(loc, { phase: ok ? 'ready' : 'needs-verification', issue: ok ? null : { code: 'INCOMPLETE_CHAT_VERIFICATION', message: '目前已安裝的引擎必須都收到實際回覆，才能完成設定。' } });
  return { ok, phase: stateOf(loc).phase, server: state.server, installedEngines: installed, verification: receipts };
}
export async function verify(options = {}) {
  const ctx = await context(options);
  return operation(ctx, () => verifyInternal(ctx, options));
}
export async function initialize(options = {}) {
  const initial = await context(options); const { loc, env } = initial;
  return operation(initial, async () => {
    const previous = stateOf(loc);
    if (previous.enabled === false && !options.enable) return { ok: false, phase: 'disabled' };
    // Never persist login inputs: only the normalized non-secret server is state.
    const serverInput = options.server || previous.server;
    const server = serverInput ? normalizeServer(serverInput) : undefined;
    const submittedLogin = options.username !== undefined || options.password !== undefined;
    const requireFresh = submittedLogin || (server && server !== previous.server);
    writeState(loc, { phase: 'installing', ...(server ? { server } : {}), issue: null, enabled: true,
      ...(requireFresh ? { loginConfirmed: false } : {}) });
    if (requireFresh) saveJSON(path.join(loc.stateDir, 'verification.json'), {});
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
      return { ok: false, phase: 'needs-setup', message: '請在 Settings → Omnigent 輸入 Omnigent Server。' };
    }
    const normalized = normalizeServer(target);
    const freshLogin = typeof options.username === 'string' && options.username.trim()
      && typeof options.password === 'string' && options.password;
    if (!freshLogin && (requireFresh || previous.loginConfirmed !== true)) {
      writeState(loc, { phase: 'needs-login', server: normalized, loginConfirmed: false });
      return { ok: false, phase: 'needs-login', server: normalized, error: { code: 'FRESH_LOGIN_REQUIRED', message: '請在 Settings → Omnigent 重新輸入網址、帳號與密碼。' } };
    }
    writeState(loc, { phase: 'connecting', server: normalized });
    const connected = await ctx.call('connect', { server: normalized,
      ...(options.username ? { username: options.username } : {}),
      ...(options.password ? { password: options.password } : {}), allowManagedHost: true });
    if (!connected.ok) {
      const phase = ['NEEDS_LOGIN', 'NEEDS_BROWSER_AUTH', 'needs_login', 'needs_browser_auth'].includes(connected.error?.code) ? 'needs-login' : 'error';
      writeState(loc, { phase, issue: connected.error, ...(phase === 'needs-login' ? { loginConfirmed: false } : {}) });
      return { ok: false, phase, server: normalized, error: connected.error };
    }
    const id = installationId(stateOf(loc));
    writeState(loc, { phase: 'needs-verification', loginConfirmed: true, issue: null, installationId: id });
    if (freshLogin) saveJSON(path.join(loc.stateDir, 'verification.json'), {});
    saveJSON(path.join(loc.stateDir, 'connection.json'), { ...connected.data, installation: installation(loc, id) });
    if (options.verify !== true) return { ok: true, phase: 'needs-verification', server: normalized, connection: connected.data };
    return verifyInternal(ctx);
  });
}
export async function repair(options = {}) { return initialize({ ...options, enable: true }); }
/** Remove only this server's local login and wait for this host to go offline. */
export async function disconnect(options = {}) {
  const ctx = await context(options); const { loc, call } = ctx;
  return operation(ctx, async () => {
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
  return operation(ctx, async () => {
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
export async function setEnabled(value, options = {}) {
  const loc = { ...locations(options.env || process.env), ...(options.loc || {}) };
  return operation({ loc }, async () => {
    saveJSON(path.join(loc.stateDir, 'verification.json'), {});
    return writeState(loc, { enabled: value === true, loginConfirmed: false, phase: value === true ? 'needs-login' : 'disabled' });
  });
}
export function enabled(options = {}) { return stateOf(options.loc || locations()).enabled !== false; }
/** Native package visibility is independent of the explicit CLI enabled flag.
 *  A superseded copy (Pi loads another copy of this package) records nothing:
 *  switching the package source is not a disable, so login and receipts stay. */
export async function observeLifecycle(lifecycle, options = {}) {
  const loc = { ...locations(options.env || process.env), ...(options.loc || {}) };
  if (lifecycle.superseded === true || !fs.existsSync(statePath(loc))
    || !['native-plugin-enabled', 'native-plugin-disabled', 'package-removed-or-unregistered'].includes(lifecycle.reason)) return lifecycle;
  return operation({ loc }, async () => {
    const state = stateOf(loc);
    const changed = state.nativeActive !== lifecycle.active;
    const reset = lifecycle.active === false || state.nativeActive === false;
    if (changed) {
      writeState(loc, { nativeActive: lifecycle.active, ...(reset ? { loginConfirmed: false,
        phase: state.enabled === false ? 'disabled' : 'needs-login', issue: null } : {}) });
      if (reset) saveJSON(path.join(loc.stateDir, 'verification.json'), {});
    }
    return { ...lifecycle, changed, reset: changed && reset };
  });
}
