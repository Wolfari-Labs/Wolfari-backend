import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { AppName } from './environment';

type Values = Record<string, unknown>;
type Config = { get(key: string): unknown };
export const TRIAL_PROFILE = 'single-host-trial';

export function productionTransportBlocked(values: Values = process.env): boolean {
  return values.NODE_ENV === 'production' && values.WOLFARI_DEPLOYMENT_PROFILE !== TRIAL_PROFILE;
}

export function productionTransportBlockedFor(config: Config): boolean {
  return productionTransportBlocked({
    NODE_ENV: config.get('NODE_ENV') ?? process.env.NODE_ENV,
    WOLFARI_DEPLOYMENT_PROFILE:
      config.get('WOLFARI_DEPLOYMENT_PROFILE') ?? process.env.WOLFARI_DEPLOYMENT_PROFILE,
  });
}

function invalid(key: string): never {
  throw new Error(`Invalid trial configuration: ${key}`);
}
const tcpPort = (value: string) =>
  /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535;
export function trialEmails(value: unknown): Set<string> {
  if (typeof value !== 'string') return invalid('IDENTITY_REGISTRATION_ALLOWLIST');
  const emails = value.split(',').map((email) => email.trim().toLowerCase());
  if (
    !emails.length ||
    emails.length > 20 ||
    emails.some(
      (email) => email.length > 255 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email),
    )
  )
    return invalid('IDENTITY_REGISTRATION_ALLOWLIST');
  return new Set(emails);
}

const required: Partial<Record<AppName, string[]>> = {
  'api-gateway': [
    'IDENTITY_HTTP_URL',
    'TRIP_HTTP_URL',
    'FINANCE_HTTP_URL',
    'AUTOMATION_HTTP_URL',
    'IDENTITY_GRPC_TARGET',
    'TRIP_GRPC_TARGET',
    'FINANCE_GRPC_TARGET',
    'AUTOMATION_GRPC_TARGET',
    'GATEWAY_IDENTITY_SECRET',
    'GATEWAY_TRIP_SECRET',
    'GATEWAY_FINANCE_SECRET',
    'GATEWAY_AUTOMATION_SECRET',
    'GATEWAY_CSRF_KEY',
    'WEB_ORIGIN',
  ],
  'identity-service': [
    'DATABASE_URL',
    'IDENTITY_ACCESS_PRIVATE_KEY',
    'IDENTITY_ACCESS_PUBLIC_KEY',
    'IDENTITY_TOKEN_KEY',
    'GATEWAY_IDENTITY_SECRET',
    'AUTOMATION_IDENTITY_SECRET',
    'TRIP_IDENTITY_SECRET',
    'RABBITMQ_URL',
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    'IDENTITY_LINK_BASE_URL',
    'IDENTITY_REGISTRATION_ALLOWLIST',
  ],
  'trip-workspace-service': [
    'DATABASE_URL',
    'IDENTITY_GRPC_TARGET',
    'FINANCE_GRPC_TARGET',
    'GATEWAY_TRIP_SECRET',
    'TRIP_IDENTITY_SECRET',
    'FINANCE_TRIP_SECRET',
    'TRIP_FINANCE_SECRET',
    'AUTOMATION_TRIP_SECRET',
    'TRIP_INVITATION_TOKEN_KEY',
    'TRIP_INVITATION_LINK_BASE_URL',
    'RABBITMQ_URL',
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
  ],
  'finance-service': [
    'DATABASE_URL',
    'TRIP_GRPC_TARGET',
    'GATEWAY_FINANCE_SECRET',
    'FINANCE_TRIP_SECRET',
    'TRIP_FINANCE_SECRET',
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
  ],
  'automation-service': [
    'DATABASE_URL',
    'IDENTITY_GRPC_TARGET',
    'TRIP_GRPC_TARGET',
    'AUTOMATION_IDENTITY_SECRET',
    'AUTOMATION_TRIP_SECRET',
    'GATEWAY_AUTOMATION_SECRET',
    'AUTOMATION_CURSOR_SECRET',
    'RABBITMQ_URL',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
  ],
  'travel-intelligence-service': ['DATABASE_URL'],
};

