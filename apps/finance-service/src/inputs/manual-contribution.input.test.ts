import { describe, expect, it } from 'vitest';
import { ContributionPermissionDeniedError } from '../domain/contribution-permissions';
import {
  ContributionStateConflictError,
  ContributionVersionConflictError,
  planManualContributionTransition,
  type ContributionTransitionContext,
  type ManualContributionCommand,
} from '../domain/contribution-transition';
import {
  ManualContributionInputError,
  parseManualContributionInput,
} from './manual-contribution.input';

type Action = ManualContributionCommand['action'];
const actions: readonly Action[] = ['REPORT_TRANSFER', 'CONFIRM_RECEIVED', 'REJECT_TRANSFER'];
const versions = { expected_version: 3, expected_finance_version: 7 };
const bodyFor = (action: Action): Record<string, unknown> => ({
  ...versions,
  ...(action === 'REJECT_TRANSFER' ? { reason: ' Chưa nhận được tiền ' } : {}),
});

describe('API087–089 manual contribution body parser', () => {
  it('parses a report without evidence and does not imply deletion of old evidence', () => {
    expect(parseManualContributionInput('REPORT_TRANSFER', versions)).toEqual({
      command: { action: 'REPORT_TRANSFER', expectedVersion: 3, expectedFinanceVersion: 7 },
    });
  });

  it('preserves a supplied evidence key exactly outside the domain command', () => {
    const evidence = 'private/Finance/biên nhận 01.png';
    expect(
      parseManualContributionInput('REPORT_TRANSFER', {
        ...versions,
        evidence_object_key: evidence,
      }),
    ).toEqual({
      command: { action: 'REPORT_TRANSFER', expectedVersion: 3, expectedFinanceVersion: 7 },
      evidenceObjectKey: evidence,
    });
  });

  it('parses confirmation without accepting an amount or actor from the client', () => {
    expect(parseManualContributionInput('CONFIRM_RECEIVED', versions)).toEqual({
      command: { action: 'CONFIRM_RECEIVED', expectedVersion: 3, expectedFinanceVersion: 7 },
    });
  });

  it('preserves rejection text for the existing domain rule to normalize', () => {
    expect(parseManualContributionInput('REJECT_TRANSFER', bodyFor('REJECT_TRANSFER'))).toEqual({
      command: {
        action: 'REJECT_TRANSFER',
        expectedVersion: 3,
        expectedFinanceVersion: 7,
        reason: ' Chưa nhận được tiền ',
      },
    });
  });

  it.each([1, 2147483647])('accepts positive int32 version boundary %s', (version) => {
    for (const action of actions) {
      expect(
        parseManualContributionInput(action, {
          ...bodyFor(action),
          expected_version: version,
          expected_finance_version: version,
        }).command,
      ).toMatchObject({ expectedVersion: version, expectedFinanceVersion: version });
    }
  });

  it.each([null, undefined, [], 'body', 123, true, new Date()])(
    'rejects a non-JSON-object body %# for every route',
    (body) => {
      for (const action of actions) {
        expect(() => parseManualContributionInput(action, body)).toThrow(
          ManualContributionInputError,
        );
      }
    },
  );

  it('accepts an object with a null prototype and its own fields', () => {
    const body: unknown = Object.assign(Object.create(null), versions);
    expect(parseManualContributionInput('REPORT_TRANSFER', body)).toEqual(
      parseManualContributionInput('REPORT_TRANSFER', versions),
    );
  });

  it('does not accept required data inherited from a custom prototype', () => {
    for (const action of actions) {
      expect(() => parseManualContributionInput(action, Object.create(bodyFor(action)))).toThrow(
        ManualContributionInputError,
      );
    }
  });

  it.each(['expected_version', 'expected_finance_version'])(
    'requires %s on every route',
    (field) => {
      for (const action of actions) {
        const body = bodyFor(action);
        delete body[field];
        expect(() => parseManualContributionInput(action, body)).toThrow(
          new ManualContributionInputError(field),
        );
      }
    },
  );

  it.each([undefined, null, '3', 0, -1, 1.5, 2147483648, NaN, Infinity, true, {}, []])(
    'rejects an invalid version without coercion %#',
    (version) => {
      for (const action of actions) {
        for (const field of ['expected_version', 'expected_finance_version']) {
          expect(() =>
            parseManualContributionInput(action, { ...bodyFor(action), [field]: version }),
          ).toThrow(new ManualContributionInputError(field));
        }
      }
    },
  );

  it.each([
    'action',
    'actor_user_id',
    'holder_user_id',
    'member_user_id',
    'role',
    'amount',
    'status',
    'current_balance',
    'destination_snapshot',
    'self_contribution',
    'expectedVersion',
  ])('rejects undeclared or server-owned field %s', (field) => {
    for (const action of actions) {
      expect(() =>
        parseManualContributionInput(action, { ...bodyFor(action), [field]: 'forged' }),
      ).toThrow(new ManualContributionInputError('body'));
    }
  });

  it('enforces separate body allowlists for report, confirmation and rejection', () => {
    for (const action of ['REPORT_TRANSFER', 'CONFIRM_RECEIVED'] as const) {
      expect(() =>
        parseManualContributionInput(action, { ...versions, reason: 'not allowed' }),
      ).toThrow(ManualContributionInputError);
    }
    for (const action of ['CONFIRM_RECEIVED', 'REJECT_TRANSFER'] as const) {
      expect(() =>
        parseManualContributionInput(action, {
          ...bodyFor(action),
          evidence_object_key: 'private/object',
        }),
      ).toThrow(ManualContributionInputError);
    }
  });

  it('requires a rejection reason', () => {
    expect(() => parseManualContributionInput('REJECT_TRANSFER', versions)).toThrow(
      new ManualContributionInputError('reason'),
    );
  });

  it.each([undefined, null, 123, true, {}, [], '', ' \n ', 'bad\u0000text'])(
    'rejects invalid reason or explicitly supplied evidence %#',
    (value) => {
      expect(() =>
        parseManualContributionInput('REJECT_TRANSFER', { ...versions, reason: value }),
      ).toThrow(new ManualContributionInputError('reason'));
      expect(() =>
        parseManualContributionInput('REPORT_TRANSFER', {
          ...versions,
          evidence_object_key: value,
        }),
      ).toThrow(new ManualContributionInputError('evidence_object_key'));
    },
  );

  it('rejects unsupported actions supplied by a misconfigured adapter', () => {
    for (const action of ['VIEW_PAYMENT_INSTRUCTION', 'constructor', 'toString', '']) {
      expect(() => parseManualContributionInput(action as Action, versions)).toThrow(
        new ManualContributionInputError('action'),
      );
    }
  });

  it('does not echo private input values in validation errors', () => {
    const secret = 'private/member-file';
    expect(() =>
      parseManualContributionInput('REPORT_TRANSFER', {
        ...versions,
        evidence_object_key: `${secret}\u0000`,
      }),
    ).toThrow(new ManualContributionInputError('evidence_object_key'));
  });

  it('does not mutate or retain the input object', () => {
    const body = { ...versions, evidence_object_key: 'private/first' };
    const parsed = parseManualContributionInput('REPORT_TRANSFER', Object.freeze(body));
    expect(body).toEqual({ ...versions, evidence_object_key: 'private/first' });
    expect(parsed.command).not.toBe(body);
    expect(parsed.evidenceObjectKey).toBe('private/first');
  });
});

