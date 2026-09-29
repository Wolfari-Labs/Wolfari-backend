import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import { apps, initEnvironment, root } from './config.mjs';

const output = [];
let child;

function waitForExit(process, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    if (process.exitCode !== null) { resolvePromise(process.exitCode); return; }
    const timer = setTimeout(() => reject(new Error('DEV_SHUTDOWN_TIMEOUT')), timeoutMs);
    process.once('exit', code => { clearTimeout(timer); resolvePromise(code); });
  });
}

async function waitForLiveness(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(apps.map(app => app.name));
  while (pending.size && Date.now() < deadline) {
    for (const app of apps.filter(item => pending.has(item.name))) {
      try {
        const response = await fetch(`http://127.0.0.1:${app.port}/health/live`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) pending.delete(app.name);
      } catch { /* app is still starting */ }
    }
    if (pending.size) await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
  }
  if (pending.size) throw new Error(`DEV_START_TIMEOUT: ${[...pending].join(', ')}`);
}

try {
  await initEnvironment(root);
  if (!process.env.npm_execpath) throw new Error('Run through corepack pnpm dev:test');
  child = fork(resolve(root, 'scripts/dev.mjs'), [], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  await waitForLiveness(30_000);
  console.log('PASS launcher started 7 liveness endpoints.');
  if (process.platform === 'win32') {
    child.send('shutdown');
    console.log('PASS requested graceful shutdown through IPC (Windows automation path).');
  } else {
    child.kill('SIGINT');
    console.log('PASS requested graceful shutdown through SIGINT.');
  }
  const code = await waitForExit(child, 12_000);
  if (code !== 0) throw new Error(`DEV_EXIT_${code}: ${output.join('').slice(-2000)}`);
  console.log('PASS launcher stopped all child applications.');
} catch (error) {
  console.error('FAIL dev:test:', error instanceof Error ? error.message : error);
  if (output.length) console.error(output.join('').slice(-4000));
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    if (child.connected) child.send('shutdown');
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 5000).unref();
  }
}
