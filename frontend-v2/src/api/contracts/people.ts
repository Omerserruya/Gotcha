import { z } from 'zod';

/**
 * Settings · People & teams - screen 12.
 *
 * *"Humans and AI employees in one list, because operationally they are the
 * same resource."* They are one list and three resources, which is the whole
 * shape of this file: the merge happens here and in `roster.ts`, never on the
 * server. Asking the backend to return them as one collection would put a
 * settings screen's layout into the API.
 *
 * Shapes read from route source - `services/auth/src/routes/permissions.ts`,
 * `services/ai/src/routes/ai-agents.ts`, `services/auth/src/routes/
 * departments.ts` - not from the OpenAPI document, whose generator cannot
 * extract response schemas.
 *
 * Three things the design draws that the backend cannot express, all ruled
 * out rather than faked:
 *
 *   - **Per-person money limits.** `BusinessPolicyConfig` scopes `maxAmount`
 *     and `managerApprovalAboveAmount` per ACTION KIND, tenant-wide. There is
 *     no `userId` or `agentId` anywhere in the policy engine, so
 *     *"refunds up to ₪500"* for one person and *"₪100"* for another is
 *     precisely what the model cannot say. `canDo` carries the role instead.
 *   - **Channel → team routing.** `ChannelAccount` has no department link.
 *     Nothing routes a channel to a team, so the line is absent.
 *   - **Escalation target.** `Department.escalationPolicy` has exactly one
 *     writer, fed by an onboarding payload no client populates, and the
 *     departments CRUD route cannot touch it. Unreachable rather than
 *     unpopulated - so no field, and deliberately no "Not set" either, which
 *     would promise a control that exists on no screen.
 */

// ── People ──────────────────────────────────────────────────────────

/** A team this person belongs to. Someone may belong to several. */
export const membershipSchema = z.looseObject({
  departmentId: z.string().min(1),
  departmentName: z.string().nullable().optional(),
  departmentRole: z.string().nullable().optional(),
});

/**
 * `GET /api/permissions/users` - enveloped in `data`, ADMIN only.
 *
 * The UNIFIED list. There is a second one, `GET /api/agents`, which filters
 * `role: "AGENT"` - on a tenant whose members are all admins it returns `[]`,
 * which looks exactly like a tenant with nobody in it. This screen must use
 * the unified route; the agent-only one is not an alternative source.
 *
 * `roleName` is the assigned built-in role and is what the "Can do" column
 * renders. `legacyRole` is the old enum, kept by the backend for consumers
 * that predate the role model - it is a fallback, never the primary label.
 */
export const memberSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
  legacyRole: z.string().nullable().optional(),
  roleId: z.string().nullable().optional(),
  roleName: z.string().nullable().optional(),
  roleBuiltinKey: z.string().nullable().optional(),
  scope: z.string().nullable().optional(),
  departments: z.array(membershipSchema).default([]),
  /**
   * Conversations assigned to this person and not CLOSED.
   *
   * Optional because the unified route does not serve it yet - the count is
   * already computed on `GET /api/agents` and the contract to add it here is
   * accepted but unbuilt. Absent means "not served", which the column renders
   * as nothing at all; it must never collapse to 0, because "no open
   * conversations" and "we were not told" are different facts and only one of
   * them is reassuring.
   */
  openConversations: z.number().optional(),
});

export const membersSchema = z.array(memberSchema);

export type Member = z.infer<typeof memberSchema>;

// ── AI employees ────────────────────────────────────────────────────

export const AI_STATUSES = ['ACTIVE', 'DRAFT', 'PAUSED'] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

/**
 * `GET /api/ai-agents` - enveloped in `data`.
 *
 * **Deliberately `object`, not `looseObject`.** Every other contract in this
 * codebase is loose, because the backend adds fields without versioning and an
 * unknown key must not fail a parse. Here the route answers `{ ...agent }` -
 * the entire `AIAgent` row - which carries `systemPrompt`, `sharedPrompt`,
 * `autonomousPrompt` and `salesContext`: the tenant's proprietary AI
 * instructions. A loose schema would pass all of it through, and this list is
 * read by a client component, so it would be serialised into the browser
 * payload.
 *
 * `object` strips unknown keys, which keeps the tolerance that matters (a new
 * field cannot break the parse) while guaranteeing nothing we did not name
 * crosses to the client. The narrowing is the point, not a side effect.
 */
