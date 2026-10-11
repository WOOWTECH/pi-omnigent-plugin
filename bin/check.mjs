import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
for (const directory of ['bin', 'src', 'extensions']) {
  for (const file of await readdir(path.join(root, directory))) {
    const target = path.join(root, directory, file);
    if (file.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', target], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    } else if (file.endsWith('.ts')) {
      stripTypeScriptTypes(await readFile(target, 'utf8'));
    }
  }
}
const python = process.env.PI_OMNIGENT_PYTHON || 'python3';
const result = spawnSync(python, ['-c',
  'import pathlib,sys; [compile(p.read_text(),str(p),"exec") for p in pathlib.Path(sys.argv[1]).glob("*.py")]',
  path.join(root, 'src')], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
console.log('JavaScript, TypeScript and Python syntax checks passed.');
