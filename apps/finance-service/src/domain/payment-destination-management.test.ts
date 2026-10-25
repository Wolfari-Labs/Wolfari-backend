import { describe, expect, it } from 'vitest';
import type { FundDestination } from './fund-setup';
import {
  PaymentDestinationConflictError,
  PaymentDestinationPermissionError,
  prepareCreatePaymentDestination as create,
  prepareConfirmPaymentDestination as confirm,
  prepareUpdatePaymentDestination as update,
  type DestinationPatch,
  type PaymentDestinationContext,
  type PaymentDestinationState,
} from './payment-destination-management';

const configuration: FundDestination = Object.freeze({
  destinationType: 'VIETQR',
  bankCode: 'TEST',
  accountNumber: '00123',
  accountName: 'TEST HOLDER',
  active: true,
  isDefault: false,
});
const context: PaymentDestinationContext = Object.freeze({
  actorUserId: 'owner',
  ownerUserId: 'owner',
  holderUserId: 'holder',
  activeMemberUserIds: new Set(['owner', 'holder', 'member']),
  tripArchived: false,
  fundId: 'fund',
  fundStatus: 'OPEN',
  financeVersion: 7,
});
const holder = { ...context, actorUserId: 'holder' };
const confirmedAt = new Date('2026-10-14T00:00:00Z');
const state: PaymentDestinationState = Object.freeze({
  id: 'target',
  fundId: 'fund',
  version: 3,
  configuration,
  confirmedByHolderAt: confirmedAt,
});
const versions = { expectedVersion: 3, expectedFinanceVersion: 7 };
const oldDefault: PaymentDestinationState = Object.freeze({
  ...state,
  id: 'old',
  version: 5,
  configuration: Object.freeze({ ...configuration, isDefault: true }),
});
const edit = (
  patch: DestinationPatch,
  target = state,
  ctx = context,
  currentDefault: PaymentDestinationState | null = null,
) => update({ ...versions, patch }, ctx, target, currentDefault);
const make = (
  destination = configuration,
  ctx = context,
  currentDefault: PaymentDestinationState | null = null,
) => create({ destination, expectedFinanceVersion: 7 }, ctx, currentDefault);
function failsWith(action: () => unknown, code: PaymentDestinationConflictError['code']): void {
  expect(action).toThrowError(PaymentDestinationConflictError);
  expect(action).toThrowError(code);
}

