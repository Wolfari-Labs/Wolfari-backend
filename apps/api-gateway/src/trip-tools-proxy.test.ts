import { describe, expect, it } from 'vitest';
import { tripToolsRoute } from './trip-tools-proxy';
const id = '10000000-0000-4000-8000-000000000001';
describe('Trip management/export/reminder routes', () => {
  it('matches only explicitly supported methods and paths', () => {
    for (const [method, path, kind] of [
      ['POST', `/trips/${id}/archive`, 'ARCHIVE'],
      ['POST', `/trips/${id}/ownership`, 'TRANSFER'],
      ['POST', `/trips/${id}/reopen`, 'REOPEN'],
      ['DELETE', `/trips/${id}`, 'DELETE'],
      ['GET', `/trips/${id}/plan.pdf`, 'PDF'],
      ['GET', `/trips/${id}/reminders`, 'LIST'],
      ['POST', `/trips/${id}/reminders`, 'CREATE'],
      ['DELETE', `/trips/${id}/reminders/${id}`, 'CANCEL'],
    ])
      expect(tripToolsRoute(method!, `/api/v1${path}`)?.kind).toBe(kind);
    expect(tripToolsRoute('PATCH', `/api/v1/trips/${id}/archive`)).toBeNull();
    expect(tripToolsRoute('GET', `/api/v1/trips/${id}/ownership`)).toBeNull();
    expect(tripToolsRoute('GET', `/api/v1/trips/${id}/reminders/${id}`)).toBeNull();
    expect(() => tripToolsRoute('POST', '/api/v1/trips/not-an-id/archive')).toThrow();
  });
});
