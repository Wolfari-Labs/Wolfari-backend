import { describe, it, expect } from 'vitest';
import {
  assertCreateHandover,
  planHandoverAction,
  type HandoverContext,
  type HandoverState,
} from './handover-management';
import { handoverResponse, type HandoverRow } from '../projections/handover-response';
import { parseHandoverAction, parseHandoverCreate } from '../inputs/handover.input';
const context = (actor = 'owner'): HandoverContext => ({
  actorUserId: actor,
  ownerUserId: 'owner',
  activeMemberUserIds: new Set(['owner', 'old', 'new']),
  tripArchived: false,
  holderUserId: 'old',
  fundStatus: 'OPEN',
  financeVersion: 7,
});
const state = (): HandoverState => ({
  status: 'ACCEPTED',
  version: 2,
  oldHolderUserId: 'old',
  newHolderUserId: 'new',
  snapshotFinanceVersion: 7,
  oldConfirmed: false,
  newConfirmed: false,
});
const body = () => ({
  expectedVersion: 2,
  expectedFinanceVersion: 7,
  expectedSnapshotFinanceVersion: 7,
});
describe('Holder handover authority and snapshot', () => {
  it('owner nominates an active successor but cannot nominate current holder', () => {
    expect(() =>
      assertCreateHandover({ newHolderUserId: 'new', expectedFinanceVersion: 7 }, context()),
    ).not.toThrow();
    expect(() =>
      assertCreateHandover({ newHolderUserId: 'old', expectedFinanceVersion: 7 }, context()),
    ).toThrow('STATE_CONFLICT');
  });
  it('member cannot nominate and inactive successor is rejected', () => {
    expect(() =>
      assertCreateHandover({ newHolderUserId: 'new', expectedFinanceVersion: 7 }, context('old')),
    ).toThrow('PERMISSION_DENIED');
    expect(() =>
      assertCreateHandover({ newHolderUserId: 'departed', expectedFinanceVersion: 7 }, context()),
    ).toThrow('STATE_CONFLICT');
  });
  it('only successor accepts a nomination', () => {
    expect(() =>
      planHandoverAction(
        'ACCEPT_HOLDER_HANDOVER',
        body(),
        { ...state(), status: 'NOMINATED' },
        context('new'),
      ),
    ).not.toThrow();
    expect(() =>
      planHandoverAction(
        'ACCEPT_HOLDER_HANDOVER',
        body(),
        { ...state(), status: 'NOMINATED' },
        context('owner'),
      ),
    ).toThrow('PERMISSION_DENIED');
  });
  it('first party confirmation retains old holder; second completes', () => {
    expect(
      planHandoverAction('CONFIRM_HOLDER_HANDOVER', body(), state(), context('old')).complete,
    ).toBe(false);
    expect(
      planHandoverAction(
        'CONFIRM_HOLDER_HANDOVER',
        body(),
        { ...state(), oldConfirmed: true },
        context('new'),
      ).complete,
    ).toBe(true);
    expect(
      planHandoverAction(
        'CONFIRM_HOLDER_HANDOVER',
        body(),
        { ...state(), newConfirmed: true },
        context('old'),
      ).complete,
    ).toBe(true);
  });
  it('owner cannot substitute for either party', () =>
    expect(() => planHandoverAction('CONFIRM_HOLDER_HANDOVER', body(), state(), context())).toThrow(
      'PERMISSION_DENIED',
    ));
  it('rejects duplicate confirmation, terminal workflow and departed successor', () => {
    expect(() =>
      planHandoverAction(
        'CONFIRM_HOLDER_HANDOVER',
        body(),
        { ...state(), oldConfirmed: true },
        context('old'),
      ),
    ).toThrow('STATE_CONFLICT');
    expect(() =>
      planHandoverAction(
        'CONFIRM_HOLDER_HANDOVER',
        body(),
        { ...state(), status: 'COMPLETED' },
        context('new'),
      ),
    ).toThrow('STATE_CONFLICT');
    const c = { ...context('old'), activeMemberUserIds: new Set(['old', 'owner']) };
    expect(() => planHandoverAction('CONFIRM_HOLDER_HANDOVER', body(), state(), c)).toThrow(
      'STATE_CONFLICT',
    );
  });
  it('rejects stale finance, handover and snapshot versions independently', () => {
    for (const patch of [
      { expectedVersion: 1 },
      { expectedFinanceVersion: 6 },
      { expectedSnapshotFinanceVersion: 6 },
    ])
      expect(() =>
        planHandoverAction(
          'CONFIRM_HOLDER_HANDOVER',
          { ...body(), ...patch },
          state(),
          context('old'),
        ),
      ).toThrow('VERSION_CONFLICT');
    expect(() =>
      planHandoverAction(
        'CONFIRM_HOLDER_HANDOVER',
        body(),
        { ...state(), snapshotFinanceVersion: 6 },
        context('old'),
      ),
    ).toThrow('VERSION_CONFLICT');
  });
  it('allows owner or either party to cancel and refresh, never outsider', () => {
    for (const actor of ['owner', 'old', 'new'])
      for (const command of ['CANCEL_HOLDER_HANDOVER', 'REFRESH_HOLDER_HANDOVER'] as const)
        expect(() => planHandoverAction(command, body(), state(), context(actor))).not.toThrow();
    expect(() =>
      planHandoverAction('CANCEL_HOLDER_HANDOVER', body(), state(), context('outsider')),
    ).toThrow('PERMISSION_DENIED');
  });
  it('rejects archive, closing, closed and exhausted version', () => {
    for (const patch of [
      { tripArchived: true },
      { fundStatus: 'CLOSING' },
      { fundStatus: 'CLOSED' },
      { closureLockId: 'closure' },
    ])
      expect(() =>
        planHandoverAction(
          'ACCEPT_HOLDER_HANDOVER',
          body(),
          { ...state(), status: 'NOMINATED' },
          { ...context('new'), ...patch },
        ),
      ).toThrow('STATE_CONFLICT');
    expect(() =>
      planHandoverAction(
        'CONFIRM_HOLDER_HANDOVER',
        body(),
        { ...state(), version: 2147483647 },
        context('new'),
      ),
    ).toThrow();
  });
  it('hides stale confirmations including unversioned snapshot changes', () => {
    const row = {
      id: 'handover',
      fund_id: 'fund',
      old_holder_user_id: 'old',
      new_holder_user_id: 'new',
      nominated_by_user_id: 'owner',
      status: 'ACCEPTED',
      version: 2,
      snapshot_finance_version: 7,
      snapshot: null,
      accepted_at: new Date(),
      old_holder_confirmed_at: new Date(),
      new_holder_confirmed_at: new Date(),
      completed_at: null,
      cancelled_at: null,
      cancellation_reason: null,
      created_at: new Date(),
      updated_at: new Date(),
    } satisfies HandoverRow;
    expect(handoverResponse(row, 8)).toMatchObject({
      snapshot_stale: true,
      old_holder_confirmed_at: undefined,
      new_holder_confirmed_at: undefined,
    });
    expect(handoverResponse({ ...row, snapshot_stale_override: true }, 7).snapshot_stale).toBe(
      true,
    );
  });
  it('validates explicit snapshot version, UUID and cancellation reason', () => {
    expect(() =>
      parseHandoverCreate({ new_holder_user_id: 'bad', expected_finance_version: 7 }),
    ).toThrow('VALIDATION_FAILED');
    expect(() =>
      parseHandoverAction({ expected_version: 1, expected_finance_version: 7 }, 'confirm'),
    ).toThrow('VALIDATION_FAILED');
    expect(() =>
      parseHandoverAction(
        { expected_version: 1, expected_finance_version: 7, reason: ' ' },
        'cancel',
      ),
    ).toThrow('VALIDATION_FAILED');
  });
});
