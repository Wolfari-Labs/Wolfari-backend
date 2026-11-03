import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import pg from 'pg';
import { demoRoot, loadDemo } from './demo-config.mjs';
import { api, login } from './demo-scenarios.mjs';

// Persist only in the validated, loopback-only demo. Reuse the same 100 trips on retries.
async function layout(instanceId) {
  const path = resolve(demoRoot, 'performance-fixture.json');
  try {
    const users = Array.from({ length: 50 }, () => randomUUID());
    await writeFile(
      path,
      JSON.stringify({
        instanceId,
        users,
        password: randomBytes(24).toString('hex'),
        trips: Array.from({ length: 100 }, () => ({
          id: randomUUID(),
          fund: randomUUID(),
          request: randomUUID(),
          contribution: randomUUID(),
          watchKey: randomUUID(),
        })),
        departure: new Date(Date.now() + 30 * 86400000).toISOString(),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const data = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(data.instanceId, instanceId);
  return data;
}

async function populate(config, work) {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

export async function preparePerformanceUsers() {
  const { configs, manifest } = await loadDemo();
  const { users, trips, password, departure } = await layout(manifest.instanceId);
  assert.equal(new Set(users).size, 50);
  assert.equal(new Set(trips.map((t) => t.id)).size, 100);
  const email = (id) => 'perf-' + id + '@wolfari.test';
  const argon = createRequire(new URL('../apps/identity-service/package.json', import.meta.url))(
    'argon2',
  );
  await populate(configs['identity-service'], async (db) => {
    const hash = await argon.hash(password, {
      type: argon.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    for (const id of users) {
      await db.query(
        "INSERT INTO users(id,email,full_name,email_verified_at) VALUES($1,$2,'TD06 Demo',now()) ON CONFLICT(id) DO NOTHING",
        [id, email(id)],
      );
      await db.query(
        'INSERT INTO credentials(user_id,password_hash,password_changed_at) VALUES($1,$2,now()) ON CONFLICT(user_id) DO NOTHING',
        [id, hash],
      );
    }
  });
  await populate(configs['trip-workspace-service'], async (db) => {
    for (const [i, trip] of trips.entries()) {
      const members = Array.from({ length: 6 }, (_, j) => users[(i + j) % users.length]);
      await db.query(
        `INSERT INTO trips(id,name,start_at,end_at,timezone,created_by_user_id)
        VALUES($1,$2,$3::date AT TIME ZONE 'UTC',($3::date+4)::timestamp AT TIME ZONE 'UTC' - interval '1 second','UTC',$4) ON CONFLICT(id) DO NOTHING`,
        [trip.id, 'TD06 ' + (i + 1), departure.slice(0, 10), members[0]],
      );
      await db.query(
        `INSERT INTO trip_members(trip_id,user_id,role,joined_at)
        SELECT $1,m.id,CASE WHEN m.n=1 THEN 'OWNER' ELSE 'MEMBER' END,now()
        FROM unnest($2::uuid[]) WITH ORDINALITY m(id,n)
        WHERE NOT EXISTS(SELECT 1 FROM trip_members tm WHERE tm.trip_id=$1 AND tm.user_id=m.id AND tm.left_at IS NULL)`,
        [trip.id, members],
      );
      await db.query(
        `INSERT INTO activities(trip_id,title,position,starts_at,ends_at,created_by_user_id)
        SELECT $1,'TD06 Activity '||n,n,t,t+interval '30 min',$3 FROM generate_series(0,39) n
        CROSS JOIN LATERAL (SELECT date_trunc('day',$2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          + interval '1 day'*(n/10)+interval '1 hour'*(8+n%10) AS t) times
        WHERE NOT EXISTS(SELECT 1 FROM activities a WHERE a.trip_id=$1 AND a.position=n)`,
        [trip.id, departure, members[0]],
      );
    }
    const ids = trips.map((trip) => trip.id);
    const groups = await db.query(
      `SELECT trip_id, (starts_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS n
      FROM activities WHERE trip_id=ANY($1::uuid[]) GROUP BY trip_id,day`,
      [ids],
    );
    assert.equal(groups.rowCount, 400);
    assert.ok(groups.rows.every((row) => row.n === 10));
    const days = new Map();
    for (const row of groups.rows) days.set(row.trip_id, (days.get(row.trip_id) ?? 0) + 1);
    assert.equal(days.size, 100);
    assert.ok([...days.values()].every((n) => n === 4));
    const members = await db.query(
      'SELECT trip_id,count(*)::int AS n FROM trip_members WHERE trip_id=ANY($1::uuid[]) AND left_at IS NULL GROUP BY trip_id',
      [ids],
    );
    assert.equal(members.rowCount, 100);
    assert.ok(members.rows.every((row) => row.n === 6));
  });
  await populate(configs['finance-service'], async (db) => {
    for (const [i, t] of trips.entries()) {
      const owner = users[i % 50];
      await db.query(
        "INSERT INTO funds(id,trip_id,holder_user_id,currency,current_balance) VALUES($1,$2,$3,'VND',200000) ON CONFLICT(id) DO NOTHING",
        [t.fund, t.id, owner],
      );
      await db.query(
        "INSERT INTO contribution_requests(id,fund_id,title,created_by_user_id) VALUES($1,$2,'TD06',$3) ON CONFLICT(id) DO NOTHING",
        [t.request, t.fund, owner],
      );
      await db.query(
        `INSERT INTO contributions(id,request_id,fund_id,member_user_id,amount,status,destination_snapshot,destination_version,member_reported_at,confirmed_by_user_id,confirmed_at)
        VALUES($1,$2,$3,$4,200000,'CONFIRMED','{"test":true}',1,now(),$5,now()) ON CONFLICT(id) DO NOTHING`,
        [t.contribution, t.request, t.fund, users[(i + 1) % 50], owner],
      );
      await db.query(
        `INSERT INTO fund_transactions(fund_id,sequence,direction,transaction_type,amount,balance_after,contribution_id,actor_user_id,business_key)
        SELECT $1,1,'IN','CONTRIBUTION',200000,200000,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM fund_transactions WHERE fund_id=$1 AND sequence=1)`,
        [t.fund, t.contribution, owner, 'TD06:' + t.contribution],
      );
    }
  });
  const actors = [];
  for (const id of users) {
    const actor = await login({ email: email(id), password });
    assert.equal(actor.id, id);
    actors.push({ token: actor.access, trips: [] });
  }
  for (const [i, t] of trips.entries()) {
    const actor = actors[i % 50];
    const path = '/api/v1/trips/' + t.id + '/price-watches';
    const access = { access: actor.token };
    const watches = (await api(path, 'GET', undefined, access)).data;
    if (!watches.length)
      await api(
        path,
        'POST',
        {
          provider: 'MOCK_FLIGHT',
          origin: 'DAD',
          destination: 'HAN',
          departure_date: departure.slice(0, 10),
          departure_at: departure,
          journey_type: 'ONE_WAY',
          passengers: { adults: 1 },
          cabin_class: 'ECONOMY',
          currency: 'VND',
          threshold_price: '1',
        },
        access,
        t.watchKey,
        [201],
      );
    actor.trips.push({ trip: t.id, fund: t.fund });
  }
  return actors;
}
