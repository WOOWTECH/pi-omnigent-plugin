import { locations } from './common.mjs';
import { packageLifecycle, inspectLaunchChain, repointRealWeb } from './web.mjs';
import { status } from './runtime.mjs';

const isCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const check = (state, code, details = {}) => ({ status: state, code: code || null, ...details });
const REGISTRATION = { 'native-plugin-disabled': 'PACKAGE_DISABLED', 'package-removed-or-unregistered': 'PACKAGE_NOT_REGISTERED',
  'package-settings-unreadable': 'PACKAGE_SETTINGS_UNREADABLE', 'package-lifecycle-unavailable': 'PACKAGE_LIFECYCLE_UNAVAILABLE' };
// Only means an installed engine has no recorded real reply yet.
const SOFT_ISSUES = new Set(['INCOMPLETE_CHAT_VERIFICATION']);
const HINTS = { REAL_WEB_STALE: 'run pi-omnigent doctor --fix', LOGIN_REQUIRED: 'sign in from Settings → Omnigent',
  LAUNCHER_NOT_INSTALLED: 'run pi-omnigent install-host', VERIFICATION_INCOMPLETE: 'verify each engine from Settings → Omnigent' };
// Package sources are paths or git/npm specs; never echo URL credentials.
const redact = source => typeof source === 'string' ? source.replace(/\/\/[^/@\s]*@/, '//***@') : null;

function registrationCheck(lifecycle) {
  const details = { active: lifecycle.active === true, registered: lifecycle.registered === true, reason: lifecycle.reason || null,
    ...(lifecycle.source ? { source: redact(lifecycle.source), scope: lifecycle.scope || null } : {}) };
  return details.active && details.registered ? check('ok', null, details)
    : check('fail', REGISTRATION[lifecycle.reason] || 'PACKAGE_INACTIVE', details);
}

function realWebCheck(chain) {
  if (!chain) return check('fail', 'HOST_RECORD_UNREADABLE');
  if (!chain.installed) return check('warn', 'LAUNCHER_NOT_INSTALLED', { installed: false });
  const details = { installed: true, mode: chain.mode, recorded: chain.recorded, realWeb: chain.realWeb, source: chain.source,
    rejected: chain.rejected, ...(chain.lastLaunch ? { lastLaunch: chain.lastLaunch } : {}) };
  if (chain.source === 'recorded') return check('ok', null, details);
  return chain.realWeb ? check('fail', 'REAL_WEB_STALE', { ...details, fixable: true })
    : check('fail', 'PI_WEB_UNAVAILABLE', { ...details, fixable: false });
}

function hostCheck(current) {
  if (!current) return check('skip', null, { reason: 'status-unavailable' });
  const host = current.host || {};
  const details = { id: host.id || null, name: host.name || null, connected: host.connected === true, state: host.state || null,
    manager: host.manager || null, managerRunning: host.managerRunning === true, managedProcess: host.managed === true };
  if (details.connected) return check('ok', null, details);
  if (details.state === 'needs-reset-id') return check('fail', 'NEEDS_RESET_ID', details);
  return current.loginConfirmed === true ? check('fail', 'HOST_OFFLINE', details) : check('skip', null, { ...details, reason: 'login-required' });
}

function loginCheck(current) {
  if (!current) return check('skip', null, { reason: 'status-unavailable' });
  const installed = Array.isArray(current.installedEngines) ? current.installedEngines : [];
  const details = { phase: current.phase || null, enabled: current.enabled !== false, loginConfirmed: current.loginConfirmed === true,
    server: current.server || null, installedEngines: installed,
    verification: Object.fromEntries(installed.map(engine => {
      const receipt = current.verification?.[engine] || {};
      return [engine, { ok: receipt.ok === true, ...(isCode(receipt.reason) ? { reason: receipt.reason } : {}),
        ...(typeof receipt.checkedAt === 'string' ? { checkedAt: receipt.checkedAt } : {}) }];
    })) };
  if (!details.enabled) return check('warn', 'PLUGIN_DISABLED', details);
  if (!details.loginConfirmed) return check('fail', 'LOGIN_REQUIRED', details);
  if (details.phase === 'ready') return check('ok', null, details);
  if (details.phase === 'needs-verification') return check('warn', 'VERIFICATION_INCOMPLETE', details);
  return check(details.phase === 'error' ? 'fail' : 'warn', 'NOT_READY', details);
}

