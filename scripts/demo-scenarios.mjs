import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { demoRoot, publicConfig } from './demo-config.mjs';

export async function waitFor(work, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const result = await work();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('DEMO_SCENARIO_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
export async function mailLink(email, subject, after = 0) {
  return waitFor(async () => {
    const list = await (await fetch(publicConfig.mailpitUrl + '/api/v1/messages?limit=500', { signal: AbortSignal.timeout(5000) })).json();
    const matches = list.messages.filter(item => item.To?.some(to => to.Address === email) && item.Subject.includes(subject) && Date.parse(item.Created) >= after);
    matches.sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created));
    if (!matches.length) return null;
    const detail = await (await fetch(publicConfig.mailpitUrl + '/api/v1/message/' + matches[0].ID)).json();
    const link = detail.Text.match(/https?:\/\/[^\s]+/)?.[0];
    if (!link || new URL(link).origin !== publicConfig.webUrl) throw new Error('DEMO_MAIL_LINK_WRONG_ORIGIN');
    return link;
  });
}
export async function api(path, method = 'GET', body, actor, key, expected = [200]) {
  const headers = { 'x-client-type': 'mobile', ...(actor ? { authorization: `Bearer ${actor.access}` } : {}), ...(key ? { 'idempotency-key': key } : {}) };
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const response = await fetch(publicConfig.gatewayUrl + path, { method, headers, ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const data = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (!expected.includes(response.status)) throw new Error(`API_FAILED ${method} ${path.split('?')[0]} status=${response.status} code=${data?.error?.code ?? 'unknown'}`);
  return { status: response.status, data: data?.data, meta: data?.meta };
}
export async function login(account) {
  const result = await api('/api/v1/auth/login', 'POST', { email: account.email, password: account.password });
  return { ...account, id: result.data.profile.id, access: result.data.access_token, sessionId: result.data.session_id };
}
async function save(path, value) {
  await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
}
export async function runDemoScenarios(demo, command) {
  const report = { startedAt: new Date().toISOString(), project: demo.manifest.project, kind: command, evidence: 'REAL_GATEWAY_AND_SERVICES', providers: { priceWatch: 'MOCK_FLIGHT', momo: 'disabled; isolated test harness only' }, checks: [] };
  report.runId = randomUUID();
  const execute = promisify(execFile);
  report.backendSha = (await execute('git', ['rev-parse', 'HEAD'], { cwd: publicConfig.backendRoot, windowsHide: true })).stdout.trim();
  report.uncommittedChanges = Boolean((await execute('git', ['status', '--porcelain'], { cwd: publicConfig.backendRoot, windowsHide: true })).stdout.trim());
  const pass = name => { report.checks.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); };
  const seedPath = resolve(demoRoot, 'seed.json');
  let state;
  try {
    try { state = JSON.parse(await readFile(seedPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!state) {
      state = { version: 1, instanceId: demo.manifest.instanceId, createdAt: new Date().toISOString(), operations: {}, accounts: {} };
      for (const role of ['owner', 'holder', 'member', 'outsider']) state.accounts[role] = { email: `demo-${role}@wolfari.test`, password: `Wolfari-${randomBytes(18).toString('base64url')}-9!`, fullName: `Demo ${role}` };
      await save(seedPath, state);
    }
    if (state.version !== 1 || state.instanceId !== demo.manifest.instanceId) throw new Error('DEMO_SEED_MANIFEST_MISMATCH');
    const actors = {};
    for (const [role, account] of Object.entries(state.accounts)) {
      let response = await api('/api/v1/auth/login', 'POST', { email: account.email, password: account.password }, undefined, undefined, [200, 401]);
      if (response.status === 401) {
        await api('/api/v1/auth/register', 'POST', { email: account.email, password: account.password, full_name: account.fullName }, undefined, undefined, [202]);
        response = await api('/api/v1/auth/login', 'POST', { email: account.email, password: account.password });
      }
      actors[role] = { ...account, id: response.data.profile.id, access: response.data.access_token, sessionId: response.data.session_id };
      if (!response.data.profile.email_verified_at) {
        const link = await mailLink(account.email, 'Xác minh');
        await api('/api/v1/auth/email-verifications/confirm', 'POST', { token: new URL(link).searchParams.get('token') });
      }
    }
    pass('Auth: four real accounts verified through RabbitMQ/Automation/Mailpit');
    let journalPath = seedPath;
    if (command === 'api') {
      journalPath = resolve(demoRoot, `scenario-${randomUUID()}.json`);
      state = { version: 1, instanceId: state.instanceId, createdAt: new Date().toISOString(), operations: {}, accounts: state.accounts };
      await save(journalPath, state);
    }
    async function step(name, prepare, expected = [200, 201]) {
      let entry = state.operations[name];
      if (entry?.complete) return entry.result;
      if (!entry) {
        const prepared = await prepare();
        entry = { ...prepared, key: prepared.body?.client_request_id ?? randomUUID() };
        state.operations[name] = entry; await save(journalPath, state);
      }
      // Trip creation binds the public client_request_id to its idempotency key.
      if (entry.path === '/api/v1/trips') entry.key = entry.body.client_request_id;
      const actor = actors[entry.actor ?? 'owner'];
      let result = await api(entry.path, entry.method ?? 'POST', entry.body, actor, entry.key, [...expected, 202]);
      if (result.status === 202) {
        await waitFor(async () => {
          const operation = await api(`/api/v1/operations/${entry.key}`, 'GET', undefined, actor);
          if (operation.data.state === 'FAILED') throw new Error(`DEMO_OPERATION_FAILED: ${name}`);
          return operation.data.state === 'SUCCEEDED';
        });
        result = await api(entry.path, entry.method ?? 'POST', entry.body, actor, entry.key, expected);
      }
      entry.complete = true; entry.result = result.data; await save(journalPath, state);
      return result.data;
    }
    const { owner, holder, member, outsider } = actors;
    const trip = await step('trip', async () => {
      const start = new Date(Date.parse(state.createdAt) + 7 * 86400000);
      return { path: '/api/v1/trips', body: { name: command === 'seed' ? 'Wolfari Demo — Đà Nẵng' : `API acceptance ${state.createdAt}`, start_at: start.toISOString(), end_at: new Date(+start + 3 * 86400000).toISOString(), client_request_id: randomUUID() } };
    });
    const base = `/api/v1/trips/${trip.id}`;
    const getTrip = async () => (await api(base, 'GET', undefined, owner)).data;
    for (const role of ['holder', 'member']) {
      const invitation = await step(`invite-${role}`, async () => ({ path: base + '/invitations', body: { invitation_type: 'EMAIL', email: actors[role].email, expected_membership_revision: (await getTrip()).membership_revision } }));
      await step(`accept-${role}`, async () => {
        const link = await mailLink(actors[role].email, 'Lời mời', Date.parse(state.createdAt) - 1000);
        const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
        if (!token) throw new Error('DEMO_INVITATION_TOKEN_MISSING');
        return { path: '/api/v1/invitations/accept', actor: role, body: { token } };
      });
      if (!invitation) throw new Error('DEMO_INVITATION_MISSING');
    }
    await step('pending-invitation', async () => ({ path: base + '/invitations', body: { invitation_type: 'EMAIL', email: outsider.email, expected_membership_revision: (await getTrip()).membership_revision } }));
    await step('pending-link', async () => ({ path: base + '/invitations', body: { invitation_type: 'LINK', expected_membership_revision: (await getTrip()).membership_revision } }));
    pass('Trip/Members: real EMAIL acceptance; pending EMAIL/LINK invitations');
    const plan = async () => (await api(base + '/plan', 'GET', undefined, owner)).data;
    for (const [index, title] of ['Ăn sáng cùng nhóm', 'Tham quan thành phố', 'Tổng kết chuyến đi'].entries()) {
      await step(`activity-${index}`, async () => ({ path: base + '/activities', body: { title, activity_type: 'OTHER', position: index, expected_plan_version: (await plan()).plan_version } }));
    }
    pass('Activity: three persistent server activities');
    const profile = (await api('/api/v1/me', 'GET', undefined, owner)).data;
    if (!profile.avatar && command === 'seed') {
      const require = createRequire(new URL('../apps/identity-service/package.json', import.meta.url));
      const image = await require('sharp')({ create: { width: 64, height: 64, channels: 3, background: '#23614d' } }).png().toBuffer();
      const form = new FormData(); form.set('file', new Blob([image], { type: 'image/png' }), 'demo-avatar.png');
      const upload = await api('/api/v1/me/avatar', 'POST', form, owner, undefined, [201]);
      await api('/api/v1/me', 'PATCH', { expected_version: profile.version, avatar_object_key: upload.data.object_key }, owner);
    }
    pass('Profile: persisted profile; demo avatar uses real private MinIO');
    const fund = await step('fund', async () => ({ path: base + '/fund', body: { holder_user_id: holder.id, currency: 'VND', destination: { destination_type: 'VIETQR', bank_code: 'TEST', account_number: '000987654321', account_name: 'DEMO ONLY - NOT A REAL ACCOUNT', active: true, is_default: true } } }));
    const fundBase = `/api/v1/funds/${fund.id}`;
    const getFund = async () => (await api(base + '/fund', 'GET', undefined, owner)).data;
    const destinations = (await api(fundBase + '/destinations', 'GET', undefined, owner)).data;
    const destination = destinations[0];
    await step('confirm-destination', async () => ({ path: `${fundBase}/destinations/${destination.id}/confirm`, actor: 'holder', body: { expected_version: destination.version, expected_finance_version: (await getFund()).finance_version } }));
    const contributions = await step('contribution-request', async () => ({ path: fundBase + '/contribution-requests', body: { title: 'Chi phí chuyến đi demo', contributions: [{ member_user_id: member.id, amount: '500000', destination_id: destination.id }], expected_finance_version: (await getFund()).finance_version } }));
    const contributionId = contributions.contributions[0].id;
    const getContribution = async () => {
      const list = (await api(fundBase + '/contributions?limit=100', 'GET', undefined, member)).data.items;
      const item = list.find(value => value.id === contributionId);
      if (!item) throw new Error('DEMO_CONTRIBUTION_MISSING');
      return item;
    };
    const versions = async () => ({ expected_version: (await getContribution()).version, expected_finance_version: (await getFund()).finance_version });
    await step('report-transfer', async () => ({ path: `/api/v1/contributions/${contributionId}/report-transfer`, actor: 'member', body: await versions() }));
    await step('confirm-received', async () => ({ path: `/api/v1/contributions/${contributionId}/confirm-received`, actor: 'holder', body: await versions() }));
    await step('financial-note', async () => ({ path: fundBase + '/notes', body: { description: 'Ghi chú demo; không làm thay đổi số dư', amount: '50000', payer_user_id: member.id, expected_finance_version: (await getFund()).finance_version } }));
    if (command === 'api' && (await getFund()).current_balance !== '500000') throw new Error('DEMO_LEDGER_BALANCE_MISMATCH');
    pass('Finance: Fund, Holder confirmation, contribution/report/confirm, ledger balance and note via real Gateway');
    const watch = await step('price-watch', async () => {
      const departure = new Date(Date.parse(state.createdAt) + 30 * 86400000); departure.setUTCHours(2, 0, 0, 0);
      return { path: base + '/price-watches', body: { provider: 'MOCK_FLIGHT', origin: 'DAD', destination: 'SGN', departure_date: departure.toISOString().slice(0, 10), journey_type: 'ONE_WAY', passengers: { adults: 2, children: 0, infants: 0 }, cabin_class: 'ECONOMY', currency: 'VND', threshold_price: '9000000', departure_at: departure.toISOString() } };
    });
    await waitFor(async () => (await api(`/api/v1/price-watches/${watch.id}/observations`, 'GET', undefined, owner)).data.length);
    pass('Price Watch: real worker persisted observations; provider MOCK_FLIGHT (not live fares)');
    const inbox = await waitFor(async () => {
      const result = await api('/api/v1/me/notifications?limit=50', 'GET', undefined, member);
      const items = Array.isArray(result.data) ? result.data : result.data.items;
      return items?.some(item => item.trip_id === trip.id && item.type === 'MEMBER_JOINED') ? items : null;
    });
    pass('Notification: inbox produced by real Trip/Automation events, not inserted SQL fixtures');
    if (command === 'api') {
      const getWatch = async () => {
        const watches = (await api(base + '/price-watches', 'GET', undefined, owner)).data;
        const current = watches.find(item => item.id === watch.id);
        if (!current) throw new Error('DEMO_PRICE_WATCH_MISSING');
        return current;
      };
      for (const action of ['pause', 'resume', 'stop']) {
        const current = await getWatch();
        await api(`/api/v1/price-watches/${watch.id}/${action}`, 'POST', { expected_version: current.version }, owner);
      }
      pass('Price Watch: pause/resume/stop via real API; provider remains simulated');
      const preferences = (await api('/api/v1/me/notification-preferences', 'GET', undefined, owner)).data;
      await api('/api/v1/me/notification-preferences', 'PUT', { push_enabled: preferences.push_enabled, email_enabled: preferences.email_enabled, group_overrides: preferences.group_overrides, expected_version: preferences.version }, owner);
      const device = await api('/api/v1/me/devices', 'POST', { platform: 'WEB', token: `demo-${randomUUID()}-${randomUUID()}` }, owner);
      await api(`/api/v1/me/devices/${device.data.id}`, 'DELETE', undefined, owner, undefined, [200, 204]);
      await api(`/api/v1/me/notifications/${inbox.find(item => item.trip_id === trip.id).id}/read`, 'PATCH', undefined, member);
      await api(base, 'GET', undefined, outsider, undefined, [404]);
      pass('Notification preferences/device/read and cross-Trip access denial');
      const memberList = (await api(base + '/members', 'GET', undefined, owner)).data;
      const membership = memberList.items.find(item => item.user_id === member.id);
      const key = randomUUID();
      await api(base + '/leave', 'POST', { reason: 'API demo leave after settled contribution', expected_membership_revision: (await getTrip()).membership_revision }, member, key, [200, 202]);
      await waitFor(async () => {
        const result = await api(`/api/v1/operations/${key}`, 'GET', undefined, member);
        if (result.data.state === 'FAILED') throw new Error('DEMO_MEMBER_LEAVE_FAILED');
        return result.data.state === 'SUCCEEDED';
      });
      await api(base, 'GET', undefined, member, undefined, [404]);
      if (!membership) throw new Error('DEMO_MEMBERSHIP_MISSING');
      pass('Membership lifecycle: settled Member leaves through real Trip-Finance; subsequent access denied (Backend only)');
    }
    state.resources = { tripId: trip.id, fundId: fund.id, priceWatchId: watch.id };
    await save(journalPath, state);
    pass('Replay journal saved; completed seed steps are not repeated');
  } catch (error) {
    report.checks.push({ name: 'execution', status: 'FAIL', error: error.message });
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await mkdir(resolve(demoRoot, 'reports'), { recursive: true });
    await save(resolve(demoRoot, 'reports', `${command}-latest.json`), report);
    await save(resolve(demoRoot, 'reports', `${command}-${report.runId}.json`), report);
    console.log(`Redacted report: .local/demo/reports/${command}-latest.json`);
  }
}
