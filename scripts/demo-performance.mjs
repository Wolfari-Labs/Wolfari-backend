import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { demoRoot, loadManifest } from './demo-config.mjs';
import { operationLock } from './demo-control.mjs';
import { preparePerformanceUsers } from './performance-fixture.mjs';

const profiles = {
  PERF01: { users: 5, ramp: 5, warm: 10, seconds: 30 },
  PERF02: { users: 50, ramp: 10, warm: 60, seconds: 600 },
};
const id = process.argv[2];
if (!Object.hasOwn(profiles, id)) throw new Error('Use PERF01 or PERF02');
const { users, ramp, warm, seconds } = profiles[id];
const lock = await operationLock(await loadManifest());
try {
  await run();
} finally {
  lock.close();
}

async function run() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const jar = resolve(
    process.env.JMETER_HOME ?? join(demoRoot, 'tools/apache-jmeter-5.6.3'),
    'bin/ApacheJMeter.jar',
  );
  await access(jar);
  const reports = join(demoRoot, 'reports');
  await mkdir(reports, { recursive: true });
  const dir = await mkdtemp(join(reports, id + '-'));
  const csv = join(dir, 'samples.csv');
  const credentials = join(demoRoot, 'performance-sessions-' + randomUUID() + '.private.json');
  const actors = await preparePerformanceUsers();
  await writeFile(credentials, JSON.stringify(actors.slice(0, users)), { flag: 'wx', mode: 0o600 });
  try {
    const args = [
      '-jar',
      jar,
      '-n',
      '-t',
      resolve('scripts/performance/read-apis.jmx'),
      '-l',
      csv,
      '-j',
      join(dir, 'jmeter.log'),
      '-Jfixture=' + credentials,
      '-Jusers=' + users,
      '-Jramp=' + ramp,
      '-Jduration=' + (ramp + warm + seconds + 6),
      '-Jjmeter.save.saveservice.timestamp_format=ms',
      '-Jsampleresult.timestamp.start=true',
      '-Jjmeter.save.saveservice.response_message=false',
      '-Jjmeter.save.saveservice.assertion_results_failure_message=false',
    ];
    const code = await new Promise((done, reject) => {
      const child = spawn(process.env.JMETER_JAVA ?? 'java', args, {
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', done);
    });
    assert.equal(code, 0, 'JMeter process failed');
  } finally {
    await unlink(credentials);
  }
  const [header, ...lines] = (await readFile(csv, 'utf8')).trim().split(/\r?\n/);
  const keys = header.split(',');
  const rows = lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [keys[i], v])));
  assert.ok(rows.length, 'No HTTP samples');
  const start =
    Math.min(...rows.slice(0, users * 3).map((r) => Number(r.timeStamp))) + (ramp + warm) * 1000;
  const end = start + seconds * 1000;
  assert.ok(
    rows.some((r) => Number(r.timeStamp) >= end),
    'Incomplete run',
  );
  const measured = rows.filter((r) => Number(r.timeStamp) >= start && Number(r.timeStamp) < end);
  function metrics(samples) {
    assert.ok(samples.length, 'Missing endpoint samples');
    const times = samples.map((r) => Number(r.elapsed)).sort((a, b) => a - b);
    const failures = samples.filter((r) => r.success !== 'true').length;
    return {
      requests: samples.length,
      errors: failures,
      errorRate: failures / samples.length,
      throughputRps: samples.length / seconds,
      p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    };
  }
  const endpoints = Object.fromEntries(
    ['Plan', 'SoQuy', 'Watch'].map((label) => [
      label,
      metrics(measured.filter((r) => r.label === label)),
    ]),
  );
  const activeUsers = new Set(measured.map((r) => r.threadName)).size;
  const minThreads = Math.min(...measured.map((r) => Number(r.grpThreads)));
  const result = {
    id,
    commit,
    dirty: Boolean(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        encoding: 'utf8',
      }).trim(),
    ),
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(end).toISOString(),
    users,
    activeUsers,
    minThreads,
    ramp,
    warm,
    seconds,
    dataset: { trips: 100, memberships: 600, activities: 4000, funds: 100, watches: 100 },
    overall: metrics(measured),
    endpoints,
  };
  await writeFile(join(dir, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(dir, JSON.stringify(result, null, 2));
  assert.equal(activeUsers, users);
  assert.equal(minThreads, users, 'Not all users remained active throughout the measurement');
  assert.equal(result.overall.errors, 0, 'Errors during measurement');
  if (id === 'PERF02')
    assert.ok(
      Object.values(endpoints).every((m) => m.p95Ms < 2000),
      'NFR-P01 requires p95 < 2000 ms',
    );
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    commit,
    'Checkout changed during measurement',
  );
}
