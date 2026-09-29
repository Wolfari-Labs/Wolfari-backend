import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventCompatibilityErrors } from '../packages/contracts/tools/event-compatibility.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contracts = resolve(root, 'packages/contracts');
const buf = resolve(contracts, 'node_modules/@bufbuild/buf/bin/buf');
const generator = resolve(contracts, 'tools/generate-events.mjs');

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? root, stdio: options.stdio ?? 'inherit', windowsHide: true });
    let stdout = '';
    if (options.stdio === 'pipe') child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited with code ${code}`)));
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

const runBuf = (args, options = {}) => run(process.execPath, [buf, ...args], { cwd: contracts, ...options });

async function generate(outputRoot) {
  const args = ['generate', '.'];
  if (outputRoot) args.push('--output', outputRoot);
  await runBuf(args);
  const eventOutput = outputRoot
    ? resolve(outputRoot, 'src/generated/events.ts')
    : resolve(contracts, 'src/generated/events.ts');
  await run(process.execPath, [generator, '--out', eventOutput], { cwd: contracts });
}

async function files(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path, base));
    else result.push(relative(base, path).replaceAll('\\', '/'));
  }
  return result.sort();
}

async function compareGenerated(expectedRoot) {
  const committedRoot = resolve(contracts, 'src/generated');
  const expectedFiles = await files(expectedRoot);
  const committedFiles = await files(committedRoot);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(committedFiles)) {
    throw new Error(`GENERATED_DRIFT: file list differs\nexpected=${expectedFiles.join(',')}\ncommitted=${committedFiles.join(',')}`);
  }
  for (const name of expectedFiles) {
    const [expected, committed] = await Promise.all([
      readFile(resolve(expectedRoot, name)),
      readFile(resolve(committedRoot, name)),
    ]);
    // Git may check out committed text with CRLF on Windows; generators write LF.
    const normalizeLineEndings = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n');
    if (normalizeLineEndings(expected) !== normalizeLineEndings(committed)) {
      throw new Error(`GENERATED_DRIFT: ${name}`);
    }
  }
}

async function validateCatalogs() {
  const [rpc, events, topology, schema] = await Promise.all([
    readJson('catalog/rpc-v1.json'),
    readJson('catalog/events-v1.json'),
    readJson('catalog/topology-v1.json'),
    readJson('schemas/events-v1.schema.json'),
  ]);
  if (rpc.length !== 19 || new Set(rpc.map(item => `${item.package}.${item.service}/${item.method}`)).size !== 19) {
    throw new Error('RPC_CATALOG_INVALID: expected 19 unique RPCs');
  }
  if (events.length !== 19 || new Set(events.map(item => item.event_type)).size !== 19) {
    throw new Error('EVENT_CATALOG_INVALID: expected 19 unique events');
  }
  const bindings = topology.queues.flatMap(queue => queue.bindings);
  if (bindings.length !== 19 || new Set(bindings).size !== 19 || events.some(item => !bindings.includes(item.event_type))) {
    throw new Error('TOPOLOGY_INVALID: every event must have exactly one consumer binding');
  }
  const variants = schema.allOf.find(item => Array.isArray(item.oneOf) && item.oneOf.some(value => value.properties?.event_type?.const))?.oneOf ?? [];
  if (variants.length !== 19) throw new Error('EVENT_SCHEMA_INVALID: expected 19 event variants');
  const protoText = (await Promise.all((await files(resolve(contracts, 'proto')))
    .filter(name => name.endsWith('.proto'))
    .map(name => readFile(resolve(contracts, 'proto', name), 'utf8')))).join('\n');
  const rpcCount = [...protoText.matchAll(/^\s*rpc\s+\w+\s*\(/gm)].length;
  if (rpcCount !== 19) throw new Error(`PROTO_CATALOG_INVALID: expected 19 RPCs, found ${rpcCount}`);
}

function readJson(path) {
  return readFile(resolve(contracts, path), 'utf8').then(JSON.parse);
}

async function check() {
  await validateCatalogs();
  await mkdir(resolve(root, '.cache'), { recursive: true });
  const temporary = await mkdtemp(resolve(root, '.cache', 'contracts-check-'));
  try {
    await generate(temporary);
    await compareGenerated(resolve(temporary, 'src/generated'));
  } finally {
    if (!temporary.startsWith(resolve(root, '.cache', 'contracts-check-'))) throw new Error('Unsafe temporary path');
    await rm(temporary, { recursive: true, force: true });
  }
  console.log('PASS contract catalogs and generated sources are reproducible.');
}

async function git(args) {
  return run('git', args, { cwd: root, stdio: 'pipe' });
}

async function breaking(reference) {
  if (!reference || !/^[A-Za-z0-9_./-]+$/.test(reference)) {
    throw new Error('Usage: pnpm contracts:breaking --against <git-ref>');
  }
  await git(['rev-parse', '--verify', `${reference}^{commit}`]);
  const paths = (await git(['ls-tree', '-r', '--name-only', reference, '--', 'packages/contracts/proto']))
    .split(/\r?\n/).filter(path => path.endsWith('.proto'));
  let previousSchema;
  try { previousSchema = JSON.parse(await git(['show', `${reference}:packages/contracts/schemas/events-v1.schema.json`])); }
  catch { throw new Error(`NO_BASELINE: ${reference} has no event schema`); }
  if (!paths.length) throw new Error(`NO_BASELINE: ${reference} has no Protobuf contracts`);
  await mkdir(resolve(root, '.cache'), { recursive: true });
  const temporary = await mkdtemp(resolve(root, '.cache', `contracts-breaking-${randomBytes(3).toString('hex')}-`));
  try {
    const baselineProto = resolve(temporary, 'proto');
    for (const path of paths) {
      const destination = resolve(temporary, path.replace(/^packages\/contracts\//, ''));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await git(['show', `${reference}:${path}`]), 'utf8');
    }
    await runBuf(['breaking', 'proto', '--against', baselineProto]);
    const currentSchema = await readJson('schemas/events-v1.schema.json');
    const errors = eventCompatibilityErrors(previousSchema, currentSchema);
    if (errors.length) throw new Error(`EVENT_BREAKING_CHANGE:\n${errors.map(error => `- ${error}`).join('\n')}`);
  } finally {
    if (!temporary.startsWith(resolve(root, '.cache', 'contracts-breaking-'))) throw new Error('Unsafe temporary path');
    await rm(temporary, { recursive: true, force: true });
  }
  console.log(`PASS no breaking contract changes against ${reference}.`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'lint') await runBuf(['lint', '.']);
  else if (command === 'generate') await generate();
  else if (command === 'check') await check();
  else if (command === 'breaking') {
    const index = args.indexOf('--against');
    await breaking(index >= 0 ? args[index + 1] : undefined);
  } else throw new Error('Usage: node scripts/contracts.mjs <lint|generate|check|breaking>');
} catch (error) {
  console.error(`FAIL contracts:${command ?? 'unknown'}:`, error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
