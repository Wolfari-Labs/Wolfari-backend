import { describe, expect, it } from 'vitest';
import { assertCalendarDate, assertMoney, assertSpecifiedEnum, assertUuid } from './validation';

describe('contract scalar validation', () => {
  it('keeps money as a precise decimal string', () => {
    expect(() => assertMoney('9007199254740993')).not.toThrow();
    expect(() => assertMoney('9223372036854775807')).not.toThrow();
    expect(() => assertMoney('9223372036854775808')).toThrow();
    expect(() => assertMoney('1.5')).toThrow();
  });

  it('validates UUID, calendar date and required enum semantics', () => {
    expect(() => assertUuid('00000000-0000-4000-8000-000000000001')).not.toThrow();
    expect(() => assertUuid('request-123')).toThrow();
    expect(() => assertCalendarDate('2024-02-29')).not.toThrow();
    expect(() => assertCalendarDate('2023-02-29')).toThrow();
    expect(() => assertSpecifiedEnum(1)).not.toThrow();
    expect(() => assertSpecifiedEnum(0)).toThrow(/UNSPECIFIED/);
  });
});
