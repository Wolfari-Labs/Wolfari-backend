import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityClient } from './identity-client';
const transport = vi.hoisted(() => ({ unary: vi.fn(), close: vi.fn() }));
vi.mock('@grpc/grpc-js', async (original) => ({
  ...(await original<typeof import('@grpc/grpc-js')>()),
  Client: class {
    makeUnaryRequest = transport.unary;
    close = transport.close;
  },
}));
const id = '00000000-0000-4000-8000-000000000001';
const correlation = '00000000-0000-4000-8000-000000000002';
const response = { recipients: [{ user_id: id, eligible: false }] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(10000);
  transport.unary.mockImplementation(
    (_path, _serialize, _deserialize, _request, _metadata, _options, callback) =>
      callback(null, response),
  );
});
afterEach(() => vi.restoreAllMocks());
describe('Identity notification eligibility client', () => {
  it('uses Automation credentials, correlation and the minimal response without treating false as failure', async () => {
    const client = new IdentityClient('unused:1', 'Automation', 'synthetic-secret');
    const request = { user_ids: [id] };
    try {
      await expect(client.getNotificationEligibility(request, correlation)).resolves.toEqual(
        response,
      );
      const [path, , , sent, metadata, options] = transport.unary.mock.calls[0]!;
      expect(path).toBe('/wolfari.identity.v1.IdentityService/GetNotificationEligibility');
      expect(sent).toEqual(request);
      expect(metadata.get('x-caller-service')).toEqual(['Automation']);
      expect(metadata.get('x-service-secret')).toEqual(['synthetic-secret']);
      expect(metadata.get('x-correlation-id')).toEqual([correlation]);
      expect(options.deadline).toBe(12000);
    } finally {
      client.close();
    }
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it.each([
    [10500, 10500],
    [15000, 12000],
    [9000, 9000],
  ])('keeps caller deadline %s within the two-second RPC maximum', async (deadline, expected) => {
    const client = new IdentityClient('unused:1', 'Automation', 'synthetic-secret');
    try {
      await client.getNotificationEligibility({ user_ids: [id] }, correlation, deadline);
      expect(transport.unary.mock.calls[0]![5].deadline).toBe(expected);
    } finally {
      client.close();
    }
  });
  it('propagates a dependency failure rather than returning ineligible or empty recipients', async () => {
    const failure = Object.assign(new Error('Identity unavailable'), { code: 14 });
    transport.unary.mockImplementation(
      (_path, _serialize, _deserialize, _request, _metadata, _options, callback) =>
        callback(failure),
    );
    const client = new IdentityClient('unused:1', 'Automation', 'synthetic-secret');
    try {
      await expect(client.getNotificationEligibility({ user_ids: [id] }, correlation)).rejects.toBe(
        failure,
      );
    } finally {
      client.close();
    }
  });
});
