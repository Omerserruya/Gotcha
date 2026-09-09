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

/** A tenant the current principal belongs to. */
export const membershipSchema = z
  .looseObject({
    tenantId: z.string().min(1),
    tenantName: z.string().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
  })
  .transform((raw) => ({
    tenantId: raw.tenantId,
    // The backend has used both spellings; prefer the explicit one.
    name: raw.tenantName ?? raw.name,
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
  tenantName: z.string().optional(),
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