/** This is the startup boundary. The profile is not permission for remote plaintext. */
export function validateDeploymentEnvironment(values: Values, app: AppName): void {
  const profile = values.WOLFARI_DEPLOYMENT_PROFILE;
  if (profile !== undefined && profile !== TRIAL_PROFILE) invalid('WOLFARI_DEPLOYMENT_PROFILE');
  if (profile && values.NODE_ENV !== 'production') invalid('NODE_ENV');
  if (values.NODE_ENV !== 'production') return;
  if (productionTransportBlocked(values)) invalid('WOLFARI_DEPLOYMENT_PROFILE');
  if (values.WOLFARI_ISOLATED_ENV !== '1') invalid('WOLFARI_ISOLATED_ENV');
  for (const key of required[app] ?? []) if (!values[key]) invalid(key);
  for (const [key, raw] of Object.entries(values)) {
    const value = String(raw ?? '');
    if (/_GRPC_TARGET$/.test(key) || key === 'MINIO_ENDPOINT') {
      if (!/^127\.0\.0\.1:\d+$/.test(value) || !tcpPort(value.split(':')[1]!)) invalid(key);
    }
    if (/_HTTP_URL$/.test(key) || key === 'DATABASE_URL' || key === 'RABBITMQ_URL') {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return invalid(key);
      }
      const protocols =
        key === 'DATABASE_URL'
          ? ['postgres:', 'postgresql:']
          : key === 'RABBITMQ_URL'
            ? ['amqp:']
            : ['http:'];
      if (
        url.hostname !== '127.0.0.1' ||
        !protocols.includes(url.protocol) ||
        !tcpPort(url.port) ||
        url.search ||
        url.hash
      )
        invalid(key);
      if (key.endsWith('_HTTP_URL') && (url.username || url.password || url.pathname !== '/'))
        invalid(key);
      if (!key.endsWith('_HTTP_URL') && (!url.username || !url.password)) invalid(key);
    }
    if (
      key.endsWith('_SECRET') ||
      key === 'GATEWAY_CSRF_KEY' ||
      key.endsWith('_TOKEN_KEY') ||
      key === 'MINIO_SECRET_KEY'
    ) {
      if (value.length < 32 || /change-me|replace-me/i.test(value)) invalid(key);
    }
    if (['WEB_ORIGIN', 'IDENTITY_LINK_BASE_URL', 'TRIP_INVITATION_LINK_BASE_URL'].includes(key)) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return invalid(key);
      }
      if (
        url.protocol !== 'https:' ||
        !url.hostname.includes('.') ||
        isIP(url.hostname) ||
        url.hostname.endsWith('.local') ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        url.origin !== value
      )
        invalid(key);
    }
  }
  if (app === 'api-gateway' && values.GATEWAY_LOCAL_RATE_LIMIT_MULTIPLIER !== '1')
    invalid('GATEWAY_LOCAL_RATE_LIMIT_MULTIPLIER');
  if (app === 'identity-service') {
    trialEmails(values.IDENTITY_REGISTRATION_ALLOWLIST);
    if (
      values.IDENTITY_VERIFY_LINK_PATH !== '/verify-email' ||
      values.IDENTITY_RESET_LINK_PATH !== '/reset-password'
    )
      invalid('IDENTITY_LINK_PATHS');
  }
  if (
    app === 'finance-service' &&
    (values.MOMO_SANDBOX_MODE !== 'disabled' ||
      (values.MOMO_CHECKOUT_MODE || 'disabled') !== 'disabled' ||
      values.FINANCE_OUTBOX_ENABLED !== 'false' ||
      // Real-money payOS is a local/demo decision until the team approves it for deployments.
      (values.PAYOS_MODE || 'disabled') !== 'disabled')
  )
    invalid('FINANCE_FEATURE_FLAGS');
  if (app === 'automation-service') {
    const searchApiReady =
      values.PRICE_WATCH_PROVIDER === 'SEARCHAPI_GOOGLE_FLIGHTS' &&
      typeof values.SEARCHAPI_API_KEY === 'string' &&
      values.SEARCHAPI_API_KEY.trim();
    const travelpayoutsReady =
      values.PRICE_WATCH_PROVIDER === 'TRAVELPAYOUTS_CACHE' &&
      values.TRAVELPAYOUTS_TOKEN &&
      values.TRAVELPAYOUTS_VND_VERIFIED === 'true';
    if (values.PRICE_WATCH_WORKER_ENABLED === 'true' && !searchApiReady && !travelpayoutsReady)
      invalid('PRICE_WATCH_PROVIDER');
    if (
      !['true', 'false'].includes(String(values.PRICE_WATCH_WORKER_ENABLED)) ||
      values.AUTOMATION_FINANCE_NOTIFICATION_ENABLED !== 'false'
    )
      invalid('AUTOMATION_FEATURE_FLAGS');
    trialSmtpOptions({ get: (key) => values[key] });
    trialSmtpSender({ get: (key) => values[key] });
  }
}

export function trialSmtpOptions(config: Config) {
  const production =
    config.get('NODE_ENV') === 'production' || process.env.NODE_ENV === 'production';
  const host = String(config.get('SMTP_HOST') ?? '');
  const port = Number(config.get('SMTP_PORT'));
  const auth = production
    ? {
        user: String(config.get('SMTP_USER') ?? ''),
        pass: String(config.get('SMTP_PASSWORD') ?? ''),
      }
    : undefined;
  if (
    production &&
    (!host ||
      ![587, 465].includes(port) ||
      !auth?.user ||
      !auth.pass ||
      config.get('SMTP_REQUIRE_TLS') !== 'true')
  )
    invalid('SMTP_TLS_AUTH');
  return {
    host,
    port,
    secure: port === 465,
    requireTLS: production,
    auth,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const },
    connectionTimeout: production ? 10000 : 2000,
    socketTimeout: production ? 15000 : 5000,
  };
}

export function trialSmtpSender(config: Config): string {
  const production =
    config.get('NODE_ENV') === 'production' || process.env.NODE_ENV === 'production';
  if (!production) return String(config.get('SMTP_FROM') ?? 'Wolfari <no-reply@wolfari.local>');
  const from = String(config.get('SMTP_FROM') ?? '');
  if (!/^Wolfari <no-reply@[a-z0-9.-]+\.[a-z]{2,}>$/.test(from) || from.endsWith('.local>'))
    invalid('SMTP_FROM');
  return from;
}

/** Caddy overwrites X-Real-IP. Never trust Internet XFF or arbitrary peers. */
export function gatewayClientIp(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  values: Values = process.env,
): string {
  const peer = request.socket.remoteAddress ?? 'unknown';
  if (values.NODE_ENV !== 'production') return peer;
  const ip = request.headers['x-real-ip'];
  if (
    productionTransportBlocked(values) ||
    !['127.0.0.1', '::ffff:127.0.0.1'].includes(peer) ||
    typeof ip !== 'string' ||
    !isIP(ip)
  )
    throw new Error('Untrusted proxy');
  return ip;
}
