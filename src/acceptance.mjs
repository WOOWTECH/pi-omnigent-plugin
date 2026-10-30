import { status, catalog, verify } from './runtime.mjs';

/** Explicit chat checks create bounded sessions; default checks never send prompts. */
export async function acceptance(options = {}) {
  const runtime = options.runtime || { status, catalog, verify };
  let current = await runtime.status(options);
  const checks = [];
  const check = (name, ok, details = {}) => checks.push({ name, ok: ok === true, ...details });
  check('enabled', current.enabled);
  check('fresh-login-approved', current.loginConfirmed);
  check('host-online', current.host?.connected);
  check('installed-engines', current.installedEngines?.length > 0, { engines: current.installedEngines || [] });
  let inventory;
  if (current.loginConfirmed && current.enabled) {
    const result = await runtime.catalog(options);
    if (result.ok) inventory = result.data;
    check('catalog-access', result.ok, result.ok ? {} : { error: result.error?.code || 'CATALOG_FAILED' });
    for (const name of current.installedEngines || []) {
      const engine = inventory?.engines?.[name];
      check(`catalog-${name}`, engine?.ready === true && !!engine?.agentId && engine?.models?.length > 0,
        { modelCount: engine?.models?.length || 0, moduleAvailable: !!engine?.agentId });
    }
    if (options.chat === true && inventory?.host?.connected) {
      const names = options.engine ? [options.engine] : current.installedEngines || [];
      for (const engine of names) {
        const result = await runtime.verify({ ...options, engine, ...(options.model ? { model: options.model } : {}) });
        const receipt = result.verification?.[engine];
        check(`chat-${engine}`, !result.busy && !!result.verification && receipt?.ok === true && receipt.reply === 'OMNIGENT_CONNECTION_OK' && receipt.cleanup === 'stopped',
          { ...(receipt?.sessionId ? { sessionId: receipt.sessionId, url: receipt.url } : {}),
            ...(receipt?.model ? { model: receipt.model } : {}),
            ...(receipt?.nativeSubmitRecovered ? { nativeSubmitRecovered: true } : {}),
            ...(receipt?.reason || result.error?.code ? { error: receipt?.reason || result.error?.code } : {}) });
      }
      current = await runtime.status({ ...options, prefetchCatalog: false });
    }
  }
  check('ready', current.phase === 'ready');
  return { schema: 1, checkedAt: new Date().toISOString(), ok: checks.every(item => item.ok),
    phase: current.phase, server: current.server || null, hostId: current.host?.id || null,
    chatRequested: options.chat === true, checks };
}