describe('destination default and confirmation policy', () => {
  it('creates an unconfirmed plan and demotes only the previous default', () => {
    expect(make({ ...configuration, isDefault: true }, context, oldDefault)).toEqual({
      configuration: { ...configuration, isDefault: true },
      changed: true,
      confirmation: 'CLEAR',
      demoteDefault: { id: 'old', expectedVersion: 5 },
    });
    expect(oldDefault.configuration.isDefault).toBe(true);
    expect(oldDefault.confirmedByHolderAt).toBe(confirmedAt);
  });
  it('switches default without clearing either confirmation or changing the input records', () => {
    const plan = edit({ isDefault: true }, state, context, oldDefault);
    expect(plan).toMatchObject({
      changed: true,
      confirmation: 'KEEP',
      demoteDefault: { id: 'old', expectedVersion: 5 },
    });
    expect(state.configuration.isDefault).toBe(false);
    expect(oldDefault.confirmedByHolderAt).toBe(confirmedAt);
    expect(plan.configuration).not.toBe(state.configuration);
  });
  it('allows independent defaults for VIETQR and MOMO when their own slot is empty', () => {
    expect(
      make({ destinationType: 'MOMO_SANDBOX', momoPhone: '00111', active: true, isDefault: true })
        .demoteDefault,
    ).toBeNull();
  });
  it.each([
    ['another fund', { ...oldDefault, fundId: 'other' }],
    [
      'another type',
      {
        ...oldDefault,
        configuration: {
          destinationType: 'MOMO_SANDBOX',
          momoPhone: '001',
          active: true,
          isDefault: true,
        },
      },
    ],
    [
      'inactive',
      { ...oldDefault, configuration: { ...configuration, active: false, isDefault: true } },
    ],
    ['not default', { ...oldDefault, configuration }],
  ] as const)('rejects an inconsistent default context: %s', (_, currentDefault) => {
    failsWith(
      () => edit({ isDefault: true }, state, context, currentDefault),
      'DEFAULT_CONTEXT_INVALID',
    );
  });
  it('requires the target itself as current default when it owns the active slot', () => {
    const target = { ...state, configuration: { ...configuration, isDefault: true } };
    failsWith(() => edit({ isDefault: true }, target), 'DEFAULT_CONTEXT_INVALID');
    failsWith(
      () => edit({ isDefault: true }, target, context, oldDefault),
      'DEFAULT_CONTEXT_INVALID',
    );
    expect(edit({ isDefault: true }, target, context, target)).toMatchObject({
      changed: false,
      confirmation: 'KEEP',
      demoteDefault: null,
    });
    failsWith(
      () => edit({ isDefault: true }, target, context, { ...target, version: 4 }),
      'DEFAULT_CONTEXT_INVALID',
    );
  });
  it('unsets default without selecting an arbitrary replacement', () => {
    const target = { ...state, configuration: { ...configuration, isDefault: true } };
    expect(edit({ isDefault: false }, target, context, target)).toMatchObject({
      confirmation: 'KEEP',
      changed: true,
      demoteDefault: null,
    });
  });
  it.each([
    { bankCode: 'OTHER' },
    { accountNumber: '00999' },
    { accountName: 'OTHER HOLDER' },
    { accountName: 'TEST HOLDER ' },
  ])('clears confirmation when recipient details change: %j', (patch) => {
    expect(edit(patch)).toMatchObject({ confirmation: 'CLEAR', changed: true });
  });
  it('clears confirmation on a MOMO phone change', () => {
    const target: PaymentDestinationState = {
      ...state,
      configuration: {
        destinationType: 'MOMO_SANDBOX',
        momoPhone: '00111',
        active: true,
        isDefault: false,
      },
    };
    expect(edit({ momoPhone: '00222' }, target)).toMatchObject({
      confirmation: 'CLEAR',
      changed: true,
    });
  });
  it('disables and removes default while retaining the historical confirmation', () => {
    const target = { ...state, configuration: { ...configuration, isDefault: true } };
    expect(edit({ active: false }, target, context, target)).toMatchObject({
      configuration: { active: false, isDefault: false },
      confirmation: 'KEEP',
      changed: true,
      demoteDefault: null,
    });
  });
  it('requires fresh confirmation when reactivated, even with identical recipient details', () => {
    const target = {
      ...state,
      configuration: { ...configuration, active: false, isDefault: true },
    };
    expect(edit({ active: true }, target)).toMatchObject({
      configuration: { active: true, isDefault: false },
      confirmation: 'CLEAR',
      changed: true,
    });
    expect(edit({ active: true, isDefault: true }, target, context, oldDefault)).toMatchObject({
      confirmation: 'CLEAR',
      demoteDefault: { id: 'old', expectedVersion: 5 },
    });
  });
  it.each([
    { active: true },
    { isDefault: false },
    { destinationType: 'VIETQR' },
    { bankCode: 'TEST', accountNumber: '00123', accountName: 'TEST HOLDER' },
  ] satisfies DestinationPatch[])('makes unchanged values a no-op: %j', (patch) => {
    expect(edit(patch)).toMatchObject({
      changed: false,
      confirmation: 'KEEP',
      demoteDefault: null,
    });
  });
  it('does not confirm an unconfirmed destination just because its default flag changed', () => {
    const target = { ...state, confirmedByHolderAt: null };
    expect(edit({ isDefault: true }, target).confirmation).toBe('KEEP');
    expect(target.confirmedByHolderAt).toBeNull();
  });
  it('rejects contradictory inactive/default intent', () => {
    failsWith(() => make({ ...configuration, active: false, isDefault: true }), 'INACTIVE_DEFAULT');
    failsWith(() => edit({ active: false, isDefault: true }), 'INACTIVE_DEFAULT');
    failsWith(
      () =>
        edit({ isDefault: true }, { ...state, configuration: { ...configuration, active: false } }),
      'INACTIVE_DEFAULT',
    );
    expect(make({ ...configuration, active: false }).confirmation).toBe('CLEAR');
  });
  it('requires a new ID for a different provider instead of clearing old fields', () => {
    failsWith(
      () => edit({ destinationType: 'MOMO_SANDBOX', momoPhone: '001' }),
      'DESTINATION_TYPE_IMMUTABLE',
    );
    const momo: PaymentDestinationState = {
      ...state,
      configuration: {
        destinationType: 'MOMO_SANDBOX',
        momoPhone: '001',
        active: true,
        isDefault: false,
      },
    };
    failsWith(
      () => edit({ destinationType: 'VIETQR', bankCode: 'TEST' }, momo),
      'DESTINATION_TYPE_IMMUTABLE',
    );
    expect(state.configuration).toBe(configuration);
  });
  it.each([
    {},
    { momoPhone: '001' },
    { accountNumber: null },
    { accountName: undefined },
    { active: undefined },
    { isDefault: null },
    { destinationType: undefined },
    { unexpectedPrivateField: 'private' },
  ])('rejects invalid patches at the domain boundary: %j', (patch) => {
    expect(() => edit(patch as DestinationPatch)).toThrow();
  });
});

