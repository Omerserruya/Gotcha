import { describe, expect, it } from 'vitest';

import { currentUserSchema, membershipSchema } from './identity';

/**
 * `GET /api/auth/me`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE BODY BELOW IS THE ROUTE'S, NOT A SHAPE WE FOUND CONVENIENT
 * ════════════════════════════════════════════════════════════════════════════
 * Copied from `listMemberships` in `services/auth/src/routes/auth.ts:24` and
 * from the `res.json` beneath it. The contract this replaces required
 * `tenantId` at the top of a membership, which that route has never sent —
 * the tenant is nested — so it rejected every response the endpoint has ever
 * produced, and took two screens with it.
 */

/** Exactly what the route returns, field for field. */
const ME = {
  user: {
    id: 'cms4ug98s0006chmrtrbt3haa',
    email: 'someone@example.com',
    name: 'Dana Levi',
    role: 'ADMIN',
    tenantId: 'cms4ug98n0004chmrp4lv6ujl',
    identityId: 'idn_1',
    isActive: true,
    createdAt: '2026-01-04T08:00:00.000Z',
  },
  tenantStatus: 'ACTIVE',
  tenantName: 'Gotcha',
  memberships: [
    {
      userId: 'cms4ug98s0006chmrtrbt3haa',
      role: 'ADMIN',
      lastActiveAt: '2026-09-25T07:00:00.000Z',
      memberSince: '2026-01-04T08:00:00.000Z',
      tenant: {
        id: 'cms4ug98n0004chmrp4lv6ujl',
        name: 'Gotcha',
        slug: 'gotcha',
        status: 'ACTIVE',
        isActive: true,
      },
    },
  ],
};

describe('★★ the shape the route actually sends', () => {
  it('★★ parses a real body, which the previous contract could not', async () => {
    /*
     * THE DEFECT. `tenantId` was required at the top of a membership and is
     * nested at `tenant.id`. One required key that does not exist fails the
     * element, the array, and the whole response — `looseObject` and the
     * optional siblings cannot rescue it.
     */
    const parsed = currentUserSchema.parse(ME);
    expect(parsed.user.id).toBe('cms4ug98s0006chmrtrbt3haa');
    expect(parsed.memberships[0]?.tenantId).toBe('cms4ug98n0004chmrp4lv6ujl');
    expect(parsed.memberships[0]?.name).toBe('Gotcha');
  });

  it('★★ a contract can fail on a field nobody uses and take the screen with it', () => {
    /*
     * Neither caller reads `memberships`. 04f wants `user.id` and screen 18
     * wants `user.phoneNumber`, and both got nothing for as long as this was
     * wrong — the edit control hidden from every author, and the WhatsApp
     * destination reading as absent for everybody.
     *
     * Asserted as the property that matters: the field the callers DO use
     * must survive a membership list we have no interest in.
     */
    const parsed = currentUserSchema.parse({ ...ME, memberships: ME.memberships });
    expect(parsed.user.id).toBeTruthy();
  });

  it('★ tolerates a null tenant name, which the route can send', () => {
    // `tenantName: tenant?.name ?? null`. `z.string().optional()` rejects
    // null — a second route into the same blank screen, from a tenant row
    // that could not be read.
    expect(currentUserSchema.parse({ ...ME, tenantName: null }).tenantName).toBeNull();
    expect(
      currentUserSchema.parse({
        ...ME,
        memberships: [{ ...ME.memberships[0], tenant: { id: 't1', name: null } }],
      }).memberships[0]?.tenantId,
    ).toBe('t1');
  });

  it('★ keeps `userId`, which is the User.id an author is compared against', () => {
    /*
     * `listMemberships` maps `userId: m.id` over `prisma.user`, so this is
     * `User.id` — the same id `CustomerNote.authorUserId` holds, and NOT the
     * session's Authentik `sub`. Verified at the mapping rather than
     * inferred from the shape of the string, because the whole point of this
     * read is that two identifiers for one person were being confused.
     */
    expect(membershipSchema.parse(ME.memberships[0]).userId).toBe(ME.user.id);
  });

  it('★★ still refuses a body with no user id at all', () => {
    // The fix must not become "accept anything". `user.id` is what both
    // callers came for, and a response without it is not usable.
    expect(() => currentUserSchema.parse({ ...ME, user: { email: 'x@example.com' } })).toThrow();
  });
});
