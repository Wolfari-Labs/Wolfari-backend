import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'docs/api/notification.openapi.yaml'), 'utf8');

describe.each([
  ['LF', '\n'],
  ['CRLF', '\r\n'],
])('Notification OpenAPI (%s)', (_style, newline) => {
  const document = source.replace(/\r?\n/g, newline);
  it('documents API126–131 exactly once without claiming the Reminder API', () => {
    for (const operation of [
      'getNotificationPreferences',
      'updateNotificationPreferences',
      'registerDevice',
      'deleteDevice',
      'listNotifications',
      'markNotificationRead',
    ])
      expect(document.match(new RegExp(`operationId: ${operation}\\b`, 'g'))).toHaveLength(1);
    expect(document).not.toContain('operationId: listReminders');
    expect(document).not.toContain('/me/reminders');
  });

  it('keeps device tokens write-only and documents version/filter rules', () => {
    const deviceProjection = document.match(
      /^ {4}Device:\r?\n([\s\S]*?)^ {4}Notification:\r?$/m,
    )?.[1];
    expect(deviceProjection).toContain('required: [id, platform, active, last_seen_at]');
    expect(deviceProjection).not.toContain('token:');
    expect(document).toContain(
      'required: [push_enabled, email_enabled, group_overrides, expected_version]',
    );
    expect(document).toContain('Global push kill switch');
    expect(document).toContain('name: unread');
    expect(document).toContain('inaccessible Trip content is masked');
    expect(document).not.toContain('private_context');
    expect(document).not.toContain('recipient_email');
  });
});
