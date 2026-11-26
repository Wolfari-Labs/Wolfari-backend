import { describe, expect, it } from 'vitest';
import { invitationEmail } from './invitation-email';

const ts = (iso: string) => ({ seconds: String(Date.parse(iso) / 1000), nanos: 0 });
const delivery = {
  recipient_email: 'guest@example.test',
  link: 'https://wolfari.example/invitations#token=inv1_' + 'a'.repeat(43),
  expires_at: ts('2026-12-03T03:00:00Z'),
  invitation_version: 1,
  trip_name: 'Đà Nẵng 3N2Đ',
  inviter_display_name: 'Huỳnh An',
  trip_start_at: ts('2026-12-20T01:00:00Z'),
  trip_end_at: ts('2026-12-22T10:00:00Z'),
  trip_timezone: 'Asia/Ho_Chi_Minh',
};

describe('invitation email', () => {
  it('says who invites the recipient to which trip, when, and links once', () => {
    const mail = invitationEmail(delivery);
    expect(mail.subject).toBe('Lời mời tham gia chuyến đi “Đà Nẵng 3N2Đ” từ Huỳnh An');
    expect(mail.text).toContain('Huỳnh An mời bạn tham gia chuyến đi “Đà Nẵng 3N2Đ” (20/12/2026 – 22/12/2026)');
    expect(mail.text).toContain(`Xem lời mời: ${delivery.link}`);
    expect(mail.text).toContain('Lời mời hết hạn lúc 10:00 03/12/2026.');
    expect(mail.text).toContain('Mở liên kết không tự động tham gia');
    expect(mail.html).toContain(`href="${delivery.link}"`);
    expect(mail.html).toContain('Xem lời mời');
  });

  it('escapes names in HTML and keeps the subject on one line', () => {
    const mail = invitationEmail({
      ...delivery,
      trip_name: '<script>alert(1)</script>\r\nBcc: x@y',
      inviter_display_name: 'A & "B"',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Bcc: x@y');
    expect(mail.html).toContain('A &amp; &quot;B&quot;');
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it('falls back when the inviter profile or the trip dates are missing', () => {
    const mail = invitationEmail({
      ...delivery,
      inviter_display_name: '',
      trip_start_at: undefined,
      trip_end_at: undefined,
      trip_timezone: 'Not/AZone',
    });
    expect(mail.subject).toBe('Lời mời tham gia chuyến đi “Đà Nẵng 3N2Đ” từ Một thành viên Wolfari');
    expect(mail.text).toContain('chuyến đi “Đà Nẵng 3N2Đ” trên Wolfari.');
  });
});
