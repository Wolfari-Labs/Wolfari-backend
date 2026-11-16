import type { ServerResponse } from 'node:http';
import { status } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { grpcFailure } from './trip-http';

function capture() {
  const result = { statusCode: 0, body: undefined as unknown };
  const response = {
    set statusCode(value: number) {
      result.statusCode = value;
    },
    setHeader() {},
    end(body: string) {
      result.body = JSON.parse(body);
    },
  } as unknown as ServerResponse;
  return { result, response };
}
const failure = (code: string, details: unknown, transport = status.FAILED_PRECONDITION) => ({
  code: transport,
  details: JSON.stringify({ code, details }),
});

describe('409 conflict sub-reason', () => {
  it('forwards a Finance STATE_CONFLICT reason as error.details.reason', () => {
    const { result, response } = capture();
    grpcFailure(
      response,
      failure('STATE_CONFLICT', { reason: 'INSUFFICIENT_AVAILABLE_BALANCE' }),
      true,
    );
    expect(result.statusCode).toBe(409);
    expect(result.body).toMatchObject({
      error: { code: 'STATE_CONFLICT', details: { reason: 'INSUFFICIENT_AVAILABLE_BALANCE' } },
    });
  });
  it.each([null, {}, { reason: 'not a code' }, { reason: 7 }, { secret: 'PRIVATE' }])(
    'keeps details null without a well-formed reason (%j)',
    (details) => {
      const { result, response } = capture();
      grpcFailure(response, failure('STATE_CONFLICT', details), true);
      expect(result.statusCode).toBe(409);
      expect(result.body).toMatchObject({ error: { code: 'STATE_CONFLICT', details: null } });
      expect(JSON.stringify(result.body)).not.toContain('PRIVATE');
    },
  );
  it('does not add a reason to other error codes', () => {
    const { result, response } = capture();
    grpcFailure(
      response,
      failure('VALIDATION_FAILED', { reason: 'FUND_NOT_OPEN' }, status.INVALID_ARGUMENT),
      true,
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'VALIDATION_FAILED', details: null } });
  });
});

describe('429 quota failures', () => {
  it('maps RESOURCE_EXHAUSTED to 429 with its limit reason', () => {
    const { result, response } = capture();
    grpcFailure(
      response,
      failure(
        'RESOURCE_EXHAUSTED',
        { reason: 'MEMBER_ACTIVE_WATCH_LIMIT' },
        status.RESOURCE_EXHAUSTED,
      ),
      true,
    );
    expect(result.statusCode).toBe(429);
    expect(result.body).toMatchObject({
      error: {
        code: 'RESOURCE_EXHAUSTED',
        details: { reason: 'MEMBER_ACTIVE_WATCH_LIMIT' },
        retryable: false,
      },
    });
  });
});
