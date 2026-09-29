import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const base = new URL('../', import.meta.url);
for (const name of ['proto', 'schemas', 'catalog']) {
  await mkdir(new URL(`dist/${name}`, base), { recursive: true });
  await cp(fileURLToPath(new URL(name, base)), fileURLToPath(new URL(`dist/${name}`, base)), { recursive: true });
}
