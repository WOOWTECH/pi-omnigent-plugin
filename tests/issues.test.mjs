import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISSUE_CODES, describeIssue } from '../src/issues.mjs';
import { status } from '../src/runtime.mjs';
import { saveJSON } from '../src/common.mjs';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ACTIONS = ['relogin', 'retry', 'reset-host-id', 'repair', 'verify', 'contact-admin'];
const LITERAL = /(['"])([A-Z][A-Z0-9_]{1,63})\1/g;

// Codes the plugin can put on the wire, read from the sources rather than
// copied by hand: the string literals that follow a code, reason or error key
// on its line (`code: ...`, `.code = ...`, `"reason": ...`, `["reason"] = ...`),
// literals a Python line returns, and PluginError codes (upper-cased, as the
// class does). An f-string code is a family named by its prefix (HTTP_<status>).
function producedCodes() {
  const codes = new Set(), families = new Set();
  const collect = (line, key) => {
    const at = line.search(key);
    if (at >= 0) for (const [, , code] of line.slice(at).matchAll(LITERAL)) codes.add(code);
  };
  for (const name of fs.readdirSync(src).filter(name => /\.(?:mjs|py)$/.test(name))) {
    const text = fs.readFileSync(path.join(src, name), 'utf8');
    if (name.endsWith('.mjs')) {
      for (const line of text.split('\n')) collect(line, /\b(?:code|reason|error)\s*:|\.(?:code|reason)\s*=(?!=)/);
    } else {
      for (const [, , code] of text.matchAll(/PluginError\(\s*(['"])([A-Za-z0-9_]+)\1/g)) codes.add(code.toUpperCase());
      for (const [, , prefix] of text.matchAll(/PluginError\(\s*f(['"])([A-Za-z0-9_]*)\{/g)) families.add(prefix.toUpperCase());
      for (const line of text.split('\n')) collect(line, /['"](?:code|reason)['"]\s*(?::|\]\s*=(?!=))|^\s*return\b/);
    }
  }
  return { codes, families };
}

test('every code produced in src/ has a hint, and every hinted code is still produced', () => {
  const { codes, families } = producedCodes();
  assert.ok(codes.size > 40, `the scan should find the plugin's codes (found ${codes.size})`);
  for (const code of ['NEEDS_RESET_ID', 'CONNECTION_IDENTITY_MISMATCH', 'DEPENDENCIES_MISSING', 'PROVIDER_PAYMENT_REQUIRED'])
    assert.ok(codes.has(code), `scan missed ${code}`);
  const missing = [...codes].filter(code => !ISSUE_CODES.includes(code));
  assert.deepEqual(missing, [], 'add these codes to src/issues.mjs');
  assert.deepEqual([...families], ['HTTP_']);
  for (const prefix of families) {
    assert.ok(ISSUE_CODES.some(code => code.startsWith(prefix)));
    assert.equal(describeIssue({ code: `${prefix}599` }).action, 'retry', `${prefix}<status> is described by status class`);
  }
  const stale = ISSUE_CODES.filter(code => code !== 'UNKNOWN_ISSUE' && !codes.has(code)
    && ![...families].some(prefix => code.startsWith(prefix)));
  assert.deepEqual(stale, [], 'these codes are no longer produced; remove them from src/issues.mjs');
});

// Characters that exist only in Simplified or only in Traditional Chinese, and
// mainland wording that Taiwan writes differently.
const SIMPLIFIED_ONLY = '设务号络录机终连证为错误请这个进们时间输码账网页应无认启动关闭开发现过还让对话检确处断线状态变删装载环项选择际数写读资权联员级执该体区单两实历统预览帮';
const TRADITIONAL_ONLY = '設務號絡錄機終連證為錯誤請這個進們時間輸碼帳網頁應無認啟動關閉開發現過還讓對話檢確處斷線狀態變刪裝載環項選擇際數寫讀資權聯員級執該體區單兩實歷統預覽幫';
const MAINLAND_TERMS = ['服務器', '網絡', '默認', '軟件', '信息', '賬號', '登錄', '文件', '鏈接', '插件'];

test('each code has an action and one next step in English, Taiwan Chinese and Simplified Chinese', () => {
  assert.equal(new Set(ISSUE_CODES).size, ISSUE_CODES.length);
  for (const code of ISSUE_CODES) {
    const described = describeIssue({ code });
    assert.match(code, CODE);
    assert.equal(described.code, code);
    assert.ok(described.action === null || ACTIONS.includes(described.action), `${code}: ${described.action}`);
    assert.deepEqual(Object.keys(described.hints), ['en', 'zh-TW', 'zh-CN']);
    for (const text of Object.values(described.hints)) assert.ok(typeof text === 'string' && text.length > 10, code);
    const { 'zh-TW': taiwan, 'zh-CN': mainland } = described.hints;
    assert.equal([...taiwan].filter(c => SIMPLIFIED_ONLY.includes(c)).join(''), '', `${code} zh-TW uses Simplified characters`);
    assert.equal([...mainland].filter(c => TRADITIONAL_ONLY.includes(c)).join(''), '', `${code} zh-CN uses Traditional characters`);
    assert.deepEqual(MAINLAND_TERMS.filter(term => taiwan.includes(term)), [], `${code} zh-TW should use Taiwan wording`);
  }
});

test('NEEDS_RESET_ID says the host identity belongs to another account and how to reset it', () => {
  const described = describeIssue({ code: 'NEEDS_RESET_ID', message: '此 host ID 屬於另一個 Omnigent 帳號。' });
  assert.equal(described.action, 'reset-host-id');
  assert.equal(described.message, '此 host ID 屬於另一個 Omnigent 帳號。');
  for (const text of Object.values(described.hints)) assert.match(text, /omnigent host reset-id --yes/);
  assert.match(described.hints.en, /another account/);
  assert.match(described.hints['zh-TW'], /已被另一個帳號使用.*終端機.*重新連線/);
  assert.match(described.hints['zh-CN'], /已被另一个账号使用.*终端.*重新连接/);
});

test('unknown, malformed and absent codes stay safe', () => {
  const unknown = describeIssue({ code: 'SOMETHING_NEW', message: 'kept' });
  assert.deepEqual([unknown.code, unknown.action, unknown.message], ['SOMETHING_NEW', null, 'kept']);
  assert.deepEqual(unknown.hints, describeIssue({ code: 'UNKNOWN_ISSUE' }).hints);
  assert.equal(describeIssue({ code: 'HTTP_418' }).action, null);
  for (const code of ['bad code', '', 'x'.repeat(70), 42, undefined, '1_STARTS_WITH_DIGIT'])
    assert.equal(describeIssue({ code }).code, 'UNKNOWN_ISSUE');
  // Adapter codes arrive upper-cased; a lower-case one is still recognised.
  assert.equal(describeIssue({ code: 'needs_login' }).action, 'relogin');
  assert.equal(describeIssue(null), null);
  assert.equal(describeIssue('NEEDS_LOGIN'), null);
});

test('stored message and details are kept; a missing message gets the Taiwan hint', () => {
  const details = ['Add pip or uv to the container image, then retry.'];
  const described = describeIssue({ code: 'DEPENDENCIES_MISSING', message: '依賴安裝未完成。', details });
  assert.equal(described.message, '依賴安裝未完成。');
  assert.deepEqual(described.details, details);
  const bare = describeIssue({ code: 'CONNECTION_IDENTITY_MISMATCH' });
  assert.equal(bare.message, bare.hints['zh-TW']);
  assert.equal('details' in bare, false);
  described.hints.en = 'changed';
  assert.notEqual(describeIssue({ code: 'DEPENDENCIES_MISSING' }).hints.en, 'changed', 'callers cannot alter the table');
});

test('runtime status returns the issue with hints and action', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnigent-issue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loc = { root, home: root, agentDir: root, stateDir: path.join(root, 'state'), omniDir: path.join(root, 'omni'), omniDataDir: path.join(root, 'omni') };
  const options = { loc, dependencies: { ok: true, omnigent: { available: true } },
    callAdapter: async () => ({ ok: true, data: { host: { connected: false } } }) };
  saveJSON(path.join(loc.stateDir, 'state.json'), { enabled: true, phase: 'error', server: 'https://omni.test',
    issue: { code: 'NEEDS_RESET_ID', message: '此 host ID 屬於另一個 Omnigent 帳號。' } });
  const { issue } = await status(options);
  assert.equal(issue.code, 'NEEDS_RESET_ID');
  assert.equal(issue.message, '此 host ID 屬於另一個 Omnigent 帳號。');
  assert.equal(issue.action, 'reset-host-id');
  assert.match(issue.hints['zh-TW'], /omnigent host reset-id --yes/);
  saveJSON(path.join(loc.stateDir, 'state.json'), { enabled: true, phase: 'ready', issue: null });
  assert.equal('issue' in await status(options), false);
});
