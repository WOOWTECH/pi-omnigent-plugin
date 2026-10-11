import { spawn } from 'node:child_process';
import { discover } from '../src/installer.mjs';
const tools = await discover();
const python = process.env.PI_OMNIGENT_TEST_PYTHON || tools.omnigent?.python || tools.python?.path;
if (!python) {
  process.stderr.write('Adapter tests need Python with omnigent==0.16.0 installed.\n');
  process.exitCode = 1;
} else {
  const child = spawn(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], { stdio: 'inherit' });
  child.on('error', () => { process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
