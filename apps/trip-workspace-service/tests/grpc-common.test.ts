import { afterEach, describe, expect, it, vi } from 'vitest';
import { tripRequestDeadline } from '../src/grpc-common';

afterEach(() => vi.restoreAllMocks());

describe('shared Trip request deadline', () => {
  it('caps requests without an incoming deadline at the existing 1800ms budget', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10000);
    expect(tripRequestDeadline()).toBe(11800);
    expect(tripRequestDeadline({ getDeadline: () => Infinity })).toBe(11800);
  });

  it.each([11000, new Date(11000)])('reserves 100ms from incoming deadline %s', (deadline) => {
    vi.spyOn(Date, 'now').mockReturnValue(10000);
    expect(tripRequestDeadline({ getDeadline: () => deadline })).toBe(10900);
  });

  it('does not extend an expired request', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10000);
    expect(tripRequestDeadline({ getDeadline: () => 9000 })).toBe(8900);
  });
});
