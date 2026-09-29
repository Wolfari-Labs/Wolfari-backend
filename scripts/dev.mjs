import { fork } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { apps, root, readEnv, appEnvironment } from './config.mjs';
import { run } from './infrastructure.mjs';
import { safeError } from './migrations.mjs';

const children = new Map();
const watchers = [];
let stopping = false;
let reload = Promise.resolve();
let timer;

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timeout = setTimeout(() => child.kill(), 6000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    if (child.connected) child.send('shutdown'); else child.kill();
  });
}
async function stop() {
  if (stopping) return;
  stopping = true; clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  await reload.catch(() => {});
  await Promise.all([...children.values()].map(stopChild));
  // A launcher started by the automated harness has an IPC channel. Close it
  // after every application has shut down so the parent and launcher can exit.
  if (process.connected) process.disconnect();
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('message', message => { if (message === 'shutdown') void stop(); });

async function buildShared() {
  const pnpm = process.env.npm_execpath;
  if (!pnpm) throw new Error('Khởi động bằng corepack pnpm dev.');
  await run(process.execPath, [pnpm, '-r', '--if-present', 'build'], { cwd: root });
}
async function start(app) {
  if (stopping) return;
  const env = appEnvironment(app, await readEnv(resolve(root, 'apps', app.name, '.env')));
  const child = fork(resolve(root, 'apps', app.name, 'dist/main.js'), [], { cwd: root, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  children.set(app.name, child);
  child.on('error', () => { process.exitCode = 1; void stop(); });
  child.on('exit', code => {
    if (!stopping && children.get(app.name) === child) {
      console.error(`${app.name} đã dừng (${code}); dừng các app còn lại.`);
      children.delete(app.name); process.exitCode = 1; void stop();
    }
  });
}
async function restartAll() {
  const old = [...children.values()]; children.clear();
  await Promise.all(old.map(stopChild));
  await buildShared();
  for (const app of apps) await start(app);
}
async function main() {
  // Validate all config files before starting any app.
  for (const app of apps) await readEnv(resolve(root, 'apps', app.name, '.env'));
  await restartAll();
  for (const directory of [...apps.map(app => `apps/${app.name}/src`), 'packages/common/src', 'packages/database/src', 'packages/contracts/src', 'packages/contracts/proto', 'packages/contracts/schemas']) {
    watchers.push(watch(resolve(root, directory), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { reload = reload.then(() => stopping ? undefined : restartAll()).catch(error => { console.error(safeError(error)); process.exitCode = 1; void stop(); }); }, 300);
    }));
  }
  console.log('Wolfari dev đang chạy. Sửa src để tải lại; Ctrl+C để đóng app và pool.');
}
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; void stop(); });
