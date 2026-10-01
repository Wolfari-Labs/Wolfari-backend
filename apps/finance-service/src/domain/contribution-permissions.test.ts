import { describe, expect, it } from 'vitest';
import {
  assertContributionActionAllowed,
  ContributionPermissionDeniedError,
  type ContributionAction,
  type ContributionPermissionContext,
} from './contribution-permissions';

const member = '00000000-0000-4000-8000-000000000001';
const holder = '00000000-0000-4000-8000-000000000002';
const owner = '00000000-0000-4000-8000-000000000003';
const otherMember = '00000000-0000-4000-8000-000000000004';
const context: ContributionPermissionContext = {
  actorUserId: member,
  memberUserId: member,
  holderUserId: holder,
  activeMemberUserIds: new Set([member, holder, owner, otherMember]),
};
const selfActions = ['VIEW_PAYMENT_INSTRUCTION', 'REPORT_TRANSFER'] as const;
const holderActions = ['CONFIRM_RECEIVED', 'REJECT_TRANSFER'] as const;
const allActions = [...selfActions, ...holderActions];

describe('contribution actor permissions', () => {
  it.each(selfActions)('allows the active contributor to %s', (action) => {
    expect(() => assertContributionActionAllowed(action, context)).not.toThrow();
  });

  it.each(selfActions)(
    'does not let another member, Owner or Holder perform %s for the contributor',
    (action) => {
      for (const actorUserId of [otherMember, owner, holder]) {
        expect(() => assertContributionActionAllowed(action, { ...context, actorUserId })).toThrow(
          ContributionPermissionDeniedError,
        );
      }
    },
  );

  it.each(holderActions)('allows the active Holder to %s', (action) => {
    expect(() =>
      assertContributionActionAllowed(action, { ...context, actorUserId: holder }),
    ).not.toThrow();
  });

  it.each(holderActions)('does not let the contributor, another member or Owner %s', (action) => {
    for (const actorUserId of [member, otherMember, owner]) {
      expect(() => assertContributionActionAllowed(action, { ...context, actorUserId })).toThrow(
        ContributionPermissionDeniedError,
      );
    }
  });

  it.each(allActions)('allows %s when the Holder is also the contributor', (action) => {
    expect(() =>
      assertContributionActionAllowed(action, {
        ...context,
        actorUserId: holder,
        memberUserId: holder,
      }),
    ).not.toThrow();
  });

  it.each(allActions)('rejects %s when the matching actor is no longer active', (action) => {
    expect(() =>
      assertContributionActionAllowed(action, {
        ...context,
        actorUserId: holder,
        memberUserId: holder,
        activeMemberUserIds: new Set([otherMember, owner]),
      }),
    ).toThrow(ContributionPermissionDeniedError);
  });

  it('allows an Owner who is also Holder to confirm, but still not to report for another person', () => {
    const ownerHolderContext = { ...context, actorUserId: owner, holderUserId: owner };
    expect(() =>
      assertContributionActionAllowed('CONFIRM_RECEIVED', ownerHolderContext),
    ).not.toThrow();
    expect(() => assertContributionActionAllowed('REPORT_TRANSFER', ownerHolderContext)).toThrow(
      ContributionPermissionDeniedError,
    );
  });

  it('allows an Owner to report their own contribution without granting receipt confirmation', () => {
    const ownerContributionContext = { ...context, actorUserId: owner, memberUserId: owner };
    expect(() =>
      assertContributionActionAllowed('REPORT_TRANSFER', ownerContributionContext),
    ).not.toThrow();
    expect(() =>
      assertContributionActionAllowed('CONFIRM_RECEIVED', ownerContributionContext),
    ).toThrow(ContributionPermissionDeniedError);
  });

  it('rejects unsupported actions rather than treating them as a Holder action', () => {
    expect(() =>
      assertContributionActionAllowed('UNKNOWN' as ContributionAction, {
        ...context,
        actorUserId: holder,
      }),
    ).toThrow(TypeError);
  });

  it('does not change membership or actor context on success or denial', () => {
    const frozenContext = Object.freeze({
      ...context,
      activeMemberUserIds: new Set(context.activeMemberUserIds),
    });
    assertContributionActionAllowed('REPORT_TRANSFER', frozenContext);
    expect(() => assertContributionActionAllowed('CONFIRM_RECEIVED', frozenContext)).toThrow(
      ContributionPermissionDeniedError,
    );
    expect(frozenContext).toEqual(context);
  });
});
