import { describe, expect, it, vi } from 'vitest';
import { getExpoReceipt, sendExpoPush } from './expo-push.provider';

describe('Expo push HTTP contract', () => {
  it('sends minimal lock-screen content and records acceptance separately from delivery', async () => {
    const request = vi.fn(async () => Response.json({ data: { status: 'ok', id: 'ticket-id' } }));
    expect(
      await sendExpoPush(
        'ExponentPushToken[fixture]',
        { trip_id: 'trip', notification_id: 'notice' },
        'private-test-token',
        request,
      ),
    ).toEqual({ reference: 'ticket-id' });
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    const payload = JSON.parse(String(options.body));
    expect(payload.title).toBe('Wolfari');
    expect(payload.body).not.toContain('private-test-token');
    expect(payload.data.notification_id).toBe('notice');
    expect(options.redirect).toBe('error');
  });
  it('does not contact a provider for unsupported tokens', async () => {
    const request = vi.fn();
    expect(await sendExpoPush('https://untrusted.invalid', {}, 'test', request)).toMatchObject({
      permanent: true,
      invalidToken: true,
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('retains a pending ticket until Expo supplies a receipt', async () => {
    expect(await getExpoReceipt('ticket', 'test', async () => Response.json({ data: {} }))).toEqual(
      { pending: true },
    );
    expect(
      await getExpoReceipt('ticket', 'test', async () =>
        Response.json({ data: { ticket: { status: 'ok' } } }),
      ),
    ).toEqual({});
  });
  it('recognizes revoked devices and permanent credential failures', async () => {
    expect(
      await getExpoReceipt('ticket', 'test', async () =>
        Response.json({
          data: { ticket: { status: 'error', details: { error: 'DeviceNotRegistered' } } },
        }),
      ),
    ).toMatchObject({ invalidToken: true, permanent: true });
    expect(
      await sendExpoPush(
        'ExpoPushToken[fixture]',
        {},
        'test',
        async () => new Response('', { status: 401 }),
      ),
    ).toMatchObject({ error: 'UNAUTHORIZED', permanent: true });
  });
  it('keeps outages/rate limiting retryable and rejects oversized provider bodies', async () => {
    for (const code of [429, 503])
      expect(
        await sendExpoPush(
          'ExpoPushToken[fixture]',
          {},
          'test',
          async () => new Response('', { status: code }),
        ),
      ).toMatchObject({ permanent: false });
    await expect(
      sendExpoPush(
        'ExpoPushToken[fixture]',
        {},
        'test',
        async () => new Response('x'.repeat(65537)),
      ),
    ).rejects.toThrow('too large');
  });
});