const member = '10000000-0000-4000-8000-000000000001';
const holder = '10000000-0000-4000-8000-000000000002';
const owner = '10000000-0000-4000-8000-000000000003';
const contextFor = (action: Action): ContributionTransitionContext => ({
  actorUserId: action === 'REPORT_TRANSFER' ? member : holder,
  memberUserId: member,
  holderUserId: holder,
  activeMemberUserIds: new Set([member, holder, owner]),
  status: action === 'REPORT_TRANSFER' ? 'PENDING' : 'TRANSFER_REPORTED',
  amount: 1n,
  version: 3,
  fundStatus: 'OPEN',
  financeVersion: 7,
  currentBalance: 9007199254740993n,
  hasOriginalReceipt: false,
});

describe('manual input composed with contribution domain rules', () => {
  it('reports/rejects without a ledger effect and confirms the stored full amount precisely', () => {
    for (const action of actions) {
      const { command } = parseManualContributionInput(action, bodyFor(action));
      const effect = planManualContributionTransition(command, contextFor(action));
      if (action === 'CONFIRM_RECEIVED') {
        expect(effect.nextStatus).toBe('CONFIRMED');
        expect(effect.ledgerEntry).toEqual({
          direction: 'IN',
          amount: 1n,
          balanceAfter: 9007199254740994n,
        });
      } else {
        expect(effect.ledgerEntry).toBeNull();
        expect(effect.nextStatus).toBe(
          action === 'REPORT_TRANSFER' ? 'TRANSFER_REPORTED' : 'PENDING',
        );
        if (action === 'REJECT_TRANSFER')
          expect(effect.rejectionReason).toBe('Chưa nhận được tiền');
      }
    }
  });

  it.each(actions)('still rejects an unauthorized or inactive actor for %s', (action) => {
    const { command } = parseManualContributionInput(action, bodyFor(action));
    const state = contextFor(action);
    expect(() =>
      planManualContributionTransition(command, { ...state, actorUserId: owner }),
    ).toThrow(ContributionPermissionDeniedError);
    expect(() =>
      planManualContributionTransition(command, { ...state, activeMemberUserIds: new Set() }),
    ).toThrow(ContributionPermissionDeniedError);
  });

  it.each(['CLOSING', 'CLOSED'] as const)('does not bypass a %s Fund', (fundStatus) => {
    for (const action of actions) {
      const { command } = parseManualContributionInput(action, bodyFor(action));
      expect(() =>
        planManualContributionTransition(command, { ...contextFor(action), fundStatus }),
      ).toThrow(ContributionStateConflictError);
    }
  });

  it.each(['expected_version', 'expected_finance_version'])(
    'leaves stale %s detection to trusted domain context',
    (field) => {
      for (const action of actions) {
        const { command } = parseManualContributionInput(action, {
          ...bodyFor(action),
          [field]: 1,
        });
        expect(() => planManualContributionTransition(command, contextFor(action))).toThrow(
          ContributionVersionConflictError,
        );
      }
    },
  );

  it('does not authorize a repeated confirmation or a contribution already reversed', () => {
    const { command } = parseManualContributionInput('CONFIRM_RECEIVED', versions);
    const state = contextFor('CONFIRM_RECEIVED');
    for (const status of ['CONFIRMED', 'REVERSED', 'PENDING'] as const) {
      expect(() => planManualContributionTransition(command, { ...state, status })).toThrow(
        ContributionStateConflictError,
      );
    }
    expect(() =>
      planManualContributionTransition(command, { ...state, hasOriginalReceipt: true }),
    ).toThrow(ContributionStateConflictError);
  });
});
