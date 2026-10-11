import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { requestPassword } from '../src/password.ts';
import { ensureOnboarding, readOnboarding } from '../src/web.mjs';

const singletonKey = Symbol.for('pi-omnigent-plugin/onboarding/v1');
const registry: Set<string> = (globalThis as any)[singletonKey] ||= new Set<string>();

type Backend = {
  initialize(options?: { server?: string; username?: string; password?: string; verify?: boolean }): Promise<any>;
  status(): Promise<any>;
  catalog(): Promise<any>;
  verify(): Promise<any>;
  repair(): Promise<any>;
  disconnect(): Promise<any>;
};

function jsonResult(value: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: value };
}

/** Exposed separately so tests can inject a backend without touching a live host. */
export function registerOmnigent(pi: ExtensionAPI, backend: Backend, web = { ensureOnboarding, readOnboarding }) {
  let disposed = false;
  const owned = new Set<string>();
  const show = (content: string, details?: any) => pi.sendMessage({ customType: 'omnigent-plugin', content: details ? `${content}\n\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\`` : content, display: true, ...(details ? { details } : {}) });
  const safeFailure = (ctx: any) => { if (!disposed) ctx.ui.notify('Omnigent 設定尚未完成。請執行 /omnigent setup 繼續。', 'warning'); };

  async function wizard(ctx: any, { force = false } = {}) {
    if (disposed || !ctx.hasUI) return;
    const key = ctx.sessionManager.getSessionId();
    if (registry.has(key)) return;
    registry.add(key); owned.add(key);
    try {
      let current = await backend.status();
      if (current.phase === 'ready' && !force) { show('Omnigent 已連線。使用 /omnigent open 開啟介面，或 /omnigent status 檢查目前已安裝的引擎。'); return; }
      if (current.phase === 'disabled') { ctx.ui.notify('Omnigent 插件已停用。使用 /omnigent repair 明確啟用並修復。', 'info'); return; }
      ctx.ui.setStatus('omnigent', 'Omnigent：等待連線設定');
      show('正在建立 Omnigent 連線。請在設定面板填寫伺服器與登入資料；密碼使用遮蔽欄位，不要貼在對話中。');
      const server = await ctx.ui.input('Omnigent Server URL', current.server || 'https://omnigent.example.com');
      if (!server || disposed) return;
      const username = await ctx.ui.input('Omnigent 帳號', '請輸入登入帳號');
      if (!username || disposed) return;
      let password = await requestPassword(ctx);
      if (!password || disposed) { ctx.ui.notify('尚未提供密碼，設定已保留，可使用 /omnigent setup 重試。', 'info'); return; }
      try { current = await backend.initialize({ server: server.trim(), username: username.trim(), password, verify: true }); }
      finally { password = undefined; }
      if (disposed) return;
      const result = await backend.status();
      show(result.phase === 'ready'
        ? 'Omnigent 連線與對話驗證完成。使用 /omnigent open 開啟 Omnigent，選擇引擎、模型與模組開始對話。'
        : 'Omnigent 設定已執行；仍有項目需要處理。使用 /omnigent status 查看結果，或 /omnigent repair 重試。', result);
      ctx.ui.setStatus('omnigent', result.phase === 'ready' ? 'Omnigent：已連線' : 'Omnigent：需要處理');
    } finally { registry.delete(key); owned.delete(key); }
  }

  pi.on('session_start', async (_event, ctx) => {
    disposed = false;
    if (!ctx.hasUI || process.env.OMNIGENT_PI_NATIVE_CONFIG || process.env.PI_OMNIGENT_CHILD === '1') return;
    const current = await backend.status();
    if (current.phase === 'disabled') return;
    const onboarding = await web.ensureOnboarding({ cwd: ctx.cwd, ready: current.phase === 'ready' });
    if (onboarding.sessionId === ctx.sessionManager.getSessionId() && current.phase !== 'ready') {
      // Pi Web waits for session_start before serving agent commands. The UI flow
      // runs after that binding returns, so attaching the browser cannot deadlock.
      void wizard(ctx).catch(() => safeFailure(ctx));
    } else if (current.phase !== 'ready' && onboarding.url) {
      show(`Omnigent 尚待設定：[開啟連線設定對話](${onboarding.url})。也可執行 /omnigent setup。`);
    }
    ctx.ui.setStatus('omnigent', current.phase === 'ready' ? 'Omnigent：已連線' : 'Omnigent：等待設定');
  });

  pi.on('session_shutdown', async () => {
    disposed = true;
    for (const key of owned) registry.delete(key);
    owned.clear();
  });

  pi.registerCommand('omnigent', {
    description: 'Omnigent 連線管理：setup | status | catalog | verify | open | disconnect | reconnect | repair',
    handler: async (args, ctx) => {
      const action = args.trim() || 'status';
      try {
        if (action === 'setup') { await wizard(ctx, { force: true }); return; }
        if (action === 'disconnect' || action === 'reconnect') {
          const result = await backend.disconnect();
          show('Omnigent 取消連結結果', result);
          if (action === 'reconnect' && result.ok === true) await wizard(ctx, { force: true });
          return;
        }
        if (action === 'status') { show('Omnigent 連線狀態', await backend.status()); return; }
        if (action === 'catalog') { show('Omnigent 模型與模組', await backend.catalog()); return; }
        if (action === 'verify') { show('Omnigent 對話驗證結果', await backend.verify()); return; }
        if (action === 'open') {
          const current = await backend.status();
          if (!current.server) { ctx.ui.notify('請先執行 /omnigent setup 設定伺服器。', 'info'); return; }
          show(`[開啟 Omnigent](${current.server})`); return;
        }
        if (action === 'repair') { show('Omnigent 修復結果', await backend.repair()); return; }
        ctx.ui.notify('使用 /omnigent setup、status、catalog、verify、open、disconnect、reconnect 或 repair。', 'info');
      } catch { safeFailure(ctx); }
    },
  });

  for (const [name, label, description, operation] of [
    ['omnigent_status', 'Omnigent 狀態', 'Read Omnigent connection, host, and engine status. Returns safe metadata only.', () => backend.status()],
    ['omnigent_catalog', 'Omnigent 模型與模組', 'List available Omnigent engines, models, modules, and their availability.', () => backend.catalog()],
    ['omnigent_verify', 'Omnigent 對話驗證', 'Verify conversation connectivity for the currently installed engines through Omnigent.', () => backend.verify()],
    ['omnigent_open', '開啟 Omnigent', 'Return the configured Omnigent web URL. Login secrets are never included.', async () => { const current = await backend.status(); return { phase: current.phase, url: current.server || null }; }],
  ] as const) {
    pi.registerTool({ name, label, description, parameters: Type.Object({}),
      execute: async () => { try { return jsonResult(await operation()); } catch { return jsonResult({ phase: 'error', reason: 'Omnigent operation failed; inspect /omnigent status.' }); } },
    });
  }
}

export default async function omnigentExtension(pi: ExtensionAPI) {
  const backend = await import('../src/runtime.mjs');
  registerOmnigent(pi, backend as Backend);
}
