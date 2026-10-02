import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { InvitationProxy } from '../apps/api-gateway/src/invitation-proxy';
import { IdentityProxy } from '../apps/api-gateway/src/identity-proxy';
import { fail } from '../apps/api-gateway/src/trip-proxy';
import { IdentityError } from '../apps/identity-service/src/identity.service';

const { status } = createRequire(new URL('../apps/api-gateway/package.json', import.meta.url))(
  '@grpc/grpc-js',
);

const { CorrelationMiddleware } = createRequire(
  new URL('../apps/api-gateway/package.json', import.meta.url),
)('@wolfari/common');

function withCorrelation(res: ServerResponse, work: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    new CorrelationMiddleware().use({ headers: {} }, res, () => {
      work().then(resolve, reject);
    });
  });
}

function response() {
  return { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
}

afterEach(() => vi.unstubAllEnvs());

describe('public error contract', () => {
  it.each([
    [status.UNAUTHENTICATED, 401, 'UNAUTHENTICATED', false],
    [status.UNAVAILABLE, 503, 'SERVICE_UNAVAILABLE', true],
    [status.DEADLINE_EXCEEDED, 503, 'SERVICE_UNAVAILABLE', true],
  ])(
    'maps Identity status %s without retrying invalid sessions',
    async (code, http, error, retryable) => {
      vi.stubEnv('GATEWAY_TRIP_SECRET', 's'.repeat(32));
      vi.stubEnv('TRIP_GRPC_TARGET', '127.0.0.1:3202');
      vi.stubEnv('NODE_ENV', 'test');
      const proxy = new InvitationProxy(vi.fn().mockRejectedValue({ code }));
      const res = response();
      try {
        await withCorrelation(res as unknown as ServerResponse, () =>
          proxy.handle(
            {
              method: 'POST',
              url: '/api/v1/invitations/accept',
              headers: { authorization: 'Bearer invalid' },
            } as IncomingMessage,
            res as unknown as ServerResponse,
          ),
        );
        expect(res.statusCode).toBe(http);
        const payload = JSON.parse(res.end.mock.calls[0]![0]);
        expect(payload.error).toMatchObject({ code: error, retryable, details: null });
        expect(payload.error.message).toBe(
          http === 503
            ? 'Dịch vụ tạm thời không khả dụng; thử lại thao tác với cùng khóa chống lặp'
            : 'Không thể hoàn tất yêu cầu',
        );
      } finally {
        proxy.close();
      }
    },
  );

  it('keeps safe Vietnamese messages without changing machine-readable codes', () => {
    const res = response();
    fail(res as unknown as ServerResponse, 400, 'VALIDATION_FAILED');
    expect(JSON.parse(res.end.mock.calls[0]![0]).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Không thể hoàn tất yêu cầu',
      retryable: false,
    });
    expect(new IdentityError('UNAUTHENTICATED', 401).publicMessage).toBe(
      'Không thể hoàn tất yêu cầu',
    );
  });

  it('returns a Vietnamese CSRF error from the Identity Gateway without a cookie', async () => {
    vi.stubEnv('IDENTITY_HTTP_URL', 'http://127.0.0.1:3101');
    vi.stubEnv('IDENTITY_GRPC_TARGET', '127.0.0.1:3201');
    vi.stubEnv('GATEWAY_IDENTITY_SECRET', 's'.repeat(32));
    vi.stubEnv('GATEWAY_CSRF_KEY', 'c'.repeat(32));
    vi.stubEnv('WEB_ORIGIN', 'http://127.0.0.1:3000');
    vi.stubEnv('NODE_ENV', 'test');
    const proxy = new IdentityProxy();
    const res = response();
    try {
      await proxy.handle(
        { method: 'GET', url: '/api/v1/auth/csrf', headers: {} } as IncomingMessage,
        res as unknown as ServerResponse,
      );
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.end.mock.calls[0]![0]).error).toMatchObject({
        code: 'UNAUTHENTICATED',
        message: 'Không thể hoàn tất yêu cầu',
        retryable: false,
      });
    } finally {
      proxy.close();
    }
  });
});
