import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const methods = /^(get|post|put|patch|delete|head|options)$/;
// This is a reviewed inventory/drift gate, not automatic inference of dynamic routing.
// YAML route extraction intentionally accepts only the repository's block style.
export async function restInventory() {
  const operations = [];
  for (const file of (await readdir(resolve(root, 'docs/api')))
    .filter((name) => /\.openapi\.(json|yaml)$/.test(name))
    .sort()) {
    const source = await readFile(resolve(root, 'docs/api', file), 'utf8');
    const append = (method, path, prefix) => {
      const canonical = (prefix + path).replace(/\/$/, '').replace(/\{[^}]+\}/g, '{id}');
      if (!canonical.startsWith('/api/v1/')) throw new Error('Unexpected OpenAPI base: ' + file);
      operations.push({ method: method.toUpperCase(), path: canonical, document: file });
    };
    if (file.endsWith('.json')) {
      const doc = JSON.parse(source);
      const prefix = new URL(doc.servers?.[0]?.url ?? '/', 'http://localhost').pathname.replace(
        /\/$/,
        '',
      );
      for (const [path, item] of Object.entries(doc.paths))
        for (const method of Object.keys(item).filter((key) => methods.test(key)))
          append(method, path, prefix);
    } else {
      const server = source.match(/^\s*- url: (https?:\/\/\S+)/m)?.[1];
      const prefix = new URL(server ?? 'http://localhost').pathname.replace(/\/$/, '');
      let path;
      for (const line of source.split(/\r?\n/)) {
        const match = /^  (\/[^\s]+):\s*$/.exec(line);
        if (match) path = match[1];
        const method = /^    (get|post|put|patch|delete|head|options):\s*$/.exec(line)?.[1];
        if (method) {
          if (!path) throw new Error('Unsupported YAML route style: ' + file);
          append(method, path, prefix);
        }
      }
    }
  }
  const sources = {};
  for (const file of (await readdir(resolve(root, 'apps/api-gateway/src')))
    .filter((name) => /(?:proxy|http|controller)\.ts$/.test(name))
    .sort()) {
    const source = await readFile(resolve(root, 'apps/api-gateway/src', file), 'utf8');
    sources[file] = createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex');
  }
  return {
    version: 1,
    scope:
      'Reviewed OpenAPI inventory and Gateway routing-source fingerprints; executable Plan/Fund coverage in demo1-openapi.test.ts. Not proof that all target SRS APIs exist.',
    operations,
    sources,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const actual = await restInventory();
    if (process.argv.includes('--inventory')) console.log(JSON.stringify(actual, null, 2));
    else {
      const reviewed = JSON.parse(
        await readFile(resolve(root, 'docs/api/runtime-inventory.json'), 'utf8'),
      );
      if (!isDeepStrictEqual(actual, reviewed))
        throw new Error(
          'REST_INVENTORY_DRIFT: review changed Gateway routes and OpenAPI, run executable contract tests, then update docs/api/runtime-inventory.json.',
        );
      console.log(
        'PASS REST inventory: ' +
          actual.operations.length +
          ' documented method/path entries; routing source fingerprints unchanged.',
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
