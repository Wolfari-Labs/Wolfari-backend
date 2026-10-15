import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PaymentDestinationRepository,
} = require('../../dist/repositories/payment-destination.repository.js');
const { assertValidContributionRequest } = require('../../dist/domain/contribution-request.js');

/** Only the isolated DB runner calls this fixture; no development data or real accounts. */
export async function checkPaymentDestinationRepository(client) {
  const repository = new PaymentDestinationRepository({ query: client.query.bind(client) });
  const fundId = randomUUID();
  const otherFundId = randomUUID();
  const memberId = randomUUID();
  const [bankId, momoId, inactiveId, unconfirmedId, foreignId] = Array.from({ length: 5 }, () =>
    randomUUID(),
  );
  const time = new Date('2026-10-01T00:00:00Z');
  const read = (destinationIds, selectedFund = fundId) =>
    repository.findByIds({ fundId: selectedFund, destinationIds });
  const domainContext = (destinations) => ({
    fundId,
    activeMemberUserIds: new Set([memberId]),
    destinations: destinations.map((record) => ({
      id: record.id,
      fundId: record.fundId,
      active: record.active,
      confirmedByHolderAt: record.confirmedByHolderAt?.toISOString() ?? null,
    })),
  });
  const allocation = (destinationId) => [{ memberUserId: memberId, destinationId, amount: 100n }];

  await client.query('BEGIN');
  try {
    for (const id of [fundId, otherFundId]) {
      await client.query(
        'INSERT INTO public.funds(id, trip_id, holder_user_id) VALUES ($1,$2,$3)',
        [id, randomUUID(), memberId],
      );
    }
    for (const [id, ownerFund, active, confirmed, isDefault] of [
      [bankId, fundId, true, time, true],
      [inactiveId, fundId, false, time, false],
      [unconfirmedId, fundId, true, null, false],
      [foreignId, otherFundId, true, time, true],
    ]) {
      await client.query(
        `INSERT INTO public.payment_destinations(id, fund_id, destination_type, bank_code,
           account_number, account_name, active, confirmed_by_holder_at, is_default, version, created_at, updated_at)
         VALUES ($1,$2,'VIETQR','TEST','00000123','FIXTURE HOLDER',$3,$4,$5,2,$6,$6)`,
        [id, ownerFund, active, confirmed, isDefault, time],
      );
    }
    await client.query(
      `INSERT INTO public.payment_destinations(id, fund_id, destination_type, momo_phone, confirmed_by_holder_at)
       VALUES ($1,$2,'MOMO_SANDBOX','0900000000',$3)`,
      [momoId, fundId, time],
    );

    assert.deepEqual(await read([]), []);
    assert.deepEqual(await read([randomUUID()]), []); // Must not silently choose the default.
    assert.deepEqual(await read([foreignId]), []);
    assert.deepEqual(await read([bankId], otherFundId), []);
    assert.deepEqual(await read([bankId], randomUUID()), []);
    const records = await read([momoId, bankId, bankId, foreignId, randomUUID()]);
    assert.deepEqual(
      records.map((record) => record.id),
      [bankId, momoId].sort(),
    );
    const bank = records.find((record) => record.id === bankId);
    assert.deepEqual(bank, {
      id: bankId,
      fundId,
      destinationType: 'VIETQR',
      bankCode: 'TEST',
      accountNumber: '00000123',
      accountName: 'FIXTURE HOLDER',
      momoPhone: null,
      isDefault: true,
      active: true,
      version: 2,
      confirmedByHolderAt: time,
      createdAt: time,
      updatedAt: time,
    });
    const momo = records.find((record) => record.id === momoId);
    assert.equal(momo.destinationType, 'MOMO_SANDBOX');
    assert.equal(momo.momoPhone, '0900000000');
    assert.equal(momo.bankCode, null);
    assert.equal(momo.accountNumber, null);
    assert.equal(momo.accountName, null);
    assert.equal(momo.isDefault, false);
    assert(momo.createdAt instanceof Date);
    assert(momo.updatedAt instanceof Date);
    assert.doesNotThrow(() =>
      assertValidContributionRequest(allocation(bankId), domainContext(records)),
    );

    const ineligible = await read([inactiveId, unconfirmedId]);
    assert.equal(ineligible.length, 2); // Reader retains flags; domain decides eligibility.
    assert.equal(ineligible.find((record) => record.id === inactiveId).active, false);
    assert.equal(
      ineligible.find((record) => record.id === unconfirmedId).confirmedByHolderAt,
      null,
    );
    for (const id of [inactiveId, unconfirmedId, foreignId]) {
      assert.throws(() =>
        assertValidContributionRequest(allocation(id), domainContext(ineligible)),
      );
    }

    // Simulate a configuration edit: a later read must see the new version and lost confirmation.
    await client.query(
      `UPDATE public.payment_destinations SET account_number='00000456', version=3,
        confirmed_by_holder_at=NULL, updated_at=$2 WHERE id=$1`,
      [bankId, new Date('2026-10-02T00:00:00Z')],
    );
    const changed = await read([bankId]);
    assert.equal(changed[0].accountNumber, '00000456');
    assert.equal(changed[0].version, 3);
    assert.equal(changed[0].confirmedByHolderAt, null);
    assert.equal(changed[0].updatedAt.toISOString(), '2026-10-02T00:00:00.000Z');
    assert.equal(bank.accountNumber, '00000123'); // Previously returned data is not mutated.
    assert.throws(() => assertValidContributionRequest(allocation(bankId), domainContext(changed)));
    await client.query("UPDATE public.funds SET status='CLOSED', closed_at=$2 WHERE id=$1", [
      fundId,
      time,
    ]);
    assert.deepEqual(await read([bankId]), changed); // Reading is not permission to write.
  } finally {
    await client.query('ROLLBACK');
  }
  const {
    rows: [remaining],
  } = await client.query(
    `SELECT (SELECT count(*) FROM public.funds WHERE id IN ($1,$2))::int AS funds,
            (SELECT count(*) FROM public.payment_destinations WHERE fund_id IN ($1,$2))::int AS destinations`,
    [fundId, otherFundId],
  );
  assert.deepEqual(remaining, { funds: 0, destinations: 0 });
}
