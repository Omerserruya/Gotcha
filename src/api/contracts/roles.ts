import { z } from 'zod';

/**
 * Roles and per-person permissions — screens 12b, 12c and 12e.
 *
 * Shapes read from `services/auth/src/routes/permissions.ts`. Every endpoint
 * the redesign needs exists; what does not exist are two fields the design
 * draws as working.
 *
 * ── A ROLE IS A SET OF FEATURE KEYS, AND NOTHING ELSE ──
 * ```prisma
 * model TenantRoleFeature { roleId · feature }   // composite key. no columns.
 * ```
 * The design describes each role in prose **including money limits** —
 * *"refunds up to ₪1,000"*, *"refunds up to ₪500"*. **There is no amount
 * anywhere in this model.** A role grants `billing.refund` or it does not.
 *
 * So a role's description cannot be generated from its permissions, and a
 * limit cannot be shown because none is stored. The screen lists what a role
 * allows by naming the permissions it holds, and says nothing about amounts.
 *
 * ── AND A PER-PERSON GRANT CAN ALSO TAKE SOMETHING AWAY ──
 * ```prisma
 * model UserFeatureGrant { feature · granted · reason · updatedBy }
 * //  granted true  = give this person something their role lacks
 * //  granted FALSE = take away something their role gives
 * ```
 * The design's 12e is *"add a permission to one person"* and describes only
 * the first. **The second exists, is stored the same way, and is the more
 * dangerous of the two** — a person can be quietly missing something their
 * role says they have. A screen that surfaces *"extras"* and hides removals
 * reports half the exceptions.
 *
 * ── NO LIMIT AND NO EXPIRY ON A GRANT ──
 * The design's 12e gives a grant an **end date** and a **limit**. Neither
 * column exists. A date picker that saves nothing is the reassuring-direction
 * failure this project has hit three times, so the screen says the grant
 * lasts until someone removes it, rather than offering a date.
 */

export const roleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  /** Built-in roles are fixed and cannot be edited or deleted. */
  isSystem: z.boolean().default(false),
  /** `admin` · `agent` · `department_manager` · `owner`, when built in. */
  builtinKey: z.string().nullable().default(null),
  /** The permission keys this role holds. No amounts — see above. */
  features: z
    .array(z.union([z.string(), z.object({ feature: z.string() })]))
    .default([])
    .transform((items) => items.map((i) => (typeof i === 'string' ? i : i.feature))),
  /** `_count.assignments` — how many people wear this role. */
  memberCount: z.number().default(0),
});

export type Role = z.infer<typeof roleSchema>;

/**
 * The route answers `{ data }` with Prisma rows, so `_count` arrives nested.
 * Flattened here so nothing above this file knows the shape of a Prisma
 * aggregate.
 */
export const roleListSchema = z
  .object({
    data: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().nullable().optional(),
          isSystem: z.boolean().optional(),
          builtinKey: z.string().nullable().optional(),
          features: z.array(z.object({ feature: z.string() })).optional(),
          _count: z.object({ assignments: z.number() }).optional(),
        }),
      )
      .default([]),
  })
  .transform(({ data }) =>
    data.map((r) =>
      roleSchema.parse({
        id: r.id,
        name: r.name,
        description: r.description ?? null,
        isSystem: r.isSystem ?? false,
        builtinKey: r.builtinKey ?? null,
        features: r.features ?? [],
        memberCount: r._count?.assignments ?? 0,
      }),
    ),
  );

/**
 * The feature key that means *everything*.
 *
 * `permissions.ts:37` — `if (key === "*") return true`. A role holding it
 * passes every check regardless of what else it has.
 */
export const WILDCARD_FEATURE = '*';

/**
 * Does this role allow everything?
 *
 * **This exists because counting was arithmetically right and said the
 * opposite of the truth.** Owner holds exactly one row, `*`, so the screen
 * rendered *"Allows one thing"* directly beneath *"Full access to
 * everything"* — and a reader comparing Owner's 1 to Admin's 58 concludes
 * Owner is the narrower role.
 *
 * **The row was counted without being read.** A wildcard role says what it
 * means; only a role without one gets a number.
 */
export function allowsEverything(role: Role): boolean {
  return role.features.includes(WILDCARD_FEATURE);
}

/** Built-in roles can be copied but never edited or deleted. */
export function isEditable(role: Role): boolean {
  return !role.isSystem;
}

/**
 * One person's exception to their role.
 *
 * `granted` is the whole story: **true adds, false removes.** Both are
 * exceptions and both deserve to be visible — the design names only the
 * first, and a person silently missing a permission their role grants is the
 * harder of the two to discover.
 */
export const grantSchema = z.object({
  feature: z.string().min(1),
  granted: z.boolean(),
  reason: z.string().nullable().default(null),
  updatedBy: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});

export type Grant = z.infer<typeof grantSchema>;

export function isAddition(grant: Grant): boolean {
  return grant.granted;
}
