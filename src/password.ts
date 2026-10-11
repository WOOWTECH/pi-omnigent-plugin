/** Secret input stays in the component closure; rendered lines contain bullets only. */
export function createPasswordComponent(title: string, requestRender: () => void, done: (value: string | undefined) => void) {
  let value = '';
  let settled = false;
  const finish = (result: string | undefined) => {
    if (settled) return;
    settled = true;
    value = '';
    done(result);
  };
  return {
    render(width: number): string[] {
      const mask = '•'.repeat(Math.min(Array.from(value).length, Math.max(1, width - 4)));
      return [title, '', `  ${mask || '（尚未輸入）'}`, '', 'Enter：送出　Esc：取消　Ctrl+U：清空', '密碼不會寫入對話或傳給模型。'];
    },
    handleInput(data: string) {
      if (settled) return;
      if (data === '\x1b' || data === '\x03') { finish(undefined); return; }
      if (data === '\r' || data === '\n') { if (value) finish(value); return; }
      if (data === '\x15') value = '';
      else if (data === '\x7f' || data === '\b') value = Array.from(value).slice(0, -1).join('');
      else if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
        value += data.slice(6, -6).replace(/[\x00-\x1f\x7f]/g, '');
      } else if (!data.includes('\x1b')) value += data.replace(/[\x00-\x1f\x7f]/g, '');
      requestRender();
    },
    dispose() { settled = true; value = ''; },
  };
}

export async function requestPassword(ctx: any, title = 'Omnigent 密碼'): Promise<string | undefined> {
  if (!ctx.hasUI || typeof ctx.ui.custom !== 'function') return undefined;
  return ctx.ui.custom((tui: any, _theme: any, _keys: any, done: (value: string | undefined) => void) =>
    createPasswordComponent(title, () => tui.requestRender(), done));
}
