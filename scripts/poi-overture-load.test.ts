import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { overtureSnapshotVersion } from './poi/overture-load.mjs';

describe('Overture snapshot version', () => {
  it('fits poi_snapshots.version varchar(40)', () => {
    expect(overtureSnapshotVersion('2026-10-21.0', '20261118')).toBe('golden-overture-vn-2026-10-21.0-20261118');
    expect(overtureSnapshotVersion('2026-10-21.0', '20261118')).toHaveLength(40);
    expect(() => overtureSnapshotVersion('2026-10-21.10', '20261118')).toThrow();
  });
});
