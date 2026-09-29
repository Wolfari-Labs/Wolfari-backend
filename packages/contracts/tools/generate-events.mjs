import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const contractRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputFlag = process.argv.indexOf('--out');
const output = outputFlag >= 0 && process.argv[outputFlag + 1]
  ? resolve(process.argv[outputFlag + 1])
  : resolve(contractRoot, 'src/generated/events.ts');
const schema = JSON.parse(await readFile(resolve(contractRoot, 'schemas/events-v1.schema.json'), 'utf8'));
const source = await compile(schema, 'WolfariEventV1', {
  bannerComment: '/* Generated from schemas/events-v1.schema.json. Do not edit by hand. */',
  style: { singleQuote: true, semi: true, tabWidth: 2 },
  unknownAny: true,
});
await mkdir(dirname(output), { recursive: true });
await writeFile(output, source, 'utf8');