function issueCheck(current, failure) {
  const state = isCode(current?.issue?.code) ? current.issue.code : null;
  const adapter = failure || (isCode(current?.error?.code) ? current.error.code : null);
  const codes = [state, adapter].filter(Boolean);
  if (!codes.length) return check('ok', null);
  const blocking = codes.find(code => !SOFT_ISSUES.has(code));
  return check(blocking ? 'fail' : 'warn', blocking || codes[0], { ...(state ? { state } : {}), ...(adapter ? { adapter } : {}) });
}

/**
 * Read-only health report of one installation: package registration (the same
 * lifecycle reader Pi Web uses), the launcher's realWeb, host process/status,
 * login and verification phase, and the current issue code. With fix it only
 * repoints a realWeb that no longer runs; login state is never written.
 */
export async function doctor(options = {}) {
  const env = options.env || process.env;
  const scope = { ...options, env, loc: { ...locations(env), ...(options.loc || {}) } };
  let fix;
  if (options.fix === true) {
    try { fix = repointRealWeb(scope); } catch (error) { fix = { status: 'failed', code: isCode(error?.code) ? error.code : 'FIX_FAILED' }; }
  }
  const lifecycle = await packageLifecycle(scope);
  let chain = null, current = null, failure = null;
  try { chain = inspectLaunchChain(scope); } catch {}
  try { current = await status(scope); } catch (error) { failure = isCode(error?.code) ? error.code : 'STATUS_UNAVAILABLE'; }
  const checks = { registration: registrationCheck(lifecycle), realWeb: realWebCheck(chain), host: hostCheck(current),
    login: loginCheck(current), issue: issueCheck(current, failure) };
  const problems = Object.values(checks).filter(item => item.status === 'warn' || item.status === 'fail');
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), mode: options.fix === true ? 'fix' : 'read-only',
    ok: !problems.some(item => item.status === 'fail'), issues: [...new Set(problems.map(item => item.code).filter(Boolean))],
    checks, ...(fix ? { fix } : {}) };
}

function summary(name, item) {
  if (name === 'registration') return [item.reason, item.source].filter(Boolean).join(' ');
  if (name === 'realWeb') {
    if (!item.installed) return '';
    const missing = item.rejected?.find(entry => entry.source === 'recorded');
    return item.source === 'recorded' ? item.realWeb
      : `${item.recorded || 'none'} ${missing ? missing.problem : 'unusable'}; ${item.realWeb ? `fallback ${item.realWeb} (${item.source})` : 'no runnable pi-web'}`;
  }
  if (name === 'host') return [item.id, item.connected ? 'online' : 'offline', item.state, item.manager && `manager ${item.manager}`].filter(Boolean).join(' ');
  if (name === 'login') return [item.phase, item.server].filter(Boolean).join(' ');
  return [item.state, item.adapter].filter(Boolean).join(' ');
}

/** Human-readable doctor report; --json prints the object itself. */
export function formatDoctor(report) {
  const lines = [`pi-omnigent doctor (${report.mode})`];
  if (report.fix) lines.push(`fix   realWeb      ${report.fix.status}${report.fix.code ? ` ${report.fix.code}` : ''}${report.fix.to ? ` -> ${report.fix.to}` : ''}`);
  for (const [name, item] of Object.entries(report.checks)) {
    const hint = HINTS[item.code] ? ` (${HINTS[item.code]})` : '';
    lines.push(`${item.status.padEnd(5)} ${name.padEnd(12)} ${[item.code, summary(name, item)].filter(Boolean).join(' ')}${hint}`.trimEnd());
  }
  lines.push(`result: ${!report.ok ? report.issues.join(', ') : report.issues.length ? `ok, warnings ${report.issues.join(', ')}` : 'ok'}`);
  return lines.join('\n') + '\n';
}
