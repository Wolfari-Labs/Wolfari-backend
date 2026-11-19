import { describe, expect, it } from 'vitest';
import { joinCode } from './invitation-proxy';

describe('invitation join code input', () => {
  it('normalizes typed codes the same way Trip does', () => {
    expect(joinCode('k7pq-4m2x')).toBe('K7PQ4M2X');
    expect(joinCode('K7PQ 4M2X')).toBe('K7PQ4M2X');
    expect(joinCode('O1IL-ABCD')).toBe('0111ABCD');
  });
  it('rejects tokens, wrong lengths and excluded letters', () => {
    for (const bad of ['inv1_x', 'K7PQ4M2', 'K7PQ-4M2U', 'x'.repeat(40), 7, undefined])
      expect(joinCode(bad)).toBeUndefined();
  });
});
