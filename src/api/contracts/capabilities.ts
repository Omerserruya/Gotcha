import { z } from 'zod';

/**
 * What GOTCHA is allowed to do — screen 10.
 *
 * Shapes read from `services/ai/src/routes/tool-permissions.ts`, and the
 * values below were **measured through the endpoint with a real session**
 * rather than read off the model: seventeen rows on this tenant.
 *
 * ── THE RISK GROUPING IS A REGEX OVER THE TOOL'S NAME ──
 * ```ts
 * export function riskGroupFor(toolName: string): RiskGroup {
 *   if (classifyToolEffect(name) === "read") return "read_only";
 *   if (FINANCIAL_RE.test(name)) return "financial";
 *   if (DELETE_RE.test(name))    return "delete";
 *   if (ADMIN_RE.test(name))     return "administrative";
 *   if (SENSITIVE_RE.test(name)) return "sensitive_data";
 *   return "create_update";                                  // no match
 * }
 * ```
 * It is **not stored and not assessed**. `create_update` is the fallback, so
 * *"13 capabilities are create/update risk"* is false — **13 matched no
 * pattern at all.**
 *
 * And the consequence is in this tenant's own rows:
 * ```
 * update_contact  → sensitive_data     SENSITIVE_RE matches "contact"
 * update_crm      → create_update      "crm" matches nothing
 * ```
 * **The same operation on the same data lands in two different groups
 * because one name happens to contain the word "contact".** A screen
 * rendering that as a risk assessment presents a regex miss as a judgement,
 * so this one does not group by it.
 *
 * ── EVERY SETTING ON THIS TENANT IS A DEFAULT ──
 * `isDefault`, `enabled`, `allowModification`, `expiresAfterMin` and
 * `approverRole` are **uniform across all seventeen rows**. Nobody has ever
 * customised a capability here. Seventeen identical toggles would paint
 * defaults as decisions somebody made.
 *
 * Three of those uniform values are worth stating outright rather than
 * rendering as a column of repeats:
 *
 *   `allowModification: false` everywhere — nobody can edit an approved
 *       action before it runs, which is the permission Approvals found is
 *       read by nothing.
 *   `expiresAfterMin: 30` everywhere — every approval request dies after
 *       thirty minutes, and Approvals found 13 of 27 approved actions never
 *       executed.
 *   `approverRole: null` everywhere — *"who approves this"* has no answer.
 *       That is an **absent**, not an empty.
 *
 * ── AND THERE IS NO "WHAT IT CAN SEE" SIDE ──
 * `kind` is `action` on all seventeen and `read_only` appears zero times, so
 * a *"what it can see / what it can do"* split has one side and must not be
 * drawn as two.
 */

/**
 * **Ordered least to most consequential**, and that ordering is contractual —
 * `tool-availability.ts` says the UI groups by these and *"the ordering is the
 * display order, so it is part of the contract"*, with tests. Do not reorder.
 */
export const RISK_GROUPS = [
  'read_only',
  'create_update',
  'delete',
  'financial',
  'sensitive_data',
  'administrative',
] as const;
export type RiskGroup = (typeof RISK_GROUPS)[number];

export const capabilitySchema = z.object({
  toolName: z.string().min(1),
  /** `action` on every row here. `read_only` capabilities do not appear. */
  kind: z.string().default('action'),
  /** `messaging` · `crm` · `broadcast` · `meta` · `identity` · `workflow`. */
  category: z.string().default(''),
  description: z.string().default(''),
  enabled: z.boolean().default(false),
  /** The design's "ask me first". True on 11 of 17 here. */
  requiresApproval: z.boolean().default(false),
  /** True when nobody has overridden the platform default. True on all 17. */
  isDefault: z.boolean().default(true),
  /** Null on every row: "who approves this" has no answer. */
  approverRole: z.string().nullable().default(null),
  /** 30 on every row. How long an approval request stays answerable. */
  expiresAfterMin: z.number().nullable().default(null),
  /**
   * False on every row. The permission governing editing an approved action's
   * parameters — and **no code path reads it**, which Approvals established.
   */
  allowModification: z.boolean().default(false),
  /**
   * **A regex match on `toolName`, not an assessment.** `create_update` means
   * "matched nothing". Kept because it is what the platform will act on, and
   * never rendered as a judgement.
   */
  riskGroup: z.string().nullable().default(null),
  integration: z.string().nullable().default(null),

  /* ── The fourth state's evidence, and it is all OPTIONAL on purpose ────── */

  /**
   * ════════════════════════════════════════════════════════════════════════
   * ★★ `undefined` HERE MEANS "WE DO NOT KNOW", AND THE ROUTE SAYS SO
   * ════════════════════════════════════════════════════════════════════════
   * *"A tool whose provider we have no record of is not reported as
   * disconnected — we simply do not know, and guessing 'broken' is its own
   * false statement."*
   *
   * So this is `.optional()` and **not** `.nullable().default(false)`. A
   * default would turn every tool with an unrecognised provider into a
   * disconnected one, which is the same manufactured claim as `voiceEnabled`
   * collapsing to false — and here it would grey out a control that works.
   */
  integrationConnected: z.boolean().optional(),
  /**
   * ★★ THE RUNTIME'S OWN VERDICT, AND IT MUST NOT BE RE-DERIVED.
   *
   * The route's comment: *"Sent as a decided boolean rather than leaving the
   * UI to re-derive it from two scope lists, because a second derivation is
   * a second chance to disagree with the runtime."* It comes from
   * `toolBlockedByMissingScopes` — the same function the bot's own tool
   * surface uses.
   *
   * `undefined` means the caller could not supply a verdict, which **never
   * means "definitely fine"**. See `resolveAvailability`.
   */
  scopeBlocked: z.boolean().optional(),
  /** Which required scopes are known-missing, when the runtime says so. */
  missingScopes: z.array(z.string()).optional(),
  /** Declared requirement and actual grant, for the fallback comparison. */
  requiredScopes: z.array(z.string()).optional(),
  grantedScopes: z.array(z.string()).optional(),
});

