import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
const require = createRequire(new URL('../apps/finance-service/package.json', import.meta.url));
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { ReceiptRepository } = require('../finance-service/dist/receipts/receipt.repository.js');
const {
  ReceiptStorage,
  RECEIPT_BUCKET,
} = require('../finance-service/dist/receipts/receipt-storage.js');
const { ReceiptService } = require('../finance-service/dist/receipts/receipt.service.js');
const { Client } = require('minio');

export async function runFinanceReceiptTests(h, helpers) {
  const { query, transaction, bearer, pass } = h;
  const { owner, holder, member, outsider } = h.actors;
  const { newTrip, write, enableBody, financeDb } = helpers;
  const trip = await newTrip();
  await query(
    'trip',
    "INSERT INTO trip_members(trip_id,user_id,role,joined_at) VALUES($1,$2,'MEMBER',now())",
    [trip, member.id],
  );
  const enabled = await write(`/api/v1/trips/${trip}/fund`, enableBody());
  assert.equal(enabled.status, 201);
  const fund = enabled.body.data.id;
  const path = `/api/v1/funds/${fund}/receipts`;
  const config = { get: (key) => h.storageConfig[key], getOrThrow: (key) => h.storageConfig[key] };
  const files = new ReceiptRepository(financeDb),
    storage = new ReceiptStorage(config);
  const cleanup = new ReceiptService({}, files, storage);
  const [host, port] = h.storageConfig.MINIO_ENDPOINT.split(':');
  const minio = new Client({
    endPoint: host,
    port: Number(port),
    useSSL: false,
    accessKey: h.storageConfig.MINIO_ACCESS_KEY,
    secretKey: h.storageConfig.MINIO_SECRET_KEY,
  });
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const upload = async (
    bytes = png,
    mime = 'image/png',
    actor = member,
    extra = false,
    target = path,
  ) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), 'untrusted-name');
    if (extra) form.append('actor_user_id', owner.id);
    const response = await fetch(h.gatewayUrl + target, {
      method: 'POST',
      headers: actor ? bearer(actor) : {},
      body: form,
    });
    return { status: response.status, body: await response.json() };
  };
  const download = (key, actor = member, target = path) =>
    fetch(h.gatewayUrl + target + '/download?object_key=' + encodeURIComponent(key), {
      headers: actor ? bearer(actor) : {},
    });
  const row = async (key) =>
    (await query('finance', 'SELECT * FROM finance_files WHERE object_key=$1', [key]))[0];
  const bind = async (key, target, uploader = member) => {
    // Fixture for future report/expense writers, NOT an implemented business API.
    await cleanup.prepareAttachment(fund, key, uploader.id, AbortSignal.timeout(10000));
    await transaction('finance', (tx) => files.bind(tx, fund, key, uploader.id, target));
  };
  const snapshot = async () =>
    JSON.stringify(
      await query(
        'finance',
        `SELECT current_balance::text,finance_version,
    (SELECT count(*) FROM fund_transactions) AS ledger,(SELECT count(*) FROM outbox_events) AS outbox,
    (SELECT count(*) FROM command_receipts) AS receipts FROM funds WHERE id=$1`,
        [fund],
      ),
    );
  try {
    const before = await snapshot();
    assert.equal((await upload(png, 'image/png', null)).status, 401);
    assert.equal((await upload(png, 'image/png', outsider)).status, 404);
    for (const [bytes, mime] of [
      [Buffer.alloc(0), 'image/png'],
      [Buffer.alloc(10485761), 'image/png'],
      [png, 'image/jpeg'],
      [Buffer.from('%PDF-1.7\ninvalid\n%%EOF'), 'application/pdf'],
    ])
      assert.equal((await upload(bytes, mime)).status, 400);
    assert.equal((await upload(png, 'image/png', member, true)).status, 400);
    const uploaded = await upload();
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const file = uploaded.body.data,
      key = file.object_key;
    assert.deepEqual(Object.keys(file).sort(), ['mime_type', 'object_key', 'size_bytes']);
    assert.equal((await row(key)).sha256, createHash('sha256').update(png).digest('hex'));
    assert.equal(await snapshot(), before);
    assert.equal((await download(key)).status, 404);
    assert.equal((await fetch(`http://${host}:${port}/${RECEIPT_BUCKET}/${key}`)).status, 403);
    pass(
      'API105 validates bytes, membership and multipart; private staging changes no balance/version/events',
    );

    const dest = (
      await query('finance', 'SELECT id FROM payment_destinations WHERE fund_id=$1', [fund])
    )[0].id;
    assert.equal(
      (
        await write(
          `/api/v1/funds/${fund}/destinations/${dest}/confirm`,
          { expected_version: 1, expected_finance_version: 1 },
          holder,
        )
      ).status,
      200,
    );
    const request = await write(`/api/v1/funds/${fund}/contribution-requests`, {
      title: 'Receipt fixture',
      contributions: [{ member_user_id: member.id, amount: '10000', destination_id: dest }],
      expected_finance_version: 2,
    });
    assert.equal(request.status, 201);
    const contribution = request.body.data.contributions[0].id;
    await assert.rejects(bind(key, { contributionId: contribution }, owner), {
      code: 'STATE_CONFLICT',
    });
    await assert.rejects(
      transaction('finance', (tx) =>
        files.bind(tx, randomUUID(), key, member.id, { contributionId: contribution }),
      ),
      { code: 'STATE_CONFLICT' },
    );
    await bind(key, { contributionId: contribution });
    await query('finance', 'UPDATE contributions SET transfer_evidence_object_key=$2 WHERE id=$1', [
      contribution,
      key,
    ]);
    for (const actor of [member, holder]) {
      const response = await download(key, actor);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.match(
        response.headers.get('content-disposition'),
        /^attachment; filename="receipt.png"$/,
      );
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    }
    for (const actor of [owner, outsider]) assert.equal((await download(key, actor)).status, 404);
    await query('finance', 'UPDATE funds SET holder_user_id=$2 WHERE id=$1', [fund, owner.id]);
    assert.equal((await download(key, owner)).status, 200);
    assert.equal((await download(key, holder)).status, 404);
    await query('finance', 'UPDATE funds SET holder_user_id=$2 WHERE id=$1', [fund, holder.id]);
    assert.equal(
      (await download(key, member, `/api/v1/funds/${randomUUID()}/receipts`)).status,
      404,
    );
    const replacement = (await upload()).body.data.object_key;
    await bind(replacement, { contributionId: contribution });
    await query('finance', 'UPDATE contributions SET transfer_evidence_object_key=$2 WHERE id=$1', [
      contribution,
      replacement,
    ]);
    assert.equal((await download(key)).status, 200);
    await assert.rejects(query('finance', 'DELETE FROM finance_files WHERE object_key=$1', [key]));
    await assert.rejects(
      query(
        'finance',
        'UPDATE finance_files SET contribution_id=NULL,bound_at=NULL WHERE object_key=$1',
        [key],
      ),
    );
    await query('trip', 'UPDATE trip_members SET left_at=now() WHERE trip_id=$1 AND user_id=$2', [
      trip,
      member.id,
    ]);
    assert.equal((await download(key)).status, 404);
    await query('trip', 'UPDATE trip_members SET left_at=NULL WHERE trip_id=$1 AND user_id=$2', [
      trip,
      member.id,
    ]);
    pass(
      'API106 enforces Self/current Holder, rejects Owner override/cross-Fund/revocation and retains replaced evidence',
    );

    const pdf = await PDFDocument.create();
    pdf.addPage();
    const saved = Buffer.from(await pdf.save({ useObjectStreams: false }));
    // A valid PDF comment pads the original document; payload tests exact 10MiB through HTTP and gRPC.
    const newline = saved.indexOf(10) + 1;
    const large = Buffer.concat([
      saved.subarray(0, newline),
      Buffer.from('%'),
      Buffer.alloc(10485760 - saved.length - 2, 32),
      Buffer.from('\n'),
      saved.subarray(newline),
    ]);
    const pdfUpload = await upload(large, 'application/pdf');
    assert.equal(pdfUpload.status, 201, JSON.stringify(pdfUpload.body));
    const pdfKey = pdfUpload.body.data.object_key;
    const expense = randomUUID();
    await query(
      'finance',
      "INSERT INTO fund_expenses(id,fund_id,title,amount,created_by_user_id,status,receipt_object_key) VALUES($1,$2,'Fixture expense',10000,$3,'SUBMITTED',$4)",
      [expense, fund, member.id, pdfKey],
    );
    await bind(pdfKey, { expenseId: expense });
    const pdfDownload = await download(pdfKey, owner);
    assert.equal(pdfDownload.status, 200);
    assert.deepEqual(Buffer.from(await pdfDownload.arrayBuffer()), large);
    await query('trip', 'UPDATE trips SET archived_at=now() WHERE id=$1', [trip]);
    assert.equal((await upload()).status, 409);
    assert.equal((await download(key)).status, 200);
    await query('trip', 'UPDATE trips SET archived_at=NULL WHERE id=$1', [trip]);
    await query('finance', "UPDATE funds SET status='CLOSED' WHERE id=$1", [fund]);
    assert.equal((await upload()).status, 409);
    assert.equal((await download(key)).status, 200);
    await query('finance', "UPDATE funds SET status='OPEN' WHERE id=$1", [fund]);
    pass(
      'Real MinIO handles exact 10MiB PDF over 4MiB RPC; expense members and archived/closed history remain readable',
    );

    const orphan = (await upload()).body.data.object_key;
    await query(
      'finance',
      "UPDATE finance_files SET cleanup_after=now()-interval '1 minute' WHERE object_key=$1",
      [orphan],
    );
    const claimed = await files.claimExpired();
    assert.equal(claimed, orphan);
    await assert.rejects(bind(orphan, { contributionId: contribution }), {
      code: 'STATE_CONFLICT',
    });
    await storage.remove(orphan);
    // Simulate a late PUT completing after a crashed uploader; retained tombstone must reclaim it.
    await minio.putObject(RECEIPT_BUCKET, orphan, png, png.length);
    await query(
      'finance',
      "UPDATE finance_files SET cleanup_after=now()-interval '1 minute' WHERE object_key=$1",
      [orphan],
    );
    await cleanup.cleanup();
    await assert.rejects(minio.statObject(RECEIPT_BUCKET, orphan));
    await query(
      'finance',
      "UPDATE finance_files SET cleanup_after=now()-interval '1 minute' WHERE object_key=$1",
      [key],
    );
    await cleanup.cleanup();
    assert.equal((await download(key)).status, 200);
    const race = (await upload()).body.data.object_key;
    await query(
      'finance',
      "UPDATE finance_files SET cleanup_after=now()-interval '1 minute' WHERE object_key=$1",
      [race],
    );
    let locked;
    const acquired = new Promise((resolve) => {
      locked = resolve;
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const attaching = transaction('finance', async (tx) => {
      await tx.query('SELECT id FROM funds WHERE id=$1 FOR UPDATE', [fund]);
      locked();
      await gate;
      await files.bind(tx, fund, race, member.id, { contributionId: contribution });
    });
    await acquired;
    const sweeping = cleanup.cleanup();
    release();
    await Promise.all([attaching, sweeping]);
    assert.equal((await download(race)).status, 200);
    pass(
      'Cleanup serializes with attachment, preserves bound history and retries crash/late-write tombstones',
    );

    await minio.putObject(RECEIPT_BUCKET, key, Buffer.from('corrupt'), 7);
    assert.equal((await download(key)).status, 503);
    await minio.putObject(RECEIPT_BUCKET, key, png, png.length, { 'Content-Type': 'image/png' });
    await minio.removeObject(RECEIPT_BUCKET, key);
    assert.equal((await download(key)).status, 503);
    await minio.putObject(RECEIPT_BUCKET, key, png, png.length, { 'Content-Type': 'image/png' });
    await query('finance', 'ALTER TABLE finance_files RENAME TO receipt_test_unavailable');
    try {
      assert.equal((await download(key)).status, 503);
    } finally {
      await query('finance', 'ALTER TABLE receipt_test_unavailable RENAME TO finance_files');
    }
    await h.whileTripStopped(async () => assert.equal((await download(key)).status, 503));
    pass('Corrupt/missing storage and unavailable SQL/Trip fail closed without leaking bytes');
    return [key, replacement, pdfKey, orphan, race];
  } finally {
    storage.onApplicationShutdown();
  }
}
