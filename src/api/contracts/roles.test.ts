import { describe, expect, it } from 'vitest';

import {
  allowsEverything,
  grantSchema,
  isAddition,
  isEditable,
  roleListSchema,
  roleSchema,
} from './roles';

/** The rulings on screen 12b, as assertions. */

describe('a role is a set of feature keys and nothing else', () => {
  it('flattens the Prisma aggregate so no component sees _count', () => {
    const roles = roleListSchema.parse({
      data: [
        {
          id: 'r1',
          name: 'Admin',
          description: 'Everything',
          isSystem: true,
          builtinKey: 'admin',
          features: [{ feature: 'billing.refund' }, { feature: 'conversation.read' }],
          _count: { assignments: 3 },
        },
      ],
    });
    expect(roles[0]!.memberCount).toBe(3);
    expect(roles[0]!.features).toEqual(['billing.refund', 'conversation.read']);
    expect(roles[0]).not.toHaveProperty('_count');
  });

  it('carries no amount, because no column holds one', () => {
    /*
     * The design describes roles as allowing "refunds up to ₪1,000" and "up
     * to ₪500". `TenantRoleFeature` is (roleId, feature) — a composite key
     * with no other columns. A role grants `billing.refund` or it does not.
     *
     * A limit on this shape would be a number a reader acts on that no code
     * path reads, which is the quiet-hours failure.
     */
    const surface = Object.keys(
      roleSchema.parse({ id: 'r1', name: 'Agent', features: ['billing.refund'] }),
    );
    expect(surface.filter((k) => /limit|cap|max|amount|ceiling/i.test(k))).toEqual([]);
  });

  it('counts an empty role as allowing nothing rather than failing', () => {
    expect(roleSchema.parse({ id: 'r1', name: 'New role' }).features).toEqual([]);
  });
});

describe('built-in roles can be copied, never changed', () => {
  it('refuses to call a system role editable', () => {
    // The route rejects an edit, so an edit control would be a button the
    // server turns down.
    expect(isEditable(roleSchema.parse({ id: 'r1', name: 'Admin', isSystem: true }))).toBe(false);
  });

  it('allows editing a role the tenant made', () => {
    expect(isEditable(roleSchema.parse({ id: 'r2', name: 'Refunds', isSystem: false }))).toBe(true);
  });
});

describe('a per-person grant can also take something away', () => {
  it('reads granted:true as an addition', () => {
    expect(isAddition(grantSchema.parse({ feature: 'billing.refund', granted: true }))).toBe(true);
  });

  it('reads granted:false as a removal, which the design never mentions', () => {
    /*
     * `UserFeatureGrant.granted` false is an explicit REVOKE — it overrides a
     * permission the person's role grants. The design's 12e is "add a
     * permission to one person" and describes only additions.
     *
     * A removal is the more dangerous of the two: someone can be quietly
     * missing something their role says they have, and a screen that surfaces
     * only "extras" reports half the exceptions.
     */
    const revoke = grantSchema.parse({ feature: 'billing.refund', granted: false });
    expect(isAddition(revoke)).toBe(false);
    expect(revoke.granted).toBe(false);
  });

  it('carries no expiry and no limit, because neither column exists', () => {
    // The design gives a grant an end date and a limit. `UserFeatureGrant` is
    // feature · granted · reason · updatedBy. A date picker that saves
    // nothing is the reassuring-direction failure.
    const surface = Object.keys(grantSchema.parse({ feature: 'x', granted: true }));
    expect(surface.filter((k) => /expir|until|limit|cap|amount/i.test(k))).toEqual([]);
  });
});

describe('a wildcard role says what it means, never how many rows it has', () => {
  it('reports a role holding * as allowing everything', () => {
    /*
     * Owner holds exactly ONE feature row — `*` — and
     * `permissions.ts:37` is `if (key === "*") return true`. Counting it
     * rendered "Allows one thing" directly beneath "Full access to
     * everything", and a reader comparing Owner's 1 to Admin's 58 concludes
     * Owner is the NARROWER role.
     *
     * Arithmetically right about the row, wrong about the world. The row was
     * counted without being read.
     */
    const owner = roleSchema.parse({ id: 'r1', name: 'Owner', features: ['*'] });
    expect(allowsEverything(owner)).toBe(true);
    expect(owner.features).toHaveLength(1);
  });

  it('does not mistake a long permission list for a wildcard', () => {
    const admin = roleSchema.parse({
      id: 'r2',
      name: 'Admin',
      features: ['billing.refund', 'conversation.read', 'permissions.manage'],
    });
    expect(allowsEverything(admin)).toBe(false);
  });

  it('reports an empty role as allowing nothing, not everything', () => {
    expect(allowsEverything(roleSchema.parse({ id: 'r3', name: 'New' }))).toBe(false);
  });
});
