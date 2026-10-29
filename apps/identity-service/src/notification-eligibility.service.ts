import { Inject, Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class NotificationEligibilityValidationError extends Error {
  constructor() {
    super('VALIDATION_FAILED');
  }
}

@Injectable()
export class NotificationEligibilityService {
  constructor(
    @Inject(DatabaseProvider)
    private readonly database: Pick<DatabaseProvider, 'pool'>,
  ) {}

  async get(userIds: unknown): Promise<{
    recipients: { user_id: string; eligible: boolean }[];
  }> {
    if (!Array.isArray(userIds) || userIds.length < 1 || userIds.length > 100)
      throw new NotificationEligibilityValidationError();
    const unique = new Set<string>();
    for (const userId of userIds) {
      if (typeof userId !== 'string' || userId.length !== 36 || !UUID.test(userId))
        throw new NotificationEligibilityValidationError();
      unique.add(userId.toLowerCase());
    }
    const requested = [...unique];
    const deadline = Date.now() + 1500;
    const client = await this.database.pool.connect();
    let failed = false;
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('NOTIFICATION_ELIGIBILITY_UNAVAILABLE');
      // pg supports a response timeout although its QueryConfig typings omit this option.
      const query = {
        text:
          "SELECT id FROM users WHERE id=ANY($1::uuid[]) AND status='ACTIVE' " +
          'AND deletion_requested_at IS NULL AND anonymized_at IS NULL',
        values: [requested],
        query_timeout: Math.max(1, Math.min(1500, remaining)),
      };
      const { rows } = await client.query<{ id: string }>(query);
      if (Date.now() >= deadline) throw new Error('NOTIFICATION_ELIGIBILITY_UNAVAILABLE');
      const eligible = new Set(rows.map((row) => row.id));
      return {
        recipients: requested.map((user_id) => ({ user_id, eligible: eligible.has(user_id) })),
      };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Destroy failed/timed-out sockets so uncertain server work cannot return to the pool.
      client.release(failed);
    }
  }
}
