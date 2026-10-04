import { describe, expect, it } from 'vitest';
import { accessRevision, accessUuid, maximumRevision } from '../src/trip-access.domain';
import { MAX_INT32, positiveRevision, uuid } from '../src/trip-common';
import { planPolicyRequestHash } from '../src/trip-plan-access.service';

describe('shared Trip and Plan access primitives', () => {
  it('keeps the existing access exports backed by the canonical validators', () => {
    expect(accessUuid).toBe(uuid);
    expect(accessRevision).toBe(positiveRevision);
    expect(maximumRevision).toBe(MAX_INT32);
  });

  it('preserves the pre-cleanup request hash for existing policy receipts', () => {
    expect(
      planPolicyRequestHash({
        actorUserId: '10000000-0000-4000-8000-000000000001',
        tripId: '30000000-0000-4000-8000-000000000001',
        policy: 'SELECTED_MEMBERS',
        editorMemberIds: ['40000000-0000-4000-8000-000000000002'],
        expectedMembershipRevision: 3,
      }),
    ).toBe('b7e1327d3ad7d7df8fde37bab07c9a273004978804af12b3609d83c40f1ad270');
  });
});
