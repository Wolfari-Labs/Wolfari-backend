import net from 'node:net';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

export function controlPath(manifest, component) {
  if (!['backend', 'web', 'operation'].includes(component)) throw new Error('INVALID_DEMO_COMPONENT');
  const name = `wolfari-demo-${manifest.instanceId}-${component}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : resolve(tmpdir(), `${name}.sock`);
}
export async function operationLock(manifest) {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((accept, reject) => {
    server.once('error', () => reject(new Error('DEMO_OPERATION_ALREADY_RUNNING')));
    server.listen(controlPath(manifest, 'operation'), accept);
  });
  return server;
}
export async function serveControl(manifest, component, stop) {
  const server = net.createServer(socket => {
    socket.setTimeout(3000, () => socket.destroy());
    let input = '';
    let handled = false;
    socket.on('data', async chunk => {
      if (handled) return;
      input += chunk.toString();
      if (input.length > 512) return socket.destroy();
      if (!input.includes('\n')) return;
      handled = true;
      if (input.trim() !== manifest.controlToken) { socket.end('denied\n'); return; }
      socket.setTimeout(60000, () => socket.destroy());
      try {
        // Acknowledge completion, not just receipt: no infrastructure shutdown
        // while the owned launcher is still building or closing its children.
        await stop();
        server.close();
        socket.end('stopped\n');
      } catch { socket.end('failed\n'); }
    });
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(controlPath(manifest, component), accept); });
  return server;
}
export async function requestStop(manifest, component) {
  return new Promise((accept, reject) => {
    const socket = net.connect(controlPath(manifest, component));
    socket.setTimeout(60000, () => socket.destroy(new Error('DEMO_CONTROL_TIMEOUT')));
    socket.on('connect', () => socket.write(manifest.controlToken + '\n'));
    let reply = '';
    socket.on('data', chunk => { reply += chunk.toString(); });
    socket.on('end', () => reply.trim() === 'stopped' ? accept(true) : reject(new Error('DEMO_CONTROL_DENIED')));
    socket.on('error', error => ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? accept(false) : reject(error));
  });
}
