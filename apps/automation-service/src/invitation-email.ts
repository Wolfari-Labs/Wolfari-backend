import type { TripV1 } from '@wolfari/contracts/grpc';

type Timestamp = { seconds?: string | number; nanos?: number } | undefined;
const toDate = (value: Timestamp) =>
  value?.seconds === undefined
    ? undefined
    : new Date(Number(value.seconds) * 1000 + Math.floor((value.nanos ?? 0) / 1_000_000));
/** One line, no control characters: trip and inviter names are user input. */
const plain = (value: string | undefined, max: number) =>
  (value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
function zone(value: string | undefined) {
  try {
    new Intl.DateTimeFormat('vi-VN', { timeZone: value || 'Asia/Ho_Chi_Minh' });
    return value || 'Asia/Ho_Chi_Minh';
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
}
const day = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('vi-VN', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
const moment = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('vi-VN', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);

/**
 * The EMAIL invitation as people expect it from any app: who invites them to which trip and
 * when, one button, and what happens next. Opening the link never accepts by itself.
 */
export function invitationEmail(delivery: TripV1.InvitationDelivery) {
  const timeZone = zone(delivery.trip_timezone);
  const trip = plain(delivery.trip_name, 120) || 'một chuyến đi';
  const inviter = plain(delivery.inviter_display_name, 80) || 'Một thành viên Wolfari';
  const start = toDate(delivery.trip_start_at),
    end = toDate(delivery.trip_end_at),
    expires = toDate(delivery.expires_at);
  const dates =
    start && end
      ? day(start, timeZone) === day(end, timeZone)
        ? day(start, timeZone)
        : `${day(start, timeZone)} – ${day(end, timeZone)}`
      : '';
  const link = delivery.link ?? '';
  const expiry = expires ? `Lời mời hết hạn lúc ${moment(expires, timeZone)}.` : '';
  const subject = plain(`${inviter} mời bạn tham gia chuyến đi “${trip}” trên Wolfari`, 200);
  const steps =
    'Mở liên kết không tự động tham gia: đăng nhập hoặc tạo tài khoản Wolfari bằng chính địa chỉ email này, rồi chọn Tham gia hoặc Từ chối. Nếu đã cài ứng dụng Wolfari, đăng nhập bằng email này để thấy lời mời trong mục “Lời mời đang chờ”.';
  const ignore = 'Nếu bạn không biết người mời, hãy bỏ qua email này.';
  const text = [
    'Xin chào,',
    '',
    `${inviter} mời bạn tham gia chuyến đi “${trip}”${dates ? ` (${dates})` : ''} trên Wolfari.`,
    '',
    `Xem lời mời: ${link}`,
    '',
    ...(expiry ? [expiry] : []),
    steps,
    '',
    ignore,
  ].join('\n');
  const html =
    '<!doctype html><html lang="vi"><body style="margin:0;padding:24px;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">' +
    '<p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;color:#6b7280">WOLFARI · LỜI MỜI CHUYẾN ĐI</p>' +
    `<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3">${escapeHtml(trip)}</h1>` +
    (dates ? `<p style="margin:0 0 16px;color:#4b5563">${escapeHtml(dates)}</p>` : '') +
    `<p style="margin:0 0 24px;line-height:1.5"><strong>${escapeHtml(inviter)}</strong> mời bạn tham gia chuyến đi này.</p>` +
    `<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 24px;border-radius:12px;background:#1f6feb;color:#ffffff;text-decoration:none;font-weight:bold">Xem lời mời</a></p>` +
    (expiry ? `<p style="margin:0 0 12px;font-size:14px;color:#4b5563">${escapeHtml(expiry)}</p>` : '') +
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#4b5563">${escapeHtml(steps)}</p>` +
    `<p style="margin:0;font-size:13px;color:#9ca3af">${escapeHtml(ignore)}</p>` +
    '</div></body></html>';
  return { subject, text, html };
}