export type Capability = z.infer<typeof capabilitySchema>;
export const capabilityListSchema = z.array(capabilitySchema);

/**
 * What GOTCHA does when this capability comes up.
 *
 * The design promises three settings — *do it · ask me first · never* — and
 * two of the three are real: `enabled` and `requiresApproval`. "Never" is
 * `enabled: false`.
 */
export type CapabilityStance = 'never' | 'ask_first' | 'on_its_own';

export function capabilityStance(capability: Capability): CapabilityStance {
  if (!capability.enabled) return 'never';
  return capability.requiresApproval ? 'ask_first' : 'on_its_own';
}

/**
 * True when every row shares a value — so the screen can say it once instead
 * of repeating it seventeen times.
 *
 * A column of identical values reads as seventeen decisions. One sentence
 * reads as what it is: a platform default nobody has changed.
 */
export function isUniform<T>(rows: readonly T[], of: (row: T) => unknown): boolean {
  if (rows.length === 0) return false;
  const first = of(rows[0]!);
  return rows.every((row) => of(row) === first);
}

/** Capabilities that act without asking. The ones worth reading first. */
export function actsAlone(capabilities: readonly Capability[]): readonly Capability[] {
  return capabilities.filter((c) => capabilityStance(c) === 'on_its_own');
}

/** Tool names this app has merchant-facing words for. */
export const DESCRIBED_TOOLS = [
  'send_message',
  'generate_followup',
  'schedule_followup',
  'schedule_followup_template',
  'close_conversation',
  'escalate_to_human',
  'update_contact',
  'update_crm',
  'create_ticket',
  'tag_contact',
  'create_task',
  'create_broadcast',
  'schedule_broadcast',
  'create_workflow',
  'merge_contacts',
  'link_customer_identifier',
] as const;

export function hasOwnWords(toolName: string): boolean {
  return (DESCRIBED_TOOLS as readonly string[]).includes(toolName);
}

/**
 * A readable name for a capability this app has no sentence for.
 *
 * **Never the platform's `description`.** Those are written for whoever calls
 * the tool, not for the merchant reading this screen — they carry backticks,
 * parenthetical *"(autonomous bot only)"* notes and instructions to call other
 * tools by their function names. Seventeen rows of that reads like an API
 * reference on a shopkeeper's screen.
 *
 * So an unmapped tool falls back to its own name, made readable. That is
 * short, true, and leaks no implementation prose — and a missing translation
 * looks like a missing translation rather than like documentation.
 */
