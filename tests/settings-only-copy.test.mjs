import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('user-facing messages never direct people to a setup conversation', () => {
  const files = fs.readdirSync(src).filter(name => /\.(mjs|py|ts)$/.test(name));
  assert.ok(files.length > 0);
  for (const name of files) {
    const text = fs.readFileSync(path.join(src, name), 'utf8');
    assert.doesNotMatch(text, /設定對話/, `${name} still points to a setup conversation; binding lives in Settings → Omnigent`);
  }
});
