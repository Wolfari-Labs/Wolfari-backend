/**
 * payOS sends the payer's browser back to `returnUrl` (paid) or `cancelUrl` (cancelled) and appends
 * its own query string (`code`, `id`, `cancel`, `status`, `orderCode`). Wolfari points both at the
 * Gateway page `PAYOS_RETURN_PATH/<token>`, where the token is the client link encoded as base64url:
 * an app deep link (mobile) or a page of the Wolfari web app. payOS never has to accept a custom
 * scheme, and the page can hand the payer back to the client. Finance validates the URL before it
 * reaches payOS; the Gateway checks the token again (a web link must be on WEB_ORIGIN) before it
 * redirects, so the page can never be used as an open redirect to an arbitrary website.
 */
export const PAYOS_RETURN_PATH = '/api/v1/payments/payos/return/';

/** App links the return page may open: Expo Go (exp/exps) and the Wolfari build scheme. */
const APP_SCHEMES = new Set(['exp:', 'exps:', 'wolfarimobile:']);
const MAX_CLIENT_LINK = 300;
const MAX_RETURN_URL = 1000;

const parseClientLink = (value: unknown): URL | undefined => {
  if (typeof value !== 'string' || !value || value.length > MAX_CLIENT_LINK) return undefined;
  if (/[\u0000- \u007f"'<>\\`]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.username || url.password || url.hash ? undefined : url;
  } catch {
    return undefined;
  }
};

export function isPayosAppLink(value: unknown): value is string {
  const url = parseClientLink(value);
  return Boolean(url && APP_SCHEMES.has(url.protocol));
}

/**
 * A Wolfari web page (http/https, exact href, no query) the return page may open. Which origin is
 * allowed is deployment configuration, so the Gateway checks it with `payosReturnTarget`.
 */
export function isPayosWebLink(value: unknown): value is string {
  const url = parseClientLink(value);
  return Boolean(
    url && (url.protocol === 'https:' || url.protocol === 'http:') && !url.search && url.href === value,
  );
}

export function encodePayosReturnToken(link: string): string {
  if (!isPayosAppLink(link) && !isPayosWebLink(link)) throw new TypeError('Invalid client link');
  return Buffer.from(link, 'utf8').toString('base64url');
}

export function decodePayosReturnToken(token: unknown): string | undefined {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{4,400}$/.test(token)) return undefined;
  const value = Buffer.from(token, 'base64url').toString('utf8');
  // Reject non-canonical encodings so one client link has exactly one token.
  if (Buffer.from(value, 'utf8').toString('base64url') !== token) return undefined;
  return isPayosAppLink(value) || isPayosWebLink(value) ? value : undefined;
}

/** The link a return token may open: an app link, or a page on the configured web origin. */
export function payosReturnTarget(token: unknown, webOrigin: string | undefined) {
  const link = decodePayosReturnToken(token);
  if (!link || isPayosAppLink(link)) return link;
  try {
    return webOrigin && new URL(link).origin === new URL(webOrigin).origin ? link : undefined;
  } catch {
    return undefined;
  }
}

/** The token of a return URL's path, or undefined when it is not the Gateway return page. */
export function payosReturnToken(value: string): string | undefined {
  try {
    const { pathname } = new URL(value);
    return pathname.startsWith(PAYOS_RETURN_PATH)
      ? pathname.slice(PAYOS_RETURN_PATH.length)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A return URL a member may hand to payOS: the Gateway return page with a valid token, no
 * credentials, query or fragment. `https` is required in production; `http` is allowed for a
 * phone that reaches the demo Gateway on the local network.
 */
export function isPayosReturnUrl(value: unknown, production: boolean): value is string {
  if (typeof value !== 'string' || !value || value.length > MAX_RETURN_URL) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) return false;
  if (url.username || url.password || url.search || url.hash || url.href !== value) return false;
  if (!url.pathname.startsWith(PAYOS_RETURN_PATH)) return false;
  return decodePayosReturnToken(url.pathname.slice(PAYOS_RETURN_PATH.length)) !== undefined;
}
