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

/**
 * One person, for screen 12d.
 *
 * `GET /api/permissions/users/:userId` → `{ data: { user, roles, grants,
 * permissions, scope, features } }`. `features` is marked *legacy* in the
 * route itself and is not read here.
 *
 * ── SCOPE IS PER ROLE ASSIGNMENT, NOT PER PERMISSION ──
 * `UserRoleAssignment` carries `scope`, `assignedAt` and `assignedBy` — so a
 * person's reach is set **when a role is given to them**. A permission only
 * declares whether the scope dimension applies to it at all
 * (`PermissionDef.scoped`), never what it is set to.
 *
 * ── AND TWO THINGS THE DESIGN ASKS FOR THAT DO NOT EXIST ──
 * **Workload capacity and auto-assign.** *"Workload caps how many
 * conversations the person holds at once"* has no field on `User` and none
 * anywhere in the schema — searched across every service, where the only
 * `maxConcurrent` is a voice-gateway socket limit read from an env var.
 *
 * **A grant's end date.** *"with who added them and when they end"* — the
 * first exists as `updatedBy`, the second does not.
 */
export const personScopeSchema = z.enum(['own', 'team', 'department', 'workspace']).nullable();

export const personSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().default(null),
  email: z.string().default(''),
  /** The platform-level role: ADMIN · AGENT · SYSTEM_ADMIN. */
  role: z.string().default(''),
  /** Tenant role assignments, each with the scope it was granted at. */
  roles: z
    .array(
      z.object({
        roleId: z.string(),
        scope: z.string().nullable().default(null),
      }),
    )
    .default([]),
  /** Overrides — additions AND removals. See `grantSchema`. */
  grants: z.array(grantSchema).default([]),
  /** The effective permission keys, after role and overrides. */
  permissions: z.array(z.string()).default([]),
  scope: z.string().nullable().default(null),
});

export type Person = z.infer<typeof personSchema>;

export const personDetailSchema = z.object({ data: z.unknown() }).transform(({ data }) => {
  const d = (data ?? {}) as Record<string, unknown>;
  const user = (d.user ?? {}) as Record<string, unknown>;
  return personSchema.parse({
    id: user.id,
    name: user.name ?? null,
    email: user.email ?? '',
    role: user.role ?? '',
    roles: d.roles ?? [],
    grants: d.grants ?? [],
    permissions: d.permissions ?? [],
    scope: d.scope ?? null,
  });
});

/**
 * Overrides that ADD something the person's role does not give.
 *
 * Separated from removals because they are different facts, not two values of
 * one. An addition is visible on its own — this person has something extra.
 */
export function additions(person: Person): readonly Grant[] {
  return person.grants.filter((g) => g.granted);
}

/**
 * Overrides that TAKE AWAY something the person's role does give.
 *
 * **These are invisible by construction.** The roles screen shows the Agent
 * role allowing refunds, the person is listed as an Agent, and the person
 * cannot refund — every screen in the chain tells the truth and the reader
 * still ends up wrong.
 *
 * So they are surfaced beside the additions, and a removal must read
 * differently from a plain absence: *"cannot refund"* and *"refund taken
 * away, by Maya, because…"* are different facts and the second is the one
 * somebody needs.
 */
export function removals(person: Person): readonly Grant[] {
  return person.grants.filter((g) => !g.granted);
}

/** Any override at all — the number 12b must count, rather than "extras". */
export function overrideCount(person: Person): number {
  return person.grants.length;
}

/**
 * Every pattern key a role holds — screen 12c.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ A WILDCARD IS A STANDING INSTRUCTION, NOT SHORTHAND FOR TODAY'S LIST
 * ════════════════════════════════════════════════════════════════════════════
 * The catalogue states the semantic outright:
 *
 *   "*"                       → every permission
 *   "ai:*"                    → every ai:* permission
 *   "conversation:messages:*" → every action under conversation:messages
 *
 * *"so roles auto-inherit new permissions."* So expanding a wildcard into the
 * boxes it currently matches does not produce a different role — it produces
 * one that is **identical on the day it is saved and diverges from then on**,
 * silently, every time anyone adds a permission key.
 *
 * The damage is invisible at the moment it is done and surfaces months later
 * as a manager who cannot do something their job description says they can.
 *
 * ── AND IT IS NOT ONLY THE OWNER ROLE ──
 * Measured on this database: **Department Manager** — seeded, ordinary,
 * non-Owner — holds `conversation:messages:*` and `customer:commerce:*`
 * alongside fourteen explicit keys, on every tenant that has it.
 *
 * That is the dangerous shape. Owner is one unmatched string and looks odd.
 * Department Manager would render fourteen correctly ticked boxes and drop
 * two entries, so the grid would look RIGHT while being destructive.
 */
export function wildcardsIn(features: readonly string[]): readonly string[] {
  return features.filter((f) => f === WILDCARD_FEATURE || f.endsWith(':*'));
}

/**
 * Can a checkbox grid represent this role without changing what it means?
 *
 * No, whenever it holds any pattern. **A control that cannot represent a
 * state the system can be in will be used to destroy that state** — so the
 * grid must not be the thing that saves one.
 */
export function gridCanRepresent(features: readonly string[]): boolean {
  return wildcardsIn(features).length === 0;
}

/**
 * Does this effective list already grant `key`? An exact key, `*`, or a
 * pattern that covers it (`conversation:messages:*` covers
 * `conversation:messages:read`) — the catalogue's own wildcard semantic.
 */
export function holds(effective: readonly string[], key: string): boolean {
  return effective.some(
    (f) =>
      f === key || f === WILDCARD_FEATURE || (f.endsWith(':*') && key.startsWith(f.slice(0, -1))),
  );
}
