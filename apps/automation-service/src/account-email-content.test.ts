import { describe, expect, it } from 'vitest';
import { accountEmailContent } from './account-email-content';

const link = 'http://127.0.0.1:3001/api/v1/auth/local/verify?token=abc';

describe('account email content', () => {
  it('leads with the 6-digit code and keeps the link as a fallback', () => {
    const mail = accountEmailContent({ purpose: 1, one_time_link: link, code: '012345' });
    expect(mail.subject).toBe('Xác minh email Wolfari · mã 012345');
    expect(mail.text.split('\n')[0]).toBe('Mã xác minh email của bạn: 012345');
    expect(mail.text).toContain('24 giờ');
    expect(mail.text).toContain(link);
    expect(mail.html).toContain('012 345');
  });
  it('uses the reset wording and validity', () => {
    const mail = accountEmailContent({ purpose: 2, one_time_link: link, code: '999999' });
    expect(mail.subject).toContain('Đặt lại mật khẩu Wolfari');
    expect(mail.text).toContain('Mã đặt lại mật khẩu của bạn: 999999');
    expect(mail.text).toContain('30 phút');
  });
  it('falls back to the link-only email for tokens issued before codes', () => {
    const mail = accountEmailContent({ purpose: 1, one_time_link: link, code: '' });
    expect(mail.subject).toBe('Xác minh email Wolfari');
    expect(mail.text).toContain(link);
    expect('html' in mail).toBe(false);
  });
  it('escapes the link inside HTML', () => {
    const mail = accountEmailContent({
      purpose: 1,
      one_time_link: 'http://x/?a="<b>',
      code: '123456',
    });
    expect(mail.html).not.toContain('"<b>');
  });
});
