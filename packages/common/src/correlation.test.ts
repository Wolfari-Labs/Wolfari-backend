import { describe, expect, it } from 'vitest';
import { currentCorrelationId, normalizeCorrelationId } from './correlation';

describe('correlation ID foundation', () => {
  it('keeps UUIDs and replaces non-UUID incoming IDs', () => {
    const uuid = 'ab814514-965c-443b-ae80-257a6776d89d';
    expect(normalizeCorrelationId(uuid)).toBe(uuid);
    expect(normalizeCorrelationId('request-123')).not.toBe('request-123');
    expect(normalizeCorrelationId('bad\nheader')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('has no ambient request ID outside a request', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });
});
