import type SMTPTransport from 'nodemailer/lib/smtp-transport';

/** Local Mailpit stays zero-config; remote SMTP always requires encrypted transport. */
export function smtpConfiguration(config: { get(name: string): unknown }): {
  options: SMTPTransport.Options;
  from: string;
} {
  const value = (name: string) => String(config.get(name) ?? '').trim();
  const host = value('SMTP_HOST');
  const portText = value('SMTP_PORT');
  if (
    !host ||
    /[\s/\\@]/.test(host) ||
    !/^\d+$/.test(portText) ||
    Number(portText) < 1 ||
    Number(portText) > 65535
  )
    throw new Error('Invalid SMTP host or port');
  const port = Number(portText),
    local = ['localhost', '127.0.0.1', '::1', 'mailpit'].includes(host.toLowerCase());
  const flag = (name: string, fallback: boolean) => {
    const raw = value(name);
    if (!raw) return fallback;
    if (!['true', 'false'].includes(raw)) throw new Error(`Invalid ${name}`);
    return raw === 'true';
  };
  const secure = flag('SMTP_SECURE', port === 465);
  const requireTLS = flag('SMTP_REQUIRE_TLS', !secure && !local);
  if (!local && !secure && !requireTLS) throw new Error('Remote SMTP requires TLS');
  const user = value('SMTP_USER'),
    pass = String(config.get('SMTP_PASSWORD') ?? '');
  if (Boolean(user) !== Boolean(pass))
    throw new Error('SMTP user and password must be configured together');
  const from =
    value('SMTP_FROM') || (user ? `Wolfari <${user}>` : 'Wolfari <no-reply@wolfari.local>');
  const address = /<([^<>]+)>$/.exec(from)?.[1] ?? from;
  if (
    /[\r\n]/.test(from) ||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address) ||
    (!local && address.endsWith('.local'))
  )
    throw new Error('Invalid SMTP sender');
  return {
    from,
    options: {
      host,
      port,
      secure,
      requireTLS,
      ...(user ? { auth: { user, pass } } : {}),
      connectionTimeout: local ? 2000 : 10000,
      greetingTimeout: local ? 2000 : 10000,
      socketTimeout: local ? 5000 : 30000,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      logger: false,
      debug: false,
    },
  };
}
