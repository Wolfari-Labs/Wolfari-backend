import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { IdentityController } from './identity.controller';
import type { IdentityService } from './identity.service';
import type { AvatarService } from './avatar.service';

describe('mobile local verification page', () => {
  it('renders a phone viewport and requires explicit confirmation without consuming a GET link', () => {
    let html = '';
    const confirmEmail = vi.fn();
    const controller = new IdentityController({ confirmEmail } as unknown as IdentityService, {} as AvatarService);
    controller.localPage('verify', 'a'.repeat(43), { setHeader: vi.fn(), end: (value: string) => { html = value; } } as unknown as ServerResponse,
      { headers: { 'x-service-secret': 'internal-only' } } as unknown as IncomingMessage);
    expect(confirmEmail).not.toHaveBeenCalled();
    expect(html).toContain('width=device-width, initial-scale=1');
    expect(html).toContain('name="referrer" content="no-referrer"');
    expect(html).toContain('href="wolfarimobile://verify-email"');
    expect(html).toContain("form.addEventListener('submit'");
    expect(html).not.toContain('http://127.0.0.1');
  });
  it('keeps unknown or directly accessed internal link pages unavailable', () => {
    const controller = new IdentityController({} as IdentityService, {} as AvatarService);
    expect(() => controller.localPage('verify', 'token', {} as ServerResponse, { headers: {} } as IncomingMessage)).toThrow();
    expect(() => controller.localPage('unknown', 'token', {} as ServerResponse, { headers: { 'x-service-secret': 'x' } } as unknown as IncomingMessage)).toThrow();
  });
});
