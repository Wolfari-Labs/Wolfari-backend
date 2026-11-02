import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NotificationEligibilityService,
  NotificationEligibilityValidationError,
} from './notification-eligibility.service';

const first = 'a1000000-0000-4000-8000-000000000001';
const second = 'b2000000-0000-4000-8000-000000000002';
const third = 'c3000000-0000-4000-8000-000000000003';
const id = (n: number) => '10000000-0000-4000-8000-' + n.toString().padStart(12, '0');
function setup() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn().mockResolvedValue(client);
  return {
    query,
    release,
    client,
    connect,
    service: new NotificationEligibilityService({ pool: { connect } } as never),
  };
}
afterEach(() => vi.useRealTimers());

describe('notification account eligibility', () => {
  it('returns exactly the requested unique identities in stable normalized order', async () => {
    const s = setup();
    s.query.mockResolvedValue({
      rows: [
        { id: second, email: 'private@example.invalid', status: 'ACTIVE', full_name: 'Private' },
        { id: third },
      ],
    });
    expect(await s.service.get([first.toUpperCase(), second, first, second.toUpperCase()])).toEqual(
      {
        recipients: [
          { user_id: first, eligible: false },
          { user_id: second, eligible: true },
        ],
      },
    );
    expect(s.query).toHaveBeenCalledTimes(1);
    const config = s.query.mock.calls[0]![0];
    expect(config.values).toEqual([[first, second]]);
    expect(config.text).toMatch(/^SELECT id FROM users WHERE id=ANY\(\$1::uuid\[\]\)/);
    expect(config.text).toContain("status='ACTIVE'");
    expect(config.text).toContain('deletion_requested_at IS NULL');
    expect(config.text).toContain('anonymized_at IS NULL');
    expect(config.text).not.toMatch(/email|full_name|avatar|password|SELECT\s+\*/i);
    expect(s.release.mock.calls).toEqual([[false]]);
  });

  it('reports all missing or ineligible identities explicitly as false', async () => {
    const s = setup();
    expect(await s.service.get([first, second])).toEqual({
      recipients: [
        { user_id: first, eligible: false },
        { user_id: second, eligible: false },
      ],
    });
  });

  it('accepts the maximum raw batch size in one read', async () => {
    const s = setup(),
      ids = Array.from({ length: 100 }, (_, n) => id(n + 1));
    const result = await s.service.get(ids);
    expect(result.recipients).toHaveLength(100);
    expect(result.recipients.map((item) => item.user_id)).toEqual(ids);
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string', first],
    ['object', { user_ids: [first] }],
    ['empty', []],
    ['too many distinct', Array.from({ length: 101 }, (_, n) => id(n + 1))],
    ['too many duplicates', Array(101).fill(first)],
    ['sparse', Array(1)],
    ['undefined item', [undefined]],
    ['number', [1]],
    ['object item', [{}]],
    ['nested array', [[first]]],
    ['leading space', [' ' + first]],
    ['trailing space', [first + ' ']],
    ['newline', [first + '\n']],
    ['invalid UUID', ['invalid']],
    ['UUID version zero', [first.replace('-4000-', '-0000-')]],
    ['UUID version nine', [first.replace('-4000-', '-9000-')]],
    ['invalid variant', [first.replace('-8000-', '-7000-')]],
    ['valid then invalid', [first, 'invalid']],
  ])('rejects %s before acquiring a database connection', async (_name, input) => {
    const s = setup();
    await expect(s.service.get(input)).rejects.toBeInstanceOf(
      NotificationEligibilityValidationError,
    );
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.query).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('accepts UUID version %i', async (version) => {
    const s = setup(),
      value = first.replace('-4000-', '-' + version + '000-');
    expect(await s.service.get([value])).toEqual({
      recipients: [{ user_id: value, eligible: false }],
    });
  });

  it('does not reuse mutable caller input while waiting for a connection', async () => {
    const s = setup();
    let connected!: (client: typeof s.client) => void;
    s.connect.mockReturnValue(
      new Promise((resolve) => {
        connected = resolve;
      }),
    );
    const input = [first],
      pending = s.service.get(input);
    input[0] = second;
    connected(s.client);
    expect(await pending).toEqual({ recipients: [{ user_id: first, eligible: false }] });
    expect(s.query.mock.calls[0]![0].values).toEqual([[first]]);
  });

  it('uses only the remaining local budget after pool acquisition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const s = setup();
    s.connect.mockImplementation(async () => {
      vi.setSystemTime(600);
      return s.client;
    });
    await s.service.get([first]);
    expect(s.query.mock.calls[0]![0].query_timeout).toBe(900);
    expect(s.release.mock.calls).toEqual([[false]]);
  });

  it('does not start SQL after pool acquisition consumes the local budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const s = setup();
    s.connect.mockImplementation(async () => {
      vi.setSystemTime(1500);
      return s.client;
    });
    await expect(s.service.get([first])).rejects.toThrow('NOTIFICATION_ELIGIBILITY_UNAVAILABLE');
    expect(s.query).not.toHaveBeenCalled();
    expect(s.release.mock.calls).toEqual([[true]]);
  });

  it('does not return an eligibility result that arrives after the local budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const s = setup();
    s.query.mockImplementation(async () => {
      vi.setSystemTime(1500);
      return { rows: [{ id: first }] };
    });
    await expect(s.service.get([first])).rejects.toThrow('NOTIFICATION_ELIGIBILITY_UNAVAILABLE');
    expect(s.release.mock.calls).toEqual([[true]]);
  });

  it('destroys a client rejected by its bounded response timer without leaving a timer running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const s = setup();
    s.query.mockImplementation(
      (config) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('Query read timeout')), config.query_timeout);
        }),
    );
    const result = expect(s.service.get([first])).rejects.toThrow('Query read timeout');
    await vi.advanceTimersByTimeAsync(1500);
    await result;
    expect(s.query.mock.calls[0]![0].query_timeout).toBe(1500);
    expect(s.release.mock.calls).toEqual([[true]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a database failure instead of returning false eligibility', async () => {
    const s = setup(),
      failure = new Error('database unavailable');
    s.query.mockRejectedValue(failure);
    await expect(s.service.get([first])).rejects.toBe(failure);
    expect(s.release.mock.calls).toEqual([[true]]);
  });

  it('propagates acquisition failure without releasing an unacquired client', async () => {
    const s = setup(),
      failure = new Error('pool exhausted');
    s.connect.mockRejectedValue(failure);
    await expect(s.service.get([first])).rejects.toBe(failure);
    expect(s.query).not.toHaveBeenCalled();
    expect(s.release).not.toHaveBeenCalled();
  });
});
