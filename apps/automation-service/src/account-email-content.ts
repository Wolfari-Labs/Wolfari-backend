const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The 6-digit code is what people type in the app; the link stays as a fallback
 * for the web client and for tokens issued before codes existed.
 */
export function accountEmailContent(delivery: {
  purpose?: number;
  one_time_link?: string;
  code?: string;
}) {
  const link = delivery.one_time_link ?? '';
  const verify = delivery.purpose === 1;
  const subject = verify ? 'Xác minh email Wolfari' : 'Đặt lại mật khẩu Wolfari';
  const validity = verify ? '24 giờ' : '30 phút';
  const code = delivery.code && /^[0-9]{6}$/.test(delivery.code) ? delivery.code : undefined;
  const action = verify ? 'xác minh email' : 'đặt lại mật khẩu';
  const ignore =
    'Nếu bạn không yêu cầu, hãy bỏ qua email này. Wolfari không bao giờ hỏi mã này qua điện thoại hay tin nhắn.';
  if (!code)
    return {
      subject,
      text: `Mở liên kết sau để ${action}: ${link}\n${ignore}`,
    };
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  return {
    subject: `${subject} · mã ${code}`,
    text: [
      `Mã ${action} của bạn: ${code}`,
      `Nhập mã này trong ứng dụng Wolfari. Mã có hiệu lực ${validity} và chỉ dùng một lần.`,
      '',
      `Hoặc mở liên kết: ${link}`,
      ignore,
    ].join('\n'),
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;color:#173f63">
<h2 style="margin:0 0 12px">${subject}</h2>
<p style="margin:0 0 8px">Mã ${action} của bạn:</p>
<p style="font-size:34px;font-weight:800;letter-spacing:8px;margin:0 0 12px;font-variant-numeric:tabular-nums">${spaced}</p>
<p style="margin:0 0 16px">Nhập mã này trong ứng dụng Wolfari. Mã có hiệu lực ${validity} và chỉ dùng một lần.</p>
<p style="margin:0 0 16px;font-size:13px;color:#5b6b7f">Hoặc <a href="${escapeHtml(link)}">mở liên kết này</a>.</p>
<p style="margin:0;font-size:12px;color:#5b6b7f">${escapeHtml(ignore)}</p>
</div>`,
  };
}
