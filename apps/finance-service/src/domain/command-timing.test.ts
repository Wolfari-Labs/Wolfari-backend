import { describe, expect, it } from 'vitest';
import { assertCommandTiming, COMMAND_CLOCK_SKEW_MS, CommandTimingError } from './command-timing';

const now = Date.parse('2026-11-15T10:00:00Z');
const at = (offset: number) => new Date(now + offset);

describe('time-relative rules for new Finance commands', () => {
  it('rejects a new contribution request that is already overdue beyond clock skew', () => {
    const command = (dueAt: Date | null) => ({
      scope: 'CREATE_CONTRIBUTION_REQUEST',
      body: { dueAt },
    });
    expect(() => assertCommandTiming(command(at(-COMMAND_CLOCK_SKEW_MS - 1)), now)).toThrow(
      new CommandTimingError('due_at'),
    );
    expect(() => assertCommandTiming(command(at(-COMMAND_CLOCK_SKEW_MS)), now)).not.toThrow();
    expect(() => assertCommandTiming(command(at(86_400_000)), now)).not.toThrow();
    expect(() => assertCommandTiming(command(null), now)).not.toThrow();
  });
  it('does not re-check due dates when an existing request is updated', () => {
    expect(() =>
      assertCommandTiming(
        { scope: 'UPDATE_CONTRIBUTION_REQUEST', body: { dueAt: at(-86_400_000) } },
        now,
      ),
    ).not.toThrow();
  });
  it.each(['CREATE_EXPENSE', 'UPDATE_EXPENSE', 'CONFIRM_EXPENSE'])(
    '%s rejects paid_at in the future beyond clock skew',
    (scope) => {
      expect(() =>
        assertCommandTiming({ scope, body: { paidAt: at(COMMAND_CLOCK_SKEW_MS + 1) } }, now),
      ).toThrow(new CommandTimingError('paid_at'));
      expect(() =>
        assertCommandTiming({ scope, body: { paidAt: at(COMMAND_CLOCK_SKEW_MS) } }, now),
      ).not.toThrow();
      expect(() =>
        assertCommandTiming({ scope, body: { paidAt: at(-86_400_000) } }, now),
      ).not.toThrow();
      expect(() => assertCommandTiming({ scope, body: { paidAt: null } }, now)).not.toThrow();
      expect(() => assertCommandTiming({ scope, body: {} }, now)).not.toThrow();
    },
  );
  it('ignores scopes without time-relative rules', () => {
    expect(() =>
      assertCommandTiming({ scope: 'CREATE_REFUND', body: { paidAt: at(86_400_000) } }, now),
    ).not.toThrow();
  });
});
