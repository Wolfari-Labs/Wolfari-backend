import { describe, expect, it } from 'vitest';
import {
  PAYOS_RETURN_PATH,
  decodePayosReturnToken,
  encodePayosReturnToken,
  isPayosAppLink,
  isPayosReturnUrl,
  isPayosWebLink,
  payosReturnTarget,
  payosReturnToken,
} from './payos-return';

const app = 'exp://192.168.1.5:8081/--/payment-return';
const token = encodePayosReturnToken(app);

describe('payOS return page links', () => {
  it('round-trips Expo Go and Wolfari app links', () => {
    expect(decodePayosReturnToken(token)).toBe(app);
    const built = encodePayosReturnToken('wolfarimobile://payment-return');
    expect(decodePayosReturnToken(built)).toBe('wolfarimobile://payment-return');
  });

  it('never decodes to an unsafe link', () => {
    for (const link of [
      'https://evil.example/x',
      'http://evil.example',
      'javascript:alert(1)',
      'exp://user:pass@host/--/x',
      'exp://host/--/x#frag',
      'exp://host/--/"x"',
    ])
      expect(isPayosAppLink(link)).toBe(false);
    for (const link of [
      'javascript:alert(1)',
      'https://u:p@web.example/x',
      'https://web.example/x?next=1',
      'https://web.example/x#f',
      'http://web.example', // not the exact href (missing "/")
      'ftp://web.example/x',
      'exp://host/--/x',
    ])
      expect(isPayosWebLink(link)).toBe(false);
    expect(decodePayosReturnToken(Buffer.from('javascript:alert(1)').toString('base64url'))).toBe(
      undefined,
    );
    expect(decodePayosReturnToken(`${token}=`)).toBe(undefined);
    expect(decodePayosReturnToken('a')).toBe(undefined);
  });

  it('opens a web page only on the configured web origin', () => {
    const page = 'http://localhost:5273/trips/t1/fund';
    const web = encodePayosReturnToken(page);
    expect(decodePayosReturnToken(web)).toBe(page);
    expect(payosReturnTarget(web, 'http://localhost:5273')).toBe(page);
    expect(payosReturnTarget(web, 'http://localhost:5273/')).toBe(page);
    expect(payosReturnTarget(web, 'https://localhost:5273')).toBe(undefined);
    expect(payosReturnTarget(web, 'http://localhost:5274')).toBe(undefined);
    expect(payosReturnTarget(web, '')).toBe(undefined);
    expect(payosReturnTarget(web, undefined)).toBe(undefined);
    const evil = encodePayosReturnToken('https://evil.example/x');
    expect(payosReturnTarget(evil, 'http://localhost:5273')).toBe(undefined);
    // App links do not depend on the web origin.
    expect(payosReturnTarget(token, undefined)).toBe(app);
    expect(payosReturnToken(`http://gw${PAYOS_RETURN_PATH}${web}`)).toBe(web);
    expect(payosReturnToken('http://gw/other/x')).toBe(undefined);
    expect(payosReturnToken('not a url')).toBe(undefined);
  });

  it('accepts only the Gateway return page as a payOS return URL', () => {
    const url = `http://192.168.1.5:3100${PAYOS_RETURN_PATH}${token}`;
    expect(isPayosReturnUrl(url, false)).toBe(true);
    expect(isPayosReturnUrl(url, true)).toBe(false);
    expect(isPayosReturnUrl(url.replace('http:', 'https:'), true)).toBe(true);
    expect(isPayosReturnUrl(`${url}?x=1`, false)).toBe(false);
    expect(isPayosReturnUrl(`http://192.168.1.5:3100/other/${token}`, false)).toBe(false);
    expect(isPayosReturnUrl(`http://u:p@192.168.1.5:3100${PAYOS_RETURN_PATH}${token}`, false)).toBe(
      false,
    );
    expect(isPayosReturnUrl(`ftp://host${PAYOS_RETURN_PATH}${token}`, false)).toBe(false);
  });
});
