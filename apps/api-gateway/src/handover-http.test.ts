import { describe, it, expect } from 'vitest';
import { handoverRoute, projectHandover } from './handover-http';
describe('Holder handover HTTP contract', () => {
  it('recognizes only explicit workflow endpoints', () => {
    expect(handoverRoute('/api/v1/funds/f/holder-handovers')).toEqual({
      kind: 'collection',
      fundId: 'f',
    });
    expect(handoverRoute('/api/v1/holder-handovers/h/refresh-snapshot')).toEqual({
      kind: 'item',
      handoverId: 'h',
      action: 'refresh-snapshot',
    });
    expect(handoverRoute('/api/v1/holder-handovers/h/transfer')).toBeUndefined();
  });
  it('fails closed for invalid response state', () =>
    expect(() => projectHandover({ status: 'DONE' })).toThrow());
});