export function humaniseToolName(toolName: string): string {
  const words = toolName.replace(/[._]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface CategoryGroup {
  readonly category: string;
  readonly capabilities: readonly Capability[];
}

/**
 * Grouped by what the capability is *about*, not by what a regex guessed
 * about its name.
 *
 * `category` is a stored field with six real values here. `riskGroup` is
 * computed from a name pattern with a catch-all fallback, and grouping by it
 * would present that fallback as a risk finding.
 */
export function groupByCategory(capabilities: readonly Capability[]): readonly CategoryGroup[] {
  const groups = new Map<string, Capability[]>();
  for (const capability of capabilities) {
    const key = capability.category || 'other';
    const existing = groups.get(key);
    if (existing) existing.push(capability);
    else groups.set(key, [capability]);
  }
  return [...groups.entries()]
    .map(([category, items]) => ({ category, capabilities: items }))
    .sort((a, b) => b.capabilities.length - a.capabilities.length);
}

/* ── What the row should actually say ────────────────────────────────────── */

/**
 * The design asks for three settings. **The platform models four.**
 *
 *   always_allow      do it
 *   require_approval  ask me
 *   disabled          never — and the admin chose it
 *   unavailable       the switch is not the admin's to press right now
 *
 * The fourth is the one worth having: a greyed row that says WHY beats a
 * greyed row, and beats an enabled row that fails when pressed.
 */
export const PERMISSION_STATES = [
  'always_allow',
  'require_approval',
  'disabled',
  'unavailable',
] as const;
export type PermissionState = (typeof PERMISSION_STATES)[number];

/**
 * Why a row is unavailable. `ok` explicitly means *"this really is the
 * admin's choice"* rather than "no reason given".
 *
 * ⚠ TWO OF THESE CANNOT ARRIVE FROM `/api/tool-permissions`.
 * `plan_not_entitled` and `no_catalog_entry` are resolved from `planEntitled`
 * and `hasCatalogEntry`, and that route sends neither — it builds its rows by
 * hand rather than calling the shared resolver. They are named here because
 * the domain has five and a `z.enum` missing a member rejects the whole
 * response the day a second caller appears; they are not rendered as states
 * this screen can reach.
 */
export const UNAVAILABLE_REASONS = [
  'ok',
  'integration_disconnected',
  'missing_scope',
  'plan_not_entitled',
  'no_catalog_entry',
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export interface Availability {
  readonly state: PermissionState;
  readonly reason: UnavailableReason;
  /** Empty unless `missing_scope`. */
  readonly missingScopes: readonly string[];
  /** True when the stored preference is currently overridden by the platform. */
  readonly overriddenByPlatform: boolean;
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A PORT OF `resolveToolAvailability`, ORDER INCLUDED — AND THE ORDER IS
 *    THE POINT
 * ════════════════════════════════════════════════════════════════════════════
 * The shared lib's own comment: *"Reasons are checked in the order the admin
 * can act on them: an unentitled plan cannot be fixed by connecting
 * anything, a disconnected integration cannot be fixed by granting scopes,
 * and a missing scope cannot be fixed by toggling the switch. **Reporting the
 * wrong one sends them to the wrong screen.**"*
 *
 * So this is not "check the flags in any order and return the first true" —
 * the sequence encodes which repair supersedes which, and reordering it
 * would send somebody to grant a scope on an integration that is not
 * connected.
 *
 * ── WHY A PORT AND NOT A SECOND OPINION ──
 * The route does not call the resolver; it hands us the decided booleans.
 * Given those, the mapping to a state is arithmetic, and doing it here keeps
 * the screen and the runtime agreeing by construction. What this must never
 * do is re-derive `scopeBlocked` when the runtime supplied it — that is the
 * second derivation the route's comment warns about.
 */
export function resolveAvailability(capability: Capability): Availability {
  const base = { missingScopes: [] as readonly string[] };

  // `plan_not_entitled` and `no_catalog_entry` would be checked first, and
  // are unreachable from this endpoint — see UNAVAILABLE_REASONS.

  /*
   * ★ `=== false`, NOT `!connected`. `undefined` is "we have no record of
   * this provider", which the route deliberately distinguishes from
   * "disconnected". Truthiness would collapse the two.
   */
  if (capability.integrationConnected === false) {
    return {
      ...base,
      state: 'unavailable',
      reason: 'integration_disconnected',
      overriddenByPlatform: true,
    };
  }

  // The runtime's verdict wins wherever it gave one.
  if (capability.scopeBlocked === true) {
    return {
      ...base,
      state: 'unavailable',
      reason: 'missing_scope',
      missingScopes: capability.missingScopes ?? [],
      overriddenByPlatform: true,
    };
  }

  /*
   * ★★ AND AN ABSENT VERDICT IS NOT A PASS.
   *
   * `!== false` rather than `=== undefined`: the fallback runs when the
   * runtime said nothing, because *"an absent verdict never means
   * 'definitely fine'"*. A provider with no adapter definition supplies no
   * verdict, and its declared scopes are then the only evidence there is.
   */
  if (capability.scopeBlocked !== false) {
    const required = capability.requiredScopes ?? [];
    if (required.length > 0) {
      const granted = new Set(capability.grantedScopes ?? []);
      const missing = required.filter((scope) => !granted.has(scope));
      if (missing.length > 0) {
        return {
          ...base,
          state: 'unavailable',
          reason: 'missing_scope',
          missingScopes: missing,
          overriddenByPlatform: true,
        };
      }
    }
  }

  // Everything the platform controls is satisfied, so the switch really is
  // the admin's — which is what `reason: 'ok'` says.
  if (!capability.enabled) {
    return { ...base, state: 'disabled', reason: 'ok', overriddenByPlatform: false };
  }
  return {
    ...base,
    state: capability.requiresApproval ? 'require_approval' : 'always_allow',
    reason: 'ok',
    overriddenByPlatform: false,
  };
}

/** Can the admin change this row at all? */
export function isTheAdminsChoice(availability: Availability): boolean {
  return availability.state !== 'unavailable';
}

/* ── How often each tool has actually been used ──────────────────────────── */

/**
 * `GET /api/analytics/tool-usage` — `analytics:dashboard:read`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ IT READS TWO TABLES, AND THAT IS WHY IT IS THE RIGHT SOURCE
 * ════════════════════════════════════════════════════════════════════════════
 * `getToolUsageStats` unions `ToolExecution` with the `adapter.*` rows in the
 * audit log, deliberately: *"the dev estate holds 0 ToolExecution rows and
 * 3,475 adapter records… the connector executions were never missing; they
 * were in the other table, and nothing joined them up."*
 *
 * So a usage panel built on this is NOT blind to adapter-run tools. A panel
 * built on a `ToolExecution` groupBy would be — that is the shape to avoid,
 * and the reason this endpoint exists.
 */
export const toolUsageSchema = z.object({
  toolName: z.string(),
  executionCount: z.number().default(0),
  successCount: z.number().default(0),
  /**
   * ★ A REFUSAL IS THE PRODUCT WORKING. The service keeps these apart from
   * errors for a stated reason: *"guessing would make a functioning approval
   * policy read as a broken integration."* A tool a rule keeps stopping and a
   * tool that keeps breaking need opposite repairs.
   */
  refusedCount: z.number().default(0),
  /**
   * ★★ OPTIONAL, NOT DEFAULTED — SEE `neverFailed`.
   *
   * A service that does not report errors at all would default to `0` and
   * let the screen print *"never failed"*. Absent is "we were not told",
   * not "there were none".
   */
  erroredCount: z.number().optional(),
  /**
   * ★★ FAILURES FROM BEFORE THE REASON WAS RECORDED, AND NOT COUNTED AS
   * ERRORS — the service refuses to guess which kind they were.
   *
   * This is what stops the screen saying the design's *"never failed"*. See
   * `neverFailed`.
   *
   * ★★ AND IT IS `.optional()`, WHICH IS THE WHOLE POINT.
   *
   * It shipped as `.default(0)`. A service that does not report this field
   * — every service older than it — then had `unclassifiedFailureCount: 0`
   * and `neverFailed` returned **true**, printing the exact caption this
   * field exists to prevent.
   *
   * I built the three-state function and defaulted the third state away at
   * the parse, one file over. Found by a sweep asking, of every three-state
   * field, whether any test drives it through the schema. This one had
   * none: the component tests handed `ToolUsage` objects straight in.
   */
  unclassifiedFailureCount: z.number().optional(),
  /** Successes over ALL attempts, refusals included in the denominator. */
  successRate: z.number().default(0),
  avgDurationMs: z.number().nullable().default(null),
});
export type ToolUsage = z.infer<typeof toolUsageSchema>;

export const toolUsageListSchema = z.array(toolUsageSchema);

/**
 * Can we say this tool has never failed?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ `null` IS AN ANSWER, AND IT IS THE DESIGN'S CAPTION THAT FORCES IT
 * ════════════════════════════════════════════════════════════════════════════
 * The design prints *"Used 1,840 times this week · never failed"*. That is a
 * claim, and `erroredCount === 0` does not support it: rows written before
 * the platform recorded a failure reason land in `unclassifiedFailureCount`
 * and are **deliberately not counted as errors**, because the service will
 * not guess whether they were refusals or breakages.
 *
 * So there are three answers, not two:
 *
 *   true   no errors and nothing unclassified — the claim is safe
 *   false  something errored
 *   null   nothing errored, but some attempts we cannot classify. "Never
 *          failed" would be an assertion about rows nobody can read.
 */
export function neverFailed(usage: ToolUsage): boolean | null {
  /*
   * ★ A FIELD WE WERE NOT SENT CANNOT SUPPORT A CLAIM.
   *
   * Absent means the service does not report it — not that it counted none.
   * Either absence makes "never failed" unsayable, because the claim needs
   * BOTH counters to be zero and we would be asserting one of them.
   */
  if (usage.erroredCount === undefined || usage.unclassifiedFailureCount === undefined) {
    return null;
  }
  if (usage.erroredCount > 0) return false;
  if (usage.unclassifiedFailureCount > 0) return null;
  return true;
}

/** Usage for one tool, or `null` when it has never run. */
export function usageFor(toolName: string, usage: readonly ToolUsage[] | null): ToolUsage | null {
  return usage?.find((u) => u.toolName === toolName) ?? null;
}
