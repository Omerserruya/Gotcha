import { z } from 'zod';

/**
 * Contracts for the identity surface.
 *
 * These shapes are confirmed against the backend source, not inferred. Two
 * facts drove how they are written:
 *
 *   1. **The `{ data }` envelope is not universal.** 410 handlers use it and
 *      743 answer bare — `/api/auth/me` is bare, `/api/permissions/me` is
 *      enveloped. The transport unwraps `data` when present and passes the
 *      body through when it is not, so schemas here describe the payload
 *      either way.
 *   2. Everything is `looseObject`: the backend adds fields without
 *      versioning, and an unknown key must never fail a parse.
 */

/**
 * A tenant the current principal belongs to.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS ASKED FOR A FIELD THE ROUTE HAS NEVER SENT, AND IT REJECTED EVERY
 *    RESPONSE
 * ════════════════════════════════════════════════════════════════════════════
 * It required `tenantId` at the top of a membership. `listMemberships`
 * (`services/auth/src/routes/auth.ts:24`) returns the tenant NESTED:
 *
 *   { userId, role, lastActiveAt, memberSince, tenant: { id, name, slug, … } }
 *
 * A required field that is never present fails the array element, which fails
 * `memberships`, which fails the whole of `/api/auth/me`. `looseObject` and
 * the optional siblings could not help: **the one required key was the one
 * that does not exist.**
 *
 * ── AND THE COMMENT THAT HID IT ASSERTED A HISTORY ──
 * The transform read `raw.tenantName ?? raw.name` under *"the backend has
 * used both spellings; prefer the explicit one."* Neither spelling is on a
 * membership — the name is at `tenant.name`. A sentence about what the
 * backend used to do, standing in for a look at what it does. Sixth time
 * today a comment did the reading and got it wrong.
 *
 * ── WHAT IT COST, ON TWO SCREENS ──
 * Nothing reads `memberships` at all. Both callers of `currentUserSchema`
 * want one field each — and both have been getting neither:
 *
 *   04f   `user.id`, so the edit control was hidden from every author
 *   18    `user.phoneNumber`, so the WhatsApp destination read as absent for
 *         everybody, under a comment correctly saying absent is never a
 *         placeholder. It was absent, and not for the reason it looked like.
 *
 * **A contract can fail on a field nobody uses and take the whole screen
 * with it.** The shape below is copied from the route's own mapping.
 */
export const membershipSchema = z
  .looseObject({
    /**
     * ★ `User.id` — the route maps `userId: m.id` over `prisma.user`. So this
     * IS the id `CustomerNote.authorUserId` holds, verified at the mapping
     * rather than inferred from the shape of the string.
     */
    userId: z.string().min(1),
    role: z.string().optional(),
    lastActiveAt: z.string().nullish(),
    memberSince: z.string().nullish(),
    tenant: z.looseObject({
      id: z.string().min(1),
      name: z.string().nullish(),
      slug: z.string().nullish(),
      status: z.string().nullish(),
      isActive: z.boolean().nullish(),
    }),
  })
  .transform((raw) => ({
    userId: raw.userId,
    tenantId: raw.tenant.id,
    name: raw.tenant.name ?? undefined,
    role: raw.role,
  }));

export type Membership = z.infer<typeof membershipSchema>;

/**
 * `GET /api/auth/me`. Answers bare — no `data` envelope.
 *
 * There is no avatar field anywhere on the user, which is why the shell
 * renders initials rather than an image with a fallback.
 */
export const currentUserSchema = z.looseObject({
  user: z.looseObject({
    id: z.string().min(1),
    email: z.email().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
    tenantId: z.string().optional(),
    identityId: z.string().optional(),
  }),
  tenantStatus: z.string().optional(),
  /**
   * ★ NULLISH, NOT OPTIONAL. The route sends `tenant?.name ?? null`, and
   * `z.string().optional()` accepts `undefined` and rejects `null` — so a
   * tenant row that could not be read would have failed this parse too, by
   * a second route into the same blank screen.
   */
  tenantName: z.string().nullish(),
  memberships: z.array(membershipSchema).default([]),
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

/**
 * `GET /api/permissions/me`. Enveloped in `data`.
 *
 * `permissions` is the canonical array of `domain:resource:action` keys, and
 * matching against it is exact. `roleKey` is the effective built-in role and
 * matters because `SYSTEM_ADMIN` short-circuits to every key. `role` and
 * `features` are the legacy surface, kept because the backend still sends
 * them and a caller may still need them.
 */
export const effectivePermissionsSchema = z.looseObject({
  role: z.string().optional(),
  roleKey: z.string().optional(),
  permissions: z.array(z.string()).default([]),
  features: z.array(z.string()).default([]),
  scope: z.unknown().optional(),
});

export type EffectivePermissions = z.infer<typeof effectivePermissionsSchema>;