export const aiEmployeeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** `customer_support`, `sales`, `booking`, `billing`, `custom`. */
  role: z.string().default('custom'),
  status: z.enum(AI_STATUSES).catch('DRAFT'),
  /**
   * Set while the creation wizard is mid-flight and cleared when the employee
   * is saved. `DRAFT` + a step is an ABANDONED draft, not an employee - see
   * `isBuilderDraft`.
   */
  builderStep: z.string().nullable().optional(),
  avatarColor: z.string().nullable().optional(),
  departmentId: z.string().nullable().optional(),
  departmentName: z.string().nullable().optional(),
  /** Tools this employee is allowed to use. Drives nothing on its own. */
  toolCount: z.number().optional(),
  /** Same predicate as a person's: assigned and not CLOSED. Not yet served. */
  openConversations: z.number().optional(),
});

export const aiEmployeesSchema = z.array(aiEmployeeSchema);

export type AiEmployee = z.infer<typeof aiEmployeeSchema>;

/**
 * An unfinished wizard session, not an employee.
 *
 * The backend's own rule: `status=DRAFT AND builderStep IS NOT NULL`. These
 * are offered as "resume setup" elsewhere and excluded from the employee list,
 * so an abandoned session never appears as a colleague.
 */
export function isBuilderDraft(ai: AiEmployee): boolean {
  return ai.status === 'DRAFT' && ai.builderStep != null && ai.builderStep !== '';
}

// ── Teams ───────────────────────────────────────────────────────────

/**
 * `GET /api/departments` - enveloped in `data`.
 *
 * "Team" in the design; `Department` in the backend. Named for the resource
 * here, because a contract describes what the API serves - the user-facing
 * word is the translator's job, and `team.ts` already means something else in
 * this codebase (Home's "your team right now" panel, which is analytics).
 *
 * Richer than the screen asks for: it carries its own counts, so a team card
 * needs no second call.
 *
 * `escalationPolicy` is **not read**. See the note at the top of this file.
 */
export const departmentSchema = z
  .looseObject({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    isActive: z.boolean().default(true),
    _count: z
      .looseObject({
        members: z.number().default(0),
        conversations: z.number().default(0),
      })
      .optional(),
  })
  .transform((raw) => ({
    id: raw.id,
    name: raw.name,
    description: raw.description ?? null,
    isActive: raw.isActive,
    memberCount: raw._count?.members ?? 0,
    /** Open (not CLOSED) conversations belonging to this team. */
    openConversations: raw._count?.conversations ?? 0,
  }));

export const departmentsSchema = z.array(departmentSchema);

export type Department = z.infer<typeof departmentSchema>;

// ── Writes ──────────────────────────────────────────────────────────

/**
 * `POST /api/agents` - the invite. Answers **bare**, with no `data` envelope.
 *
 * It takes `role` (auth 679b8812, G5): a TenantRole id of this workspace, or
 * "AGENT"/"ADMIN" ("ADMIN" is an Owner since auth 30d610da); absent means
 * agent. One above the inviter's own is refused
 * before anyone is created (403 ABOVE_OWN_ROLE / OWNER_ONLY, 400 UNKNOWN_ROLE).
 *
 * `setupLink` is null when the invitee's identity has signed in somewhere
 * before - the backend withholds it deliberately, because mailing an existing
 * user a "set your password" link reads like a phish and can lock them out.
 * Null therefore means "they already have an account", not "something failed".
 */
export const inviteResultSchema = z.looseObject({
  user: z.looseObject({
    id: z.string().min(1),
    email: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  }),
  setupLink: z.string().nullable().optional(),
  existingIdentity: z.boolean().optional(),
});

export type InviteResult = z.infer<typeof inviteResultSchema>;
