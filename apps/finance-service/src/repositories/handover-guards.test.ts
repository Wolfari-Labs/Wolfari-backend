import { describe, expect, it, vi } from 'vitest';
import { assertNoHandover } from './handover-guards';

describe('handover guards under the Fund lock', () => {
  it('blocks new spending after acceptance and closure during either active phase', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'active' }] });
    await expect(assertNoHandover({ query } as never, 'fund', true)).rejects.toThrow(
      'STATE_CONFLICT',
    );
    expect(query.mock.calls[0]![1]).toEqual(['fund', ['ACCEPTED']]);
    await expect(assertNoHandover({ query } as never, 'fund')).rejects.toThrow('STATE_CONFLICT');
    expect(query.mock.calls[1]![1]).toEqual(['fund', ['NOMINATED', 'ACCEPTED']]);
  });
  it('allows an inactive handover and propagates unavailable database errors', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(assertNoHandover({ query } as never, 'fund')).resolves.toBeUndefined();
    query.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(assertNoHandover({ query } as never, 'fund')).rejects.toThrow(
      'database unavailable',
    );
  });
});
