import { describe, expect, it } from 'vitest';
import { planItemRoute } from './plan-items-proxy';
const root = '/api/v1/trips/10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';
describe('Plan collection Gateway routes', () => {
  it('maps supported actions and rejects methods that would change their meaning', () => {
    expect(planItemRoute('POST', root + '/dress-codes')).toMatchObject({
      entity_type: 'DRESS_CODE',
      action: 'CREATE',
    });
    expect(planItemRoute('PATCH', root + '/packing-items/' + id + '/completion')).toMatchObject({
      entity_type: 'PACKING_ITEM',
      action: 'COMPLETE',
      item_id: id,
    });
    expect(planItemRoute('DELETE', root + '/packing-items/' + id)).toMatchObject({
      action: 'DELETE',
    });
    expect(planItemRoute('POST', root + '/dress-codes/' + id + '/completion')).toBeNull();
    expect(planItemRoute('PATCH', root + '/packing-items')).toBeNull();
    expect(() => planItemRoute('POST', '/api/v1/trips/invalid/packing-items')).toThrow();
  });
});
