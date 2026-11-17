export type OrderedSchedule = {
  id: string;
  day: string | null;
  starts_at: string | Date | null;
};

/** Input is in persisted order. Only reconcile days whose relative order changes. */
export function conflictingOrderTimes(
  activities: readonly OrderedSchedule[],
  orderedIds: readonly string[],
): string[] {
  const byId = new Map(activities.map((item) => [item.id, item]));
  const days = new Map<string, { before: string[]; after: string[] }>();
  for (const item of activities) {
    if (!item.day) continue;
    let group = days.get(item.day);
    if (!group) days.set(item.day, (group = { before: [], after: [] }));
    group.before.push(item.id);
  }
  for (const id of orderedIds) {
    const day = byId.get(id)?.day;
    if (day) days.get(day)?.after.push(id);
  }
  const cleared: string[] = [];
  for (const { before, after } of days.values()) {
    if (before.every((id, index) => id === after[index])) continue;
    let latest = -Infinity;
    for (const id of after) {
      const starts = byId.get(id)?.starts_at;
      if (!starts) continue;
      const instant = new Date(starts).getTime();
      if (instant < latest) cleared.push(id);
      else latest = instant;
    }
  }
  return cleared;
}
