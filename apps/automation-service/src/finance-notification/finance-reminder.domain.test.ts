import { describe, expect, it } from 'vitest';
import {
  DAY,
  HOUR,
  MAX_REMINDERS,
  planReminder,
  reminderDay,
  reminderDedupeKey,
} from './finance-reminder.domain';

const created = new Date('2026-12-01T00:00:00Z');
const due = new Date('2026-12-10T12:00:00Z');
const request = { sourceType: 'CONTRIBUTION_REQUEST' as const, sentCount: 0, createdAt: created };
const owing = { eligible: true, dueAt: due, recipients: 2 };
const t = (offset: number) => new Date(due.getTime() + offset);

describe('Finance reminder plan', () => {
  it('waits until 24 h before the deadline, reminds once, then checks just after it', () => {
    expect(planReminder(request, owing, created)).toEqual({ action: 'wait', nextAt: t(-DAY) });
    expect(planReminder(request, owing, t(-DAY))).toEqual({
      action: 'notify',
      kind: 'CONTRIBUTION_DUE_SOON',
      nextAt: t(HOUR),
    });
  });

  it('reminds an overdue request at most once a day for a month', () => {
    expect(planReminder(request, owing, t(HOUR))).toEqual({
      action: 'notify',
      kind: 'CONTRIBUTION_OVERDUE',
      nextAt: t(HOUR + DAY),
    });
    expect(planReminder(request, owing, t(31 * DAY))).toEqual({ action: 'remove' });
    expect(planReminder({ ...request, sentCount: MAX_REMINDERS }, owing, t(HOUR))).toEqual({
      action: 'remove',
    });
  });

  it('stops when the request is no longer open or nobody owes any more', () => {
    expect(planReminder(request, { ...owing, eligible: false }, t(-DAY))).toEqual({ action: 'remove' });
    expect(planReminder(request, { eligible: true, dueAt: null, recipients: 0 }, t(-DAY))).toEqual({
      action: 'remove',
    });
    expect(planReminder(request, { ...owing, recipients: 0 }, t(-HOUR))).toEqual({
      action: 'wait',
      nextAt: t(HOUR),
    });
  });

  it('reminds members of a pending closure daily from the day after it started', () => {
    const closure = { sourceType: 'CLOSURE' as const, sentCount: 0, createdAt: created };
    const pending = { eligible: true, dueAt: null, recipients: 1 };
    expect(planReminder(closure, pending, new Date(created.getTime() + HOUR))).toEqual({
      action: 'wait',
      nextAt: new Date(created.getTime() + DAY),
    });
    const later = new Date(created.getTime() + DAY + HOUR);
    expect(planReminder(closure, pending, later)).toEqual({
      action: 'notify',
      kind: 'CLOSURE_PENDING',
      nextAt: new Date(later.getTime() + DAY),
    });
    expect(planReminder(closure, { ...pending, recipients: 0 }, later)).toEqual({
      action: 'wait',
      nextAt: new Date(later.getTime() + DAY),
    });
    expect(planReminder(closure, { ...pending, eligible: false }, later)).toEqual({ action: 'remove' });
  });

  it('dedupes per person per Vietnamese calendar day', () => {
    expect(reminderDay(new Date('2026-12-10T16:59:00Z'))).toBe('2026-12-10');
    expect(reminderDay(new Date('2026-12-10T17:00:00Z'))).toBe('2026-12-11');
    expect(
      reminderDedupeKey('CONTRIBUTION_OVERDUE', 'r', 'u', new Date('2026-12-10T03:00:00Z')),
    ).toBe('finance-reminder:CONTRIBUTION_OVERDUE:r:u:2026-12-10');
  });
});
