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
