import { Injectable } from '@nestjs/common';
import { DatabaseProvider } from '@wolfari/database';
import type { QueryResultRow } from 'pg';
import {
  parseStoredGroups,
  type DevicePlatform,
  type PreferenceGroups,
  type UnreadFilter,
} from './notification.domain';
import type { NotificationCursorValue } from './notification.cursor';
import { notificationFail } from './notification.errors';

type PreferenceRow = QueryResultRow & {
  push_enabled: boolean;
  email_enabled: boolean;
  group_overrides: unknown;
  version: number;
};

type DeviceRow = QueryResultRow & {
  id: string;
  user_id: string;
  platform: DevicePlatform;
  active: boolean;
  last_seen_at: Date | string;
};

type NotificationRow = QueryResultRow & {
  id: string;
  user_id: string;
  trip_id: string | null;
  type: string;
  title: string;
  body: string;
  source_id: string | null;
  status: 'AVAILABLE';
  created_at: Date | string;
  read_at: Date | string | null;
};

export interface NotificationPreferenceRecord {
  push_enabled: boolean;
  email_enabled: boolean;
  group_overrides: PreferenceGroups;
  version: number;
}

export interface DeviceRecord {
  id: string;
  platform: DevicePlatform;
  active: boolean;
  last_seen_at: string;
}

export interface NotificationRecord {
  id: string;
  trip_id: string | null;
  type: string;
  title: string;
  body: string;
  source_id: string | null;
  status: 'AVAILABLE';
  created_at: string;
  read_at: string | null;
}

function iso(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error('Invalid database timestamp');
  return result.toISOString();
}

function preference(row: PreferenceRow): NotificationPreferenceRecord {
  return {
    push_enabled: row.push_enabled,
    email_enabled: row.email_enabled,
    group_overrides: parseStoredGroups(row.group_overrides),
    version: row.version,
  };
}

function device(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    platform: row.platform,
    active: row.active,
    last_seen_at: iso(row.last_seen_at),
  };
}

function notification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    trip_id: row.trip_id,
    type: row.type,
    title: row.title,
    body: row.body,
    source_id: row.source_id,
    status: row.status,
    created_at: iso(row.created_at),
    read_at: row.read_at === null ? null : iso(row.read_at),
  };
}

const NOTIFICATION_SELECT = `SELECT id,user_id,trip_id,type,title,body,source_id,status,created_at,read_at
  FROM notifications`;

@Injectable()
export class NotificationRepository {
  constructor(private readonly database: DatabaseProvider) {}

  async getPreference(userId: string): Promise<NotificationPreferenceRecord> {
    const result = await this.database.query<PreferenceRow>(
      'SELECT push_enabled,email_enabled,group_overrides,version FROM notification_preferences WHERE user_id=$1',
      [userId],
    );
    return result.rows[0]
      ? preference(result.rows[0])
      : { push_enabled: true, email_enabled: true, group_overrides: {}, version: 1 };
  }

  async updatePreference(input: {
    userId: string;
    pushEnabled: boolean;
    emailEnabled: boolean;
    groupOverrides: PreferenceGroups;
    expectedVersion: number;
  }): Promise<NotificationPreferenceRecord> {
    return this.database.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,918271))', [
        input.userId,
      ]);
      const found = await client.query<PreferenceRow>(
        'SELECT push_enabled,email_enabled,group_overrides,version FROM notification_preferences WHERE user_id=$1 FOR UPDATE',
        [input.userId],
      );
      const current = found.rows[0];
      const currentVersion = current?.version ?? 1;
      if (currentVersion !== input.expectedVersion)
        return notificationFail('VERSION_CONFLICT', { current_version: currentVersion });
      if (currentVersion >= 2_147_483_647) return notificationFail('STATE_CONFLICT');
      const nextVersion = currentVersion + 1;
      const values = [
        input.userId,
        input.pushEnabled,
        input.emailEnabled,
        JSON.stringify(input.groupOverrides),
        nextVersion,
      ];
      const changed = current
        ? await client.query<PreferenceRow>(
            `UPDATE notification_preferences SET push_enabled=$2,email_enabled=$3,
               group_overrides=$4::jsonb,version=$5,updated_at=clock_timestamp()
             WHERE user_id=$1 RETURNING push_enabled,email_enabled,group_overrides,version`,
            values,
          )
        : await client.query<PreferenceRow>(
            `INSERT INTO notification_preferences(user_id,push_enabled,email_enabled,group_overrides,version)
             VALUES($1,$2,$3,$4::jsonb,$5)
             RETURNING push_enabled,email_enabled,group_overrides,version`,
            values,
          );
      return preference(changed.rows[0]!);
    });
  }

  async registerDevice(input: {
    userId: string;
    platform: DevicePlatform;
    token: string;
  }): Promise<DeviceRecord> {
    return this.database.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,918272))', [
        input.token,
      ]);
      const found = await client.query<DeviceRow>(
        'SELECT id,user_id,platform,active,last_seen_at FROM device_tokens WHERE token=$1 FOR UPDATE',
        [input.token],
      );
      const current = found.rows[0];
      if (current && current.user_id !== input.userId) return notificationFail('STATE_CONFLICT');
      const changed = current
        ? await client.query<DeviceRow>(
            `UPDATE device_tokens SET platform=$2,active=true,last_seen_at=clock_timestamp(),
               updated_at=clock_timestamp() WHERE id=$1
             RETURNING id,user_id,platform,active,last_seen_at`,
            [current.id, input.platform],
          )
        : await client.query<DeviceRow>(
            `INSERT INTO device_tokens(user_id,platform,token,active,last_seen_at)
             VALUES($1,$2,$3,true,clock_timestamp())
             RETURNING id,user_id,platform,active,last_seen_at`,
            [input.userId, input.platform, input.token],
          );
      return device(changed.rows[0]!);
    });
  }

  async deleteDevice(userId: string, deviceId: string): Promise<void> {
    await this.database.query('DELETE FROM device_tokens WHERE id=$1 AND user_id=$2', [
      deviceId,
      userId,
    ]);
  }

  async listNotifications(
    userId: string,
    unread: UnreadFilter,
    limit: number,
    after?: NotificationCursorValue,
  ): Promise<NotificationRecord[]> {
    const readClause =
      unread === 'UNREAD'
        ? 'AND read_at IS NULL'
        : unread === 'READ'
          ? 'AND read_at IS NOT NULL'
          : '';
    const cursorClause = after ? 'AND (created_at,id)<($3::timestamptz,$4::uuid)' : '';
    const values: unknown[] = after ? [userId, limit, after.sort_at, after.id] : [userId, limit];
    const result = await this.database.query<NotificationRow>(
      `${NOTIFICATION_SELECT}
       WHERE user_id=$1 AND status='AVAILABLE' ${readClause} ${cursorClause}
       ORDER BY created_at DESC,id DESC LIMIT $2`,
      values,
    );
    return result.rows.map(notification);
  }

  async markRead(userId: string, notificationId: string): Promise<NotificationRecord> {
    const result = await this.database.query<NotificationRow>(
      `UPDATE notifications SET read_at=COALESCE(read_at,clock_timestamp())
       WHERE id=$1 AND user_id=$2 AND status='AVAILABLE'
       RETURNING id,user_id,trip_id,type,title,body,source_id,status,created_at,read_at`,
      [notificationId, userId],
    );
    return result.rows[0] ? notification(result.rows[0]) : notificationFail('RESOURCE_NOT_FOUND');
  }
}
