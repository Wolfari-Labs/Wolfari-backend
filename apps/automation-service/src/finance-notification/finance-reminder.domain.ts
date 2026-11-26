/**
 * Scheduled Finance reminders (SRS FR-AU01 notification table):
 * - contribution request: 24 h before its deadline while contributions are PENDING, then at most
 *   once a day while overdue and the request is OPEN;
 * - Fund closure: at most once a day to members who have not confirmed, while CLOSING.
 * A schedule row only says when to look again. Finance answers who still owes / has to confirm and
 * whether the source is still in that state, so a paid, waived, cancelled or closed source stops.
 */
export type ReminderSource = 'CONTRIBUTION_REQUEST' | 'CLOSURE';
export type ReminderKind = 'CONTRIBUTION_DUE_SOON' | 'CONTRIBUTION_OVERDUE' | 'CLOSURE_PENDING';
export type ReminderPlan =
  | { action: 'remove' }
  | { action: 'wait'; nextAt: Date }
  | { action: 'notify'; kind: ReminderKind; nextAt: Date };

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** A reminder that nobody acts on for a month stops; the source itself stays as it is. */
export const MAX_REMINDERS = 30;
export const MAX_OVERDUE_DAYS = 30;

export const REMINDER_TEXT: Record<ReminderKind, { title: string; body: string }> = {
  // Lock-screen safe (AC-AU01): no amount, account or trip detail.
  CONTRIBUTION_DUE_SOON: {
    title: 'Sắp đến hạn góp quỹ',
    body: 'Bạn còn một khoản góp sắp đến hạn. Mở chuyến đi để xem.',
  },
  CONTRIBUTION_OVERDUE: {
    title: 'Khoản góp đã quá hạn',
    body: 'Bạn còn một khoản góp đã quá hạn. Mở chuyến đi để xem.',
  },
  CLOSURE_PENDING: {
    title: 'Quỹ đang chờ bạn xác nhận',
    body: 'Người giữ quỹ đang chốt quỹ và chờ bạn xác nhận. Mở chuyến đi để xem.',
  },
};

const at = (value: number) => new Date(value);

export function planReminder(
  row: { sourceType: ReminderSource; sentCount: number; createdAt: Date },
  source: { eligible: boolean; dueAt: Date | null; recipients: number },
  now: Date,
): ReminderPlan {
  if (!source.eligible || row.sentCount >= MAX_REMINDERS) return { action: 'remove' };
  const time = now.getTime();
  if (row.sourceType === 'CLOSURE') {
    const first = row.createdAt.getTime() + DAY;
    if (time < first) return { action: 'wait', nextAt: at(first) };
    // Everyone confirmed (or lost access): nobody to remind today, look again tomorrow.
    if (!source.recipients) return { action: 'wait', nextAt: at(time + DAY) };
    return { action: 'notify', kind: 'CLOSURE_PENDING', nextAt: at(time + DAY) };
  }
  // Finance gives a deadline only while someone still owes: no deadline, nothing to remind.
  if (!source.dueAt) return { action: 'remove' };
  const due = source.dueAt.getTime();
  if (time < due - DAY) return { action: 'wait', nextAt: at(due - DAY) };
  if (time < due)
    return source.recipients
      ? { action: 'notify', kind: 'CONTRIBUTION_DUE_SOON', nextAt: at(due + HOUR) }
      : { action: 'wait', nextAt: at(due + HOUR) };
  if (time > due + MAX_OVERDUE_DAYS * DAY) return { action: 'remove' };
  return source.recipients
    ? { action: 'notify', kind: 'CONTRIBUTION_OVERDUE', nextAt: at(time + DAY) }
    : { action: 'wait', nextAt: at(time + DAY) };
}

/** Calendar day in Vietnam: "at most once a day" means one notice per person per local day. */
export function reminderDay(now: Date): string {
  return new Date(now.getTime() + 7 * HOUR).toISOString().slice(0, 10);
}
export function reminderDedupeKey(kind: ReminderKind, sourceId: string, userId: string, now: Date) {
  return `finance-reminder:${kind}:${sourceId}:${userId}:${reminderDay(now)}`;
}
