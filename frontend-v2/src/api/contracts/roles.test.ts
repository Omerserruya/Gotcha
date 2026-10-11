import { describe, expect, it } from 'vitest';

import {
  allowsEverything,
  grantSchema,
  isAddition,
  isEditable,
  isMergedAdmin,
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
     * to ₪500". `TenantRoleFeature` is (roleId, feature) - a composite key
     * with no other columns. A role grants `billing.refund` or it does not.
     *
     * A limit on this shape would be a number a reader acts on that no code
     * path reads, which is the quiet-hours failure.
     */
    const surface = Object.keys(
      roleSchema.parse({ id: 'r1', name: 'Agent', features: ['billing.refund'] }),
    );
    expect(surface.filter((k) => /limit|cap|max|amount/i.test(k))).toEqual([]);
    // `ceiling` (auth 30d610da) is a list of permission KEYS a role can never
    // hold - never a number, so it cannot be read as an amount.
    expect(roleSchema.parse({ id: 'r1', name: 'Agent', ceiling: ['a:b:c'] }).ceiling).toEqual([
      'a:b:c',
    ]);
  });

  it('counts an empty role as allowing nothing rather than failing', () => {
    expect(roleSchema.parse({ id: 'r1', name: 'New role' }).features).toEqual([]);
  });
});

describe('a built-in role is edited only when the server says so (auth 30d610da)', () => {
  it('unsaid (a backend before it): a built-in role stays fixed, as it was', () => {
    // The route rejected an edit then, so an edit control would be a button
    // the server turns down.
    expect(isEditable(roleSchema.parse({ id: 'r1', name: 'Owner', isSystem: true }))).toBe(false);
  });

  it('said: a built-in role with `editable: true` is editable, and one with false is not', () => {
    const owner = { id: 'o', name: 'Owner', isSystem: true, builtinKey: 'owner' };
    expect(isEditable(roleSchema.parse({ ...owner, editable: true }))).toBe(true);
    expect(isEditable(roleSchema.parse({ ...owner, editable: false }))).toBe(false);
  });

  it('★ garbage in `editable` costs only that field - a built-in role stays fixed', () => {
    expect(
      isEditable(roleSchema.parse({ id: 'o', name: 'Owner', isSystem: true, editable: 'yes' })),
    ).toBe(false);
    expect(isEditable(roleSchema.parse({ id: 'c', name: 'Desk', editable: 1 }))).toBe(true);
  });

  it('★ the merged Admin is never editable, whatever arrives (409 ROLE_MERGED)', () => {
    const admin = roleSchema.parse({
      id: 'a',
      name: 'Admin',
      isSystem: true,
      builtinKey: 'admin',
      editable: true,
    });
    expect(isEditable(admin)).toBe(false);
    expect(isMergedAdmin(admin)).toBe(true);
    expect(isMergedAdmin(roleSchema.parse({ id: 'o', name: 'Owner', builtinKey: 'owner' }))).toBe(
      false,
    );
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
     * `UserFeatureGrant.granted` false is an explicit REVOKE - it overrides a
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

  it('carries its end (53a5079a) - and still no limit, because that column does not exist', () => {
    // The design gives a grant an end date and a limit. The end landed with
    // `expiresAt` + `active`; a limit is still nowhere, and a field for one
    // would save nothing.
    const surface = Object.keys(grantSchema.parse({ feature: 'x', granted: true }));
    expect(surface.filter((k) => /expir/i.test(k))).toEqual(['expiresAt']);
    expect(surface.filter((k) => /until|limit|cap|amount/i.test(k))).toEqual([]);
  });
});

describe('a wildcard role says what it means, never how many rows it has', () => {
  it('reports a role holding * as allowing everything', () => {
    /*
     * Owner holds exactly ONE feature row - `*` - and
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

describe('★★ GET /roles (auth 30d610da `roleView`): ceiling, floor, editable, customized, defaults', () => {
  /** The row `roleView` answers: a Prisma role spread, `features` as `{ feature }` objects. */
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'dm',
    name: 'Department Manager',
    description: null,
    isSystem: true,
    builtinKey: 'department_manager',
    features: [
      { id: 'f1', roleId: 'dm', feature: 'conversation:messages:*' },
      { id: 'f2', roleId: 'dm', feature: 'crm:contacts:read' },
    ],
    _count: { assignments: 2 },
    ...over,
  });

  it('present: every field read, the features flattened, patterns kept as they are', () => {
    const [dm] = roleListSchema.parse({
      data: [
        row({
          editable: true,
          customized: true,
          ceiling: ['settings:roles:manage', 'settings:workspace:update'],
          floor: [],
          defaults: ['conversation:messages:*', 'crm:contacts:read'],
        }),
      ],
    });
    expect(dm).toMatchObject({
      editable: true,
      customized: true,
      ceiling: ['settings:roles:manage', 'settings:workspace:update'],
      floor: [],
      defaults: ['conversation:messages:*', 'crm:contacts:read'],
      features: ['conversation:messages:*', 'crm:contacts:read'],
      memberCount: 2,
    });
  });

  it('the Owner row carries its floor', () => {
    const [owner] = roleListSchema.parse({
      data: [
        row({
          id: 'o',
          builtinKey: 'owner',
          editable: true,
          floor: ['settings:roles:manage', 'settings:members:manage', 'settings:billing:manage'],
        }),
      ],
    });
    expect(owner!.floor).toEqual([
      'settings:roles:manage',
      'settings:members:manage',
      'settings:billing:manage',
    ]);
  });

  it('absent (an older backend): built-in fixed, custom editable, nothing limited, no defaults', () => {
    const [dm, custom] = roleListSchema.parse({
      data: [row(), row({ id: 'c', name: 'Desk', isSystem: false, builtinKey: null })],
    });
    expect(dm).toMatchObject({
      editable: false,
      customized: false,
      ceiling: [],
      floor: [],
      defaults: null,
    });
    expect(custom).toMatchObject({ editable: true, ceiling: [], floor: [] });
  });

  it('★ garbage costs only its own field, never the list of roles', () => {
    const roles = roleListSchema.parse({
      data: [
        row({
          editable: 'true',
          customized: 'no',
          ceiling: 'settings:roles:manage',
          floor: [42, 'settings:roles:manage', null, ''],
          defaults: [1, 2],
        }),
      ],
    });
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      editable: false,
      customized: false,
      ceiling: [],
      floor: ['settings:roles:manage'],
      defaults: null,
    });
  });
});
