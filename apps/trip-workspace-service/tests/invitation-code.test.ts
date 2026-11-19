import { describe, expect, it } from 'vitest';
import {
  formatJoinCode,
  joinCodeHash,
  mintJoinCode,
  normalizeJoinCode,
} from '../src/invitation-crypto';
import { budgetAmount } from '../src/trip.service';

describe('invitation join codes', () => {
  it('mints 8 unambiguous Crockford characters', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = mintJoinCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(495);
  });
  it('accepts what people type and rejects everything else', () => {
    expect(normalizeJoinCode('k7pq-4m2x')).toBe('K7PQ4M2X');
    expect(normalizeJoinCode(' K7PQ 4M2X ')).toBe('K7PQ4M2X');
    // Letters that look like digits are read as the digit.
    expect(normalizeJoinCode('O1IL-ABCD')).toBe('0111ABCD');
    for (const bad of ['K7PQ4M2', 'K7PQ4M2XY', 'K7PQ-4M2U', 'inv1_abc', '', 42, null])
      expect(normalizeJoinCode(bad)).toBeUndefined();
  });
  it('formats for display and hashes the normalized form only', () => {
    expect(formatJoinCode('K7PQ4M2X')).toBe('K7PQ-4M2X');
    expect(joinCodeHash('K7PQ4M2X')).toMatch(/^[a-f0-9]{64}$/);
    expect(joinCodeHash('K7PQ4M2X')).toBe(joinCodeHash(normalizeJoinCode('k7pq-4m2x')!));
    expect(joinCodeHash('K7PQ4M2X')).not.toBe(joinCodeHash('K7PQ4M2Y'));
  });
});

describe('trip budget', () => {
  it('accepts positive VND integers up to 12 digits and null to clear', () => {
    expect(budgetAmount('15000000')).toBe('15000000');
    expect(budgetAmount('999999999999')).toBe('999999999999');
    expect(budgetAmount(null)).toBeNull();
    for (const bad of ['0', '0100', '1000000000000', '1.5', '-1', 15000000, ''])
      expect(() => budgetAmount(bad)).toThrow();
  });
});
