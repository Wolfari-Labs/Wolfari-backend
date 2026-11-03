import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import { apps, root, services, appNames } from './config.mjs';
import { compose, infrastructureCheck } from './infrastructure.mjs';
import { migrate, migrationFiles, history, connectDatabase, safeError } from './migrations.mjs';
import {
  demoRoot,
  initDemo,
  loadDemo,
  project,
  assertOwnedResource,
  volumeNames,
} from './demo-config.mjs';
import { serveControl, requestStop, operationLock } from './demo-control.mjs';
import { inspectDemoAccounts } from './demo-accounts.mjs';

const execute = promisify(execFile);
async function docker(args) {
  return (
    await execute('docker', args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
}
async function resources(manifest) {
  const ids = (
    await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])
  )
    .split(/\s+/)
    .filter(Boolean);
  for (const id of ids)
    assertOwnedResource(JSON.parse(await docker(['inspect', id]))[0], manifest, 'container');
  const allVolumes = (await docker(['volume', 'ls', '-q'])).split(/\s+/).filter(Boolean);
  const tagged = (
    await docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])
  )
    .split(/\s+/)
    .filter(Boolean);
  const volumes = [
    ...new Set([
      ...tagged,
      ...volumeNames
        .map((name) => `${project}_${name}`)
        .filter((name) => allVolumes.includes(name)),
    ]),
  ];
  for (const volume of volumes) {
    assertOwnedResource(
      JSON.parse(await docker(['volume', 'inspect', volume]))[0],
      manifest,
      'volume',
    );
    const attached = (await docker(['ps', '-aq', '--filter', `volume=${volume}`]))
      .split(/\s+/)
      .filter(Boolean);
    if (attached.some((id) => !ids.includes(id)))
      throw new Error('DEMO_VOLUME_ATTACHED_TO_FOREIGN_CONTAINER');
  }
  return volumes;
}
async function portFree(port, host = '127.0.0.1') {
  await new Promise((accept, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`PORT_IN_USE: ${host}:${port}`)));
    server.listen(port, host, () => server.close(accept));
  });
}
async function migrateDemo(configs, apply) {
  for (const service of services) {
    const url = configs[appNames[service]].DATABASE_URL;
    const files = await migrationFiles(service);
    if (apply) await migrate(service, url, files);
    const client = await connectDatabase(service, url);
    try {
      const applied = await history(client, files);
      if (applied.length !== files.length) throw new Error(`PENDING_MIGRATIONS: ${service}`);
      console.log(`PASS ${service}: ${applied.join(', ')}`);
    } finally {
      await client.end();
    }
  }
}
export async function checkDemo({ env, configs }, { infrastructure = true } = {}) {
  if (infrastructure) {
    await infrastructureCheck(env);
    await migrateDemo(configs, false);
  }
  const deadline = Date.now() + 90000;
  for (const app of apps) {
    for (const endpoint of [
      'live',
      ...(app.service || app.name === 'api-gateway' ? ['ready'] : []),
    ]) {
      while (true) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${configs[app.name][app.portKey]}/health/${endpoint}`,
            { signal: AbortSignal.timeout(3000) },
          );
          const body = await response.json();
          if (response.ok && body.service === app.name && body.status === 'ok') break;
        } catch {
          /* Startup/reload can temporarily close the HTTP listener. */
        }
        if (Date.now() > deadline) throw new Error(`DEMO_NOT_READY: ${app.name}/${endpoint}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }
  console.log(
    'PASS all demo application health endpoints (not a substitute for API/E2E acceptance).',
  );
  const deliveryChecks = await Promise.all(
    ['identity-service', 'trip-workspace-service', 'automation-service'].map(async (name) => {
      const app = apps.find((value) => value.name === name);
      const deliveryDeadline = Date.now() + 15000;
      do {
        try {
          const response = await fetch(
            `http://127.0.0.1:${configs[name][app.portKey]}/health/dependencies`,
            { signal: AbortSignal.timeout(4000) },
          );
          const body = await response.json();
          const healthy =
            response.ok &&
            body.broker === 'up' &&
            (name !== 'automation-service' || body.smtp === 'up');
          if (healthy) {
            console.log(`PASS delivery dependency: ${name} (not proof of delivery)`);
            return true;
          }
        } catch {
          // Broker reconnects can lag application readiness during startup.
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      } while (Date.now() < deliveryDeadline);
      console.log(`FAIL delivery dependency: ${name}`);
      return false;
    }),
  );
  if (deliveryChecks.some((value) => !value)) throw new Error('DEMO_DELIVERY_NOT_READY');
}
async function stoppedPorts(configs) {
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      for (const app of apps) await portFree(Number(configs[app.name][app.portKey]));
      await portFree(5273, 'localhost');
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  if (command === 'init') {
    if (args.length) throw new Error('UNEXPECTED_ARGUMENTS');
    await initDemo();
    return;
  }
  if (command === 'reset' ? args.join(' ') !== '--confirm wolfari-demo' : args.length)
    throw new Error('Reset requires --confirm wolfari-demo; other commands accept no arguments.');
  const demo = await loadDemo();
  const { manifest, env, configs, composeOptions } = demo;
  if (command === 'check') {
    await resources(manifest);
    await checkDemo(demo);
    return;
  }
  if (command === 'accounts') {
    await resources(manifest);
    console.log(JSON.stringify(await inspectDemoAccounts(demo), null, 2));
    return;
  }
  const operation = await operationLock(manifest);
  try {
    if (command === 'seed' || command === 'api') {
      await resources(manifest);
      await checkDemo(demo);
      const { runDemoScenarios } = await import('./demo-scenarios.mjs');
      await runDemoScenarios(demo, command);
      return;
    }
    if (command === 'stop' || command === 'reset') {
      const volumes = await resources(manifest);
      await requestStop(manifest, 'web');
      await requestStop(manifest, 'backend');
      await stoppedPorts(configs);
      await compose(env, ['down'], composeOptions);
      if (command === 'reset') {
        for (const volume of volumes) {
          assertOwnedResource(
            JSON.parse(await docker(['volume', 'inspect', volume]))[0],
            manifest,
            'volume',
          );
          await docker(['volume', 'rm', volume]);
        }
        await unlink(resolve(demoRoot, 'seed.json')).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
        console.log(
          'Deleted only owned demo volumes and seed manifest. Development untouched. Demo data cannot be recovered without a backup. Run demo:start then demo:seed to recreate.',
        );
      } else console.log('Demo stopped; all volumes retained.');
      return;
    }
    if (command !== 'start') throw new Error('UNKNOWN_DEMO_COMMAND');
    await resources(manifest);
    const existingIds = (
      await docker(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`])
    )
      .split(/\s+/)
      .filter(Boolean);
    const boundPorts = new Set();
    for (const id of existingIds) {
      const container = JSON.parse(await docker(['inspect', id]))[0];
      for (const bindings of Object.values(container.NetworkSettings.Ports ?? {}))
        for (const binding of bindings ?? []) boundPorts.add(Number(binding.HostPort));
    }
    for (const key of [
      'POSTGRES_PORT',
      'RABBITMQ_PORT',
      'RABBITMQ_MANAGEMENT_PORT',
      'MINIO_API_PORT',
      'MINIO_CONSOLE_PORT',
      'MAILPIT_SMTP_PORT',
      'MAILPIT_UI_PORT',
    ]) {
      const port = Number(env[key]);
      if (!boundPorts.has(port)) await portFree(port);
    }
    for (const app of apps) await portFree(Number(configs[app.name][app.portKey]));
    for (const port of [13201, 13202, 13204, 13205]) await portFree(port);
    // Reserve the control channel before any startup side effects; only this launcher owns its child.
    let child;
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      control.close();
      if (child && child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send('shutdown');
        await new Promise((accept) => child.once('exit', accept));
      }
    };
    const control = await serveControl(manifest, 'backend', stop);
    process.on('SIGINT', () => {
      void stop();
    });
    process.on('SIGTERM', () => {
      void stop();
    });
    try {
      await compose(env, ['up', '-d', '--wait', '--wait-timeout', '180'], composeOptions);
      await resources(manifest);
      await infrastructureCheck(env);
      await migrateDemo(configs, true);
      if (stopping) return;
      child = fork(resolve(root, 'scripts/dev.mjs'), ['--demo'], {
        cwd: root,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
      });
      child.once('exit', (code) => {
        if (!stopping) process.exitCode = code || 1;
        control.close();
      });
      child.once('error', () => {
        process.exitCode = 1;
        void stop();
      });
      console.log(
        'Demo backend starting. Use demo:check, then demo:seed in another terminal. Ctrl+C stops backend; demo:stop also stops infrastructure/web.',
      );
    } catch (error) {
      await stop();
      throw error;
    }
  } finally {
    operation.close();
  }
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : '';
  console.error(
    /^(API_FAILED|DEMO_|PORT_IN_USE|PENDING_MIGRATIONS|UNKNOWN_DEMO_COMMAND|Reset requires|UNEXPECTED_ARGUMENTS)/.test(
      message,
    )
      ? message
      : safeError(error),
  );
  process.exitCode = 1;
});