describe('destination rights, scope and concurrency preconditions', () => {
  const actions = [
    ['create', (ctx: PaymentDestinationContext) => make(configuration, ctx), 'owner'],
    ['update', (ctx: PaymentDestinationContext) => edit({ active: true }, state, ctx), 'owner'],
    ['confirm', (ctx: PaymentDestinationContext) => confirm(versions, ctx, state), 'holder'],
  ] as const;
  it.each(actions)(
    '%s checks the role and active membership even for unchanged data',
    (_, action, actor) => {
      const ctx = { ...context, actorUserId: actor };
      expect(() => action(ctx)).not.toThrow();
      for (const actorUserId of ['member', actor === 'owner' ? 'holder' : 'owner']) {
        expect(() => action({ ...ctx, actorUserId })).toThrow(PaymentDestinationPermissionError);
      }
      expect(() => action({ ...ctx, activeMemberUserIds: new Set() })).toThrow(
        PaymentDestinationPermissionError,
      );
    },
  );
  it.each(actions)('%s checks current Trip, Fund and Finance version', (_, action, actor) => {
    const ctx = { ...context, actorUserId: actor };
    failsWith(() => action({ ...ctx, tripArchived: true }), 'TRIP_ARCHIVED');
    for (const fundStatus of ['CLOSING', 'CLOSED'] as const)
      failsWith(() => action({ ...ctx, fundStatus }), 'FUND_NOT_OPEN');
    failsWith(() => action({ ...ctx, financeVersion: 8 }), 'FINANCE_VERSION_CONFLICT');
    for (const financeVersion of [0, -1, 1.5, NaN, 2147483648])
      expect(() => action({ ...ctx, financeVersion })).toThrow();
  });
  it.each(['confirm', 'update'])('%s checks destination scope and version', (action) => {
    const run = (target: PaymentDestinationState) =>
      action === 'confirm' ? confirm(versions, holder, target) : edit({ active: true }, target);
    failsWith(() => run({ ...state, fundId: 'other' }), 'DESTINATION_SCOPE_MISMATCH');
    failsWith(() => run({ ...state, version: 4 }), 'DESTINATION_VERSION_CONFLICT');
    expect(() => run({ ...state, version: 0 })).toThrow();
  });
  it('Holder confirmation is a plan for a server timestamp, not a client timestamp or a bank verification', () => {
    expect(confirm(versions, holder, { ...state, confirmedByHolderAt: null })).toEqual({
      configuration,
      changed: true,
      confirmation: 'SET',
      demoteDefault: null,
    });
    expect(confirm(versions, holder, state)).toMatchObject({
      changed: false,
      confirmation: 'KEEP',
    });
    failsWith(
      () =>
        confirm(versions, holder, { ...state, configuration: { ...configuration, active: false } }),
      'DESTINATION_INACTIVE',
    );
  });
  it('rejects stale command versions, including no-op submissions', () => {
    failsWith(
      () => create({ destination: configuration, expectedFinanceVersion: 6 }, context, null),
      'FINANCE_VERSION_CONFLICT',
    );
    failsWith(
      () =>
        update({ patch: { active: true }, ...versions, expectedVersion: 2 }, context, state, null),
      'DESTINATION_VERSION_CONFLICT',
    );
    failsWith(
      () => confirm({ ...versions, expectedFinanceVersion: 6 }, holder, state),
      'FINANCE_VERSION_CONFLICT',
    );
  });
  it('blocks int32 overflow for changed Finance, target or demoted default versions; no-op remains possible', () => {
    const max = 2147483647;
    const ctx = { ...context, financeVersion: max };
    const v = { expectedFinanceVersion: max, expectedVersion: max };
    const target = { ...state, version: max };
    failsWith(
      () => create({ destination: configuration, expectedFinanceVersion: max }, ctx, null),
      'VERSION_EXHAUSTED',
    );
    failsWith(
      () => update({ ...v, patch: { active: false } }, ctx, target, null),
      'VERSION_EXHAUSTED',
    );
    failsWith(
      () =>
        update(
          { ...versions, expectedVersion: max, patch: { active: false } },
          context,
          target,
          null,
        ),
      'VERSION_EXHAUSTED',
    );
    failsWith(
      () => edit({ isDefault: true }, state, context, { ...oldDefault, version: max }),
      'VERSION_EXHAUSTED',
    );
    failsWith(
      () => confirm(v, { ...ctx, actorUserId: 'holder' }, { ...target, confirmedByHolderAt: null }),
      'VERSION_EXHAUSTED',
    );
    expect(update({ ...v, patch: { active: true } }, ctx, target, null).changed).toBe(false);
    expect(confirm(v, { ...ctx, actorUserId: 'holder' }, target).changed).toBe(false);
  });
});
