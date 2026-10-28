import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { demoRoot } from './demo-config.mjs';
import { connectDatabase } from './migrations.mjs';

export function validateSeedJournal(state, instanceId) {
  if (!state || state.version !== 1 || state.instanceId !== instanceId)
    throw new Error('DEMO_SEED_MANIFEST_MISMATCH');
  if (!state.accounts || typeof state.accounts !== 'object' || Array.isArray(state.accounts))
    throw new Error('DEMO_SEED_ACCOUNTS_INVALID');
  const entries = Object.entries(state.accounts);
  if (
    !entries.length ||
    entries.length > 32 ||
    entries.some(
      ([role, account]) =>
        !/^[a-z][a-z0-9_-]{0,31}$/.test(role) ||
        !account ||
        typeof account.email !== 'string' ||
        !/^[^\s@]+@[^\s@]+$/.test(account.email) ||
        typeof account.password !== 'string' ||
        !account.password,
    )
  )
    throw new Error('DEMO_SEED_ACCOUNTS_INVALID');
  return entries;
}

/** Read-only diagnostics. Never log credentials or create sessions to test passwords. */
export async function inspectDemoAccounts(demo, dependencies = {}) {
  const seedPath = resolve(demoRoot, 'seed.json');
  let state;
  try {
    state = JSON.parse(await (dependencies.readFile ?? readFile)(seedPath, 'utf8'));
  } catch (error) {
    throw new Error(
      error.code === 'ENOENT'
        ? 'DEMO_SEED_MISSING: run demo:seed intentionally; no account was changed.'
        : 'DEMO_SEED_INVALID',
    );
  }
  const entries = validateSeedJournal(state, demo.manifest.instanceId);
  const client = await (dependencies.connect ?? connectDatabase)(
    'identity',
    demo.configs['identity-service'].DATABASE_URL,
  );
  try {
    await client.query('BEGIN READ ONLY');
    const emails = entries.map(([, account]) => account.email.trim().toLowerCase());
    const result = await client.query(
      'SELECT lower(btrim(email)) AS email,status,email_verified_at FROM users WHERE lower(btrim(email))=ANY($1::text[])',
      [emails],
    );
    await client.query('COMMIT');
    return {
      instance_id: demo.manifest.instanceId,
      credentials_file: seedPath,
      passwords: 'NOT_CHECKED; read the local journal privately, never paste it into logs',
      accounts: entries.map(([role, account]) => {
        const row = result.rows.find((value) => value.email === account.email.trim().toLowerCase());
        return {
          role,
          email: account.email,
          status: row?.status ?? 'MISSING',
          verified: Boolean(row?.email_verified_at),
        };
      }),
    };
  } finally {
    await client.end();
  }
}
