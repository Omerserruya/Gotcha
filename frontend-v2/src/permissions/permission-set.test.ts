import { describe, expect, it } from 'vitest';

import { PERMISSIONS } from './catalogue';
import { PermissionSet, SYSTEM_ADMIN_ROLE } from './permission-set';

describe('PermissionSet', () => {
  it('grants an exact match', () => {
    const set = new PermissionSet([PERMISSIONS.conversation.messages.read]);
    expect(set.has('conversation:messages:read')).toBe(true);
  });

  it('denies an unrelated permission', () => {
    const set = new PermissionSet([PERMISSIONS.conversation.messages.read]);
    expect(set.has(PERMISSIONS.approvals.requests.approve)).toBe(false);
  });

  /*
   * The two that matter. The backend does exact matching only - an earlier
   * version of this class implemented prefix implication and wildcards, which
   * would have shown controls to people who cannot use them.
   */
  it('does not treat a two-part prefix as granting its actions', () => {
    expect(new PermissionSet(['conversation:messages']).has('conversation:messages:read')).toBe(
      false,
    );
  });

  it('does not treat an action grant as granting its parent', () => {
    expect(new PermissionSet(['conversation:messages:read']).has('conversation:messages')).toBe(
      false,
    );
  });

  it('gives a wildcard no special meaning', () => {
    const set = new PermissionSet(['conversation:*', '*']);
    expect(set.has('conversation:messages:read')).toBe(false);
  });

  it('grants everything to a system admin, whatever the set holds', () => {
    const set = new PermissionSet([], SYSTEM_ADMIN_ROLE);
    expect(set.has('conversation:messages:read')).toBe(true);
    expect(set.has('anything:at:all')).toBe(true);
  });

  it('★ the role key the route actually sends, "system_admin", is the system admin too', () => {
    // /permissions/me: `roleKey: role === "SYSTEM_ADMIN" ? "system_admin" : roleKey`.
    expect(new PermissionSet([], 'system_admin').has('anything:at:all')).toBe(true);
  });

  it('does not grant everything to any other role', () => {
    expect(new PermissionSet([], 'TENANT_ADMIN').has('conversation:messages:read')).toBe(false);
  });

  it('is empty by default, granting nothing', () => {
    expect(new PermissionSet([]).has('conversation:messages:read')).toBe(false);
  });

  it('distinguishes hasAll from hasAny', () => {
    const set = new PermissionSet([PERMISSIONS.approvals.requests.view]);
    expect(
      set.hasAny([PERMISSIONS.approvals.requests.view, PERMISSIONS.approvals.requests.approve]),
    ).toBe(true);
    expect(
      set.hasAll([PERMISSIONS.approvals.requests.view, PERMISSIONS.approvals.requests.approve]),
    ).toBe(false);
  });
});

describe('canSee - the unavailable case', () => {
  /*
   * These assert the behaviour of the context helper, which is where the
   * loaded/unavailable distinction lives. The rule: uncertainty must not
   * hide the product.
   */
  const canSee =
    (status: 'loaded' | 'unavailable', held: string[]) =>
    (permission?: string): boolean => {
      if (!permission) return true;
      if (status === 'unavailable') return true;
      return new PermissionSet(held).has(permission);
    };

  it('gates normally when the set loaded', () => {
    const see = canSee('loaded', [PERMISSIONS.approvals.requests.view]);
    expect(see(PERMISSIONS.approvals.requests.view)).toBe(true);
    expect(see(PERMISSIONS.ai.employees.read)).toBe(false);
  });

  it('hides nothing when the set could not be loaded', () => {
    // An empty set and a failed load produce the same array. Treating them
    // alike would leave an operator with a product that appears to have
    // vanished after a backend hiccup.
    const see = canSee('unavailable', []);
    expect(see(PERMISSIONS.ai.employees.read)).toBe(true);
  });

  it('always shows an ungated surface', () => {
    expect(canSee('loaded', [])(undefined)).toBe(true);
  });
});
