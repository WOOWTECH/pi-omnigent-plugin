import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { packageLifecycle, watchPackageLifecycle } from '../src/web.mjs';

type Backend = {
  status(options?: { prefetchCatalog?: boolean }): Promise<any>;
  catalog(options?: { piRefreshWaitMs?: number }): Promise<any>;
  verify(): Promise<any>;
  observeLifecycle?(lifecycle: any): Promise<any>;
};

// These commands only read status, so they skip the Settings page's early catalog
// read; a catalog request waits for a whole Pi model refresh (FULL_CATALOG_WAIT_MS).
const statusOnly = { prefetchCatalog: false };
const fullCatalog = { piRefreshWaitMs: 35_000 };

function jsonResult(value: any) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], details: value };
}

export function connectionFeedback(current: any): string {
  if (current.loginConfirmed !== true || current.host?.connected !== true) {
    return 'Omnigent 設定尚未完成。請到 Pi Web 設定 → Omnigent 填寫連線資料；使用 /omnigent status 查看結果。';
  }
  const lines = ['Omnigent Server 已登入，此容器的主機已在線。模型供應商授權與實際對話驗證尚未全部完成。'];
  for (const name of current.installedEngines || []) {
    const engine = current.engines?.[name];
    const proof = current.verification?.[name];
    if (name === 'claude' && engine?.configured === 'needs-auth') {
      lines.push('Claude Code：尚未登入 Anthropic。請在此容器的終端執行 `claude auth login --claudeai`，完成官方登入。');
    } else if (name === 'codex' && engine?.configured === 'needs-auth') {
      lines.push('Codex：尚未登入 OpenAI。請在此容器的終端執行 `codex login --device-auth`，完成官方授權。');
    } else if (proof?.reason === 'MODELS_UNAVAILABLE' || engine?.configured === 'needs-auth') {
      lines.push(`${name === 'pi' ? 'Pi' : name}：尚未提供可用模型。請在 Pi Web 左下角 Models 設定供應商登入／API key，或在終端啟動 Pi 使用 /login。`);
    } else if (proof?.ok !== true) {
      const code = /^[A-Z_0-9]+$/.test(proof?.reason || '') ? `（${proof.reason}）` : '';
      lines.push(`${name === 'pi' ? 'Pi' : name}：實際對話尚未通過驗證${code}。`);
    }
  }
  lines.push('完成模型授權後，使用 /omnigent verify 重測；不需要重新輸入 Omnigent 帳密。');
  return lines.join('\n\n');
}

/** Exposed separately so tests can inject a backend without touching a live host. */
export function registerOmnigent(pi: ExtensionAPI, backend: Backend, web: any = { packageLifecycle, watchPackageLifecycle }) {
  let stopWatching: (() => Promise<void>) | undefined;
  const show = (content: string, details?: any) => {
    const body = details ? content + '\n\n```json\n' + JSON.stringify(details, null, 2) + '\n```' : content;
    pi.sendMessage({ customType: 'omnigent-plugin', content: body, display: true, ...(details ? { details } : {}) });
  };
  const settingsLink = () => show('請開啟 Pi Web Settings → Omnigent，於設定頁填寫或更新連線資料。');

  pi.on('session_start', async (_event, ctx) => {
    if (!ctx.hasUI || process.env.OMNIGENT_PI_NATIVE_CONFIG || process.env.PI_OMNIGENT_CHILD === '1') return;
    const observe = async (lifecycle: any) => { await backend.observeLifecycle?.(lifecycle); };
    if (web.packageLifecycle) await observe(await web.packageLifecycle({ cwd: ctx.cwd }));
    if (web.watchPackageLifecycle && !stopWatching) stopWatching = web.watchPackageLifecycle(observe, { cwd: ctx.cwd });
  });

  pi.on('session_shutdown', async () => {
    await stopWatching?.(); stopWatching = undefined;
    if (web.packageLifecycle) await backend.observeLifecycle?.(await web.packageLifecycle());
  });

  pi.registerCommand('omnigent', {
    description: 'Omnigent 連線狀態與設定頁：setup | status | catalog | verify | open',
    handler: async (args, ctx) => {
      const action = args.trim() || 'status';
      try {
        if (['setup', 'reconnect', 'disconnect', 'repair'].includes(action)) { settingsLink(); return; }
        if (action === 'status') { const result = await backend.status(statusOnly); show(result.phase === 'ready' ? 'Omnigent 連線狀態' : connectionFeedback(result), result); return; }
        if (action === 'catalog') { show('Omnigent 模型與模組', await backend.catalog(fullCatalog)); return; }
        if (action === 'verify') { show('Omnigent 對話驗證結果', await backend.verify()); return; }
        if (action === 'open') {
          const current = await backend.status(statusOnly);
          if (!current.server) { settingsLink(); return; }
          show(`[開啟 Omnigent](${current.server})`); return;
        }
        ctx.ui.notify('使用 /omnigent setup 開啟設定頁，或使用 status、catalog、verify、open。', 'info');
      } catch { ctx.ui.notify('Omnigent 操作未完成。請到 Pi Web 設定 → Omnigent 檢查連線。', 'warning'); }
    },
  });

  for (const [name, label, description, operation] of [
    ['omnigent_status', 'Omnigent 狀態', 'Read Omnigent connection, host, and engine status. Returns safe metadata only.', () => backend.status(statusOnly)],
    ['omnigent_catalog', 'Omnigent 模型與模組', 'List available Omnigent engines, models, modules, and their availability.', () => backend.catalog(fullCatalog)],
    ['omnigent_verify', 'Omnigent 對話驗證', 'Verify conversation connectivity for the currently installed engines through Omnigent.', () => backend.verify()],
    ['omnigent_open', '開啟 Omnigent', 'Return the configured Omnigent web URL. Login secrets are never included.', async () => { const current = await backend.status(statusOnly); return { phase: current.phase, url: current.server || null }; }],
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
