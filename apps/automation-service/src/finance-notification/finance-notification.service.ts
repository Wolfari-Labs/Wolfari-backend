import { Inject, Injectable } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { FinanceV1, type IdentityV1 } from '@wolfari/contracts/grpc';
import { FinanceNotificationClient } from './finance-notification.client';
import { FinanceNotificationRepository } from './finance-notification.repository';
import { recipientUuid, type ContributionNotificationEvent } from './finance-notification.event';

const unavailable = (): never => {
  throw new Error('FINANCE_NOTIFICATION_CONTEXT_UNAVAILABLE');
};
function currentTime(deadline: number): void {
  if (Date.now() >= deadline) unavailable();
}
function trustedMissing(error: unknown): boolean {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== status.NOT_FOUND ||
    !('details' in error) ||
    typeof error.details !== 'string'
  )
    return false;
  try {
    return JSON.parse(error.details)?.code === 'RESOURCE_NOT_FOUND';
  } catch {
    return false;
  }
}
function context(
  value: FinanceV1.GetAutomationContextResponse,
  event: ContributionNotificationEvent,
) {
  if (
    !value ||
    !Number.isInteger(value.finance_version) ||
    value.finance_version! < event.version ||
    value.finance_version! > 2147483647 ||
    ![1, 2, 3].includes(value.status!)
  )
    return unavailable();
  const raw = value.authorized_recipients ?? [];
  if (!Array.isArray(raw) || raw.length > event.contributionCount) return unavailable();
  const users = raw.map((item) => recipientUuid(item?.user_id)).sort();
  if (new Set(users).size !== users.length || (value.status !== 1 && users.length))
    return unavailable();
  const due = value.due_at;
  if (
    due !== undefined &&
    (typeof due.seconds !== 'string' ||
      !/^-?\d{1,12}$/.test(due.seconds) ||
      BigInt(due.seconds) < -62135596800n ||
      BigInt(due.seconds) > 253402300799n ||
      !Number.isInteger(due.nanos ?? 0) ||
      (due.nanos ?? 0) < 0 ||
      (due.nanos ?? 0) > 999999999)
  )
    return unavailable();
  return {
    version: value.finance_version,
    status: value.status,
    users,
    due: due ? [due.seconds, due.nanos ?? 0] : null,
  };
}
function eligible(
  value: IdentityV1.GetNotificationEligibilityResponse,
  expected: string[],
): string[] {
  if (!value || !Array.isArray(value.recipients) || value.recipients.length !== expected.length)
    return unavailable();
  const wanted = new Set(expected),
    seen = new Set<string>(),
    accepted: string[] = [];
  for (const row of value.recipients) {
    const id = recipientUuid(row?.user_id);
    // proto3 defaults:false omits false. Missing record/ID is still an invalid response.
    if (
      !wanted.has(id) ||
      seen.has(id) ||
      (row.eligible !== undefined && typeof row.eligible !== 'boolean')
    )
      return unavailable();
    seen.add(id);
    if (row.eligible === true) accepted.push(id);
  }
  return accepted;
}

@Injectable()
export class FinanceNotificationService {
  constructor(
    @Inject(FinanceNotificationClient)
    private readonly client: Pick<FinanceNotificationClient, 'getContext' | 'getEligibility'>,
    @Inject(FinanceNotificationRepository)
    private readonly repository: Pick<FinanceNotificationRepository, 'isProcessed' | 'complete'>,
  ) {}

  async process(event: ContributionNotificationEvent, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10_000;
    const check = () => {
      currentTime(deadline);
      if (signal?.aborted) unavailable();
    };
    check();
    if (await this.repository.isProcessed(event)) return;
    const read = async () => {
      check();
      try {
        return context(await this.client.getContext(event, deadline), event);
      } catch (error) {
        if (trustedMissing(error)) return null;
        throw error;
      }
    };
    const first = await read();
    const accepted: string[] = [];
    // Sequential bounded batches keep a partial Identity result out of the local transaction.
    for (let index = 0; index < (first?.users.length ?? 0); index += 100) {
      check();
      const batch = first!.users.slice(index, index + 100);
      accepted.push(
        ...eligible(await this.client.getEligibility(batch, event.correlationId, deadline), batch),
      );
    }
    const last = await read();
    check();
    if (JSON.stringify(first) !== JSON.stringify(last)) return unavailable();
    await this.repository.complete(event, accepted);
  }
}
