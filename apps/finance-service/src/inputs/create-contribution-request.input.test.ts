import { describe, expect, it } from 'vitest';
import {
  assertCanCreateContributionRequest,
  type ContributionRequestCreationContext,
} from '../domain/contribution-request-creation';
import { ContributionPermissionDeniedError } from '../domain/contribution-permissions';
import { InvalidContributionRequestError } from '../domain/contribution-request';
import {
  ContributionRequestInputError,
  parseCreateContributionRequestInput,
} from './create-contribution-request.input';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const member = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const destination = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const fund = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const item = { member_user_id: member, destination_id: destination, amount: '200000' };
const body = { title: ' Quỹ du lịch ', contributions: [item], expected_finance_version: 2 };
const context: ContributionRequestCreationContext = {
  fundId: fund,
  actorUserId: owner,
  ownerUserId: owner,
  fundStatus: 'OPEN',
  financeVersion: 2,
  activeMemberUserIds: new Set([owner, member]),
  destinations: [
    { id: destination, fundId: fund, active: true, confirmedByHolderAt: '2026-10-01T00:00:00Z' },
  ],
};

describe('API078 contribution request body parser', () => {
  it('maps JSON names, preserves text and supplies null for omitted optional fields', () => {
    expect(parseCreateContributionRequestInput(body)).toEqual({
      title: body.title,
      contributions: [{ memberUserId: member, destinationId: destination, amount: 200000n }],
      expectedFinanceVersion: 2,
      note: null,
      dueAt: null,
    });
  });

  it('normalizes UUID case and retains exact int8 amounts including leading zeroes', () => {
    const parsed = parseCreateContributionRequestInput({
      ...body,
      contributions: [
        {
          ...item,
          member_user_id: member.toUpperCase(),
          destination_id: destination.toUpperCase(),
          amount: '0009223372036854775807',
        },
      ],
    });
    expect(parsed.contributions[0]).toEqual({
      memberUserId: member,
      destinationId: destination,
      amount: 9223372036854775807n,
    });
  });

  it('rejects duplicate members after normalizing UUID case', () => {
    expect(() =>
      parseCreateContributionRequestInput({
        ...body,
        contributions: [item, { ...item, member_user_id: member.toUpperCase() }],
      }),
    ).toThrow(ContributionRequestInputError);
  });

  it.each([null, undefined, [], 'body', 123, true, new Date()])(
    'rejects non-object body %#',
    (input) => {
      expect(() => parseCreateContributionRequestInput(input)).toThrow(
        ContributionRequestInputError,
      );
    },
  );

  it.each(['title', 'contributions', 'expected_finance_version'])('requires %s', (key) => {
    const missing: Record<string, unknown> = { ...body };
    delete missing[key];
    expect(() => parseCreateContributionRequestInput(missing)).toThrow(
      ContributionRequestInputError,
    );
  });

  it.each([
    'actor_user_id',
    'owner_user_id',
    'fund_id',
    'status',
    'current_balance',
    'finance_version',
    'amount_per_member',
  ])('rejects undeclared top-level field %s', (key) => {
    expect(() => parseCreateContributionRequestInput({ ...body, [key]: 'forged' })).toThrow(
      ContributionRequestInputError,
    );
  });

  it.each(['status', 'destination_snapshot', 'confirmed_by_user_id', 'self_contribution'])(
    'rejects undeclared allocation field %s',
    (key) => {
      expect(() =>
        parseCreateContributionRequestInput({
          ...body,
          contributions: [{ ...item, [key]: 'forged' }],
        }),
      ).toThrow(ContributionRequestInputError);
    },
  );

  it('rejects prototype fields delivered through JSON', () => {
    const input: unknown = JSON.parse(JSON.stringify(body).replace('{', '{"__proto__":{},'));
    expect(() => parseCreateContributionRequestInput(input)).toThrow(ContributionRequestInputError);
    expect(() => parseCreateContributionRequestInput(Object.create(body))).toThrow(
      ContributionRequestInputError,
    );
  });

  it.each([null, undefined, [], {}, [null], [[]], [1]])(
    'rejects malformed allocation lists %#',
    (contributions) => {
      expect(() => parseCreateContributionRequestInput({ ...body, contributions })).toThrow(
        ContributionRequestInputError,
      );
    },
  );

  it.each([
    null,
    42,
    '',
    'not-a-uuid',
    `${member}\n`,
    ` ${member}`,
    '00000000-0000-0000-0000-000000000000',
  ])('rejects malformed allocation UUID %#', (id) => {
    for (const key of ['member_user_id', 'destination_id']) {
      expect(() =>
        parseCreateContributionRequestInput({ ...body, contributions: [{ ...item, [key]: id }] }),
      ).toThrow(ContributionRequestInputError);
    }
  });

  it.each([
    undefined,
    null,
    200000,
    200000n,
    '0',
    '-1',
    '1.5',
    '1e3',
    '1,000',
    ' 1',
    '1\n',
    '9223372036854775808',
  ])('rejects invalid Money %# without coercion', (amount) => {
    expect(() =>
      parseCreateContributionRequestInput({ ...body, contributions: [{ ...item, amount }] }),
    ).toThrow(ContributionRequestInputError);
  });

  it.each([null, '2', true, 0, -1, 1.5, NaN, Infinity, 2147483648])(
    'rejects invalid revision %#',
    (expected_finance_version) => {
      expect(() =>
        parseCreateContributionRequestInput({ ...body, expected_finance_version }),
      ).toThrow(ContributionRequestInputError);
    },
  );

  it.each([null, undefined])(
    'rejects explicit null/undefined for optional JSON fields %#',
    (value) => {
      for (const key of ['note', 'due_at']) {
        expect(() => parseCreateContributionRequestInput({ ...body, [key]: value })).toThrow(
          ContributionRequestInputError,
        );
      }
    },
  );

  it.each([null, 1, '', ' \n', '💰'.repeat(201), 'bad\u0000title'])(
    'applies domain title rules at input %#',
    (title) => {
      expect(() => parseCreateContributionRequestInput({ ...body, title })).toThrow(
        ContributionRequestInputError,
      );
    },
  );

  it.each([1, {}, 'bad\u0000note'])('rejects invalid note %#', (note) => {
    expect(() => parseCreateContributionRequestInput({ ...body, note })).toThrow(
      ContributionRequestInputError,
    );
  });

  it('accepts the title character limit and preserves empty note', () => {
    expect(
      parseCreateContributionRequestInput({ ...body, title: '💰'.repeat(200), note: '' }),
    ).toMatchObject({ title: '💰'.repeat(200), note: '' });
  });

  it.each([
    ['2026-10-01T10:30:00+07:00', '2026-10-01T03:30:00.000Z'],
    ['2026-10-01T10:30:00-03:30', '2026-10-01T14:00:00.000Z'],
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
    ['0096-02-29T00:00:00Z', '0096-02-29T00:00:00.000Z'],
    ['2026-10-01T00:00:00.123456789Z', '2026-10-01T00:00:00.123Z'],
  ])('parses explicit-zone instant %s', (due_at, expected) => {
    expect(parseCreateContributionRequestInput({ ...body, due_at }).dueAt?.toISOString()).toBe(
      expected,
    );
  });

  it.each([
    '2026-10-01',
    '2026-10-01T00:00:00',
    '2026-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '0100-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '0000-01-01T00:00:00Z',
    '2026-10-01T24:00:00Z',
    '2026-10-01T00:60:00Z',
    '2026-10-01T00:00:60Z',
    '2026-10-01T00:00:00+24:00',
    '2026-10-01T00:00:00+07:60',
    '2026-10-01T00:00:00Z\n',
    '2026-10-01T00:00:00.1234567890Z',
    0,
    new Date(),
  ])('rejects invalid or ambiguous instant %#', (due_at) => {
    expect(() => parseCreateContributionRequestInput({ ...body, due_at })).toThrow(
      ContributionRequestInputError,
    );
  });

  it('creates independent output without mutating frozen input', () => {
    const input = Object.freeze({
      ...body,
      contributions: Object.freeze([Object.freeze({ ...item })]),
      note: ' Nội dung ',
    });
    const before = structuredClone(input);
    const result = parseCreateContributionRequestInput(input);
    expect(input).toEqual(before);
    expect(result.contributions).not.toBe(input.contributions);
    expect(result.contributions[0]).not.toBe(input.contributions[0]);
    expect(result.note).toBe(' Nội dung ');
  });

  it('composes with current domain checks and never grants authorization from valid JSON', () => {
    const command = parseCreateContributionRequestInput(body);
    expect(() => assertCanCreateContributionRequest(command, context)).not.toThrow();
    expect(() =>
      assertCanCreateContributionRequest(command, { ...context, actorUserId: member }),
    ).toThrow(ContributionPermissionDeniedError);
    expect(() =>
      assertCanCreateContributionRequest(command, { ...context, destinations: [] }),
    ).toThrow(InvalidContributionRequestError);
    expect(() =>
      assertCanCreateContributionRequest(command, {
        ...context,
        activeMemberUserIds: new Set([owner]),
      }),
    ).toThrow(InvalidContributionRequestError);
  });
});
