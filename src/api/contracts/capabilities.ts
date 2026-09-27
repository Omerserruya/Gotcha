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
/**
 * Acronyms the platform's identifiers are full of.
 *
 * ★★ WITHOUT THIS, THREE SCREENS PRINTED MANGLED WORDS.
 * `humaniseCode` used to upper-case the first letter and nothing else, so a
 * browser walk found **`Crm`** and **`Ai`** as section headings on Permissions
 * and **`Ai-bot inbox tool call`** as the title of twenty-six rows on
 * Approvals. Each is a real acronym rendered as if it were a word.
 *
 * Closed list on purpose: a rule like "upper-case anything under four letters"
 * would turn `Tag` into `TAG`. These are the ones the platform's own column
 * values contain.
 */
const ACRONYMS = new Set([
  'ai',
  'api',
  'bff',
  'crm',
  'csv',
  'faq',
  'id',
  'oidc',
  'pdf',
  'sla',
  'sms',
  'url',
  'vat',
]);

/**
 * Brands whose casing is theirs, not a rule.
 *
 * `whatsapp` was in the acronym list for one draft and came out `WHATSAPP`,
 * which is a different kind of wrong from `Whatsapp` and worse: it looks like
 * shouting rather than like a missing capital. A brand's spelling is a fact
 * about the brand.
 *
 * Channels have real labels in `channels.name.*` and should use those. This is
 * for a brand appearing inside a category or a tool name, where there is no
 * catalogue to look up.
 */
const BRANDS = new Map([
  ['whatsapp', 'WhatsApp'],
  ['shopify', 'Shopify'],
  ['instagram', 'Instagram'],
  ['messenger', 'Messenger'],
  ['gmail', 'Gmail'],
  ['outlook', 'Outlook'],
  ['slack', 'Slack'],
  ['woocommerce', 'WooCommerce'],
]);

/**
 * A backend identifier made readable: `crm` → `CRM`, `ai-bot.inbox.tool_call`
 * → `AI-bot inbox tool call`, `PROJECT_MANAGEMENT` → `Project management`.
 *
 * Shared by the tool names and the integration categories, because both are
 * free-text platform columns with no catalogue to look a label up in. Where a
 * catalogue DOES exist — channels, integration states, permissions — use it;
 * this is for the cases where there is nothing to translate against, and it is
 * strictly better than printing the code.
 */
/**
 * Does this string look like a machine value rather than something a person
 * wrote?
 *
 * A single token of letters, digits and separators, starting with a letter:
 * `WHATSAPP`, `shopify_live_chat`, `intent.refund`, `ai-bot`. Anything with a
 * space in it is prose or a name and is left alone; an address or a URL fails
 * on its `@`, `:` or `/`; a date or a percentage fails on its leading digit.
 *
 * This is the property, not the instance. Two instruments missed `WHATSAPP`
 * this week — mine because I swept where text appears rather than what it
 * does, the supervisor's because its pattern **required an underscore**, which
 * is sound reasoning about acronyms and is exactly how a screaming identifier
 * that happens to be one word walks through. So the rule here is not "has an
 * underscore" or "is upper-case". It is "is a single token with no spaces",
 * which is the thing all of them share.
 */
export function looksLikeCode(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/.test(value);
}

/**
 * Prepare a backend-supplied bag of values for interpolation into a sentence.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS EXISTS BECAUSE A SPREAD IS A HOLE, NOT A SITE
 * ════════════════════════════════════════════════════════════════════════════
 * `t(key, { ...values })` puts whatever the platform sent between the reader
 * and the sentence with nothing in between. On 2026-09-27 that produced, on
 * Home, in a page of otherwise finished English:
 *
 *     71 conversations came through WHATSAPP in the last 30 days.
 *
 * Fixing the channel in that one sentence fixes today's screenshot. The next
 * `kind` the analytics service adds, and the next placeholder added to an
 * existing message, would each get the same free pass — so the humanising
 * belongs at the spread, where every key goes through it, rather than at the
 * placeholder somebody noticed.
 *
 * ⚠ ONE COST, STATED RATHER THAN DISCOVERED. A single lowercase word arrives
 * capitalised, because `refunds` and `fine` are indistinguishable to any rule
 * that does not know the domain. That is right for the taxonomy values the two
 * current callers carry and wrong for free text that happens to be one word, so
 * a caller handling free text should not route it through here.
 *
 * Non-scalars are dropped rather than stringified into `[object Object]`.
 * Numbers pass through untouched: `30` is not a code, and `humaniseCode` on a
 * formatted number would be a second formatter fighting the locale's.
 *
 * ── WHY `resolve` EXISTS ──
 * `humaniseCode('SHOPIFY_LIVE_CHAT')` gives "Shopify live chat", which is
 * right in English and **English on a Hebrew screen**. Where a translated
 * catalogue exists for a key's domain, the caller passes a resolver and the
 * reader gets their own language. Where one does not, the fallback still
 * closes the hole. The default is the one that cannot go stale; the resolver
 * is the improvement on top of it.
 */
export function readableValues(
  values: Record<string, unknown>,
  resolve?: (key: string, value: string) => string | null,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'number') {
      out[key] = value;
      continue;
    }
    if (typeof value !== 'string') continue;
    if (!looksLikeCode(value)) {
      /* Prose, a name, an address, a date. Not ours to rewrite. */
      out[key] = value;
      continue;
    }
    out[key] = resolve?.(key, value) ?? humaniseCode(value);
  }
  return out;
}

export function humaniseCode(code: string): string {
  const spaced = code.replace(/[._]+/g, ' ').trim();
  if (spaced === '') return code;

  const words = spaced.split(' ').map((word, index) => {
    /* `ai-bot` is one word with a hyphen: each part is considered. */
    const parts = word.split('-').map((part) => {
      const lower = part.toLowerCase();
      const brand = BRANDS.get(lower);
      if (brand !== undefined) return brand;
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      /* SCREAMING_SNAKE arrives here as whole upper-case words. */
      return part === part.toUpperCase() ? lower : part;
    });
    const joined = parts.join('-');
    /* Only the first word is capitalised — a sentence, not a title. */
    if (index > 0) return joined;
    const head = parts[0]!;
    return ACRONYMS.has(head.toLowerCase()) ||
      BRANDS.has(head.toLowerCase()) ||
      head === head.toUpperCase()
      ? joined
      : joined.charAt(0).toUpperCase() + joined.slice(1);
  });

  return words.join(' ');
}

/** @deprecated Kept as the previous name; `humaniseCode` is shared now. */
export function humaniseToolName(toolName: string): string {
  return humaniseCode(toolName);
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

/* ── May this be automated at all? ───────────────────────────────────────── */

/**
 * The three states an admin may choose from for one tool.
 *
 * `do_it` is absent from the list wherever the platform cannot positively
 * say the tool is read-only. See `automationCeiling`.
 */
export const ADMIN_CHOICES = ['do_it', 'ask_me', 'never'] as const;
export type AdminChoice = (typeof ADMIN_CHOICES)[number];

/** Why "Do it" is not on offer, or `null` when it is. */
export type NoAutomationReason = 'changes_orders_or_money' | 'unclassified' | null;

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ "DO IT" IS OFFERED ONLY WHERE THE PLATFORM POSITIVELY SAYS `read_only`
 * ════════════════════════════════════════════════════════════════════════════
 * Two independent reasons, either of which would be enough.
 *
 * ── ONE · THE CLASSIFIER IS A NAME REGEX AND IT MISSES TWO OF THE FOUR ──
 * `riskGroupFor` tests four patterns against the tool's NAME and falls
 * through to `create_update`. Measured against real names:
 *
 *   shopify.process_refund   → financial       mayBeAlwaysAllowed = false
 *   shopify.cancel_order     → create_update   mayBeAlwaysAllowed = TRUE
 *   shopify.create_return    → create_update   mayBeAlwaysAllowed = TRUE
 *
 * Neither "cancel" nor "return" appears in `FINANCIAL_RE`, `DELETE_RE`,
 * `ADMIN_RE` or `SENSITIVE_RE`. The design puts both under *"Changing orders
 * and money"* reading *"Comes to Approvals"* — so the classifier disagrees
 * with the design about two of them, permissively.
 *
 * **`create_update` is not a judgement. It is the absence of four
 * judgements**, and a name-based classifier may be trusted when it says SAFE
 * and never when it merely fails to say DANGEROUS. That is the rule already
 * written three functions above `mayBeAlwaysAllowed` in the platform's own
 * file: *"an absent verdict never means 'definitely fine'."*
 *
 * ── TWO · THE DESIGN'S "DO IT" PRESUPPOSES A LIMIT THAT DOES NOT EXIST ──
 * It draws *"Refund up to ₪100 · Do it"*. There is no limit anywhere:
 * `BusinessActionPolicy` has zero rows, `AgentToolPermission` has no numeric
 * field, and per-employee amounts are deferred.
 *
 * So *Do it* on a refund today does not mean *"up to ₪100 automatically"*.
 * It means **refund, any amount, automatically.** The design's control and
 * the product's capability are different controls wearing the same three
 * radio buttons, and the state that requires a bound cannot be offered while
 * no bound exists.
 *
 * ── AND THE ASYMMETRY DECIDES THE TIE ──
 * Too strict: an admin cannot automate a safe write, and says so. A sentence
 * fixes it. Too loose: `cancel_order` is set to Do it **because the screen
 * offered it**, an order is cancelled with nobody looking, and the audit row
 * says `succeeded: null` because no customer-keyed write records a verdict.
 * Not recoverable, and least visible afterwards.
 *
 * ⚠ AND THIS IS NOT THE ONLY GUARD IT SHOULD BE.
 * `PUT /api/tool-permissions/:toolName` does not call `mayBeAlwaysAllowed` —
 * it stores `requiresApproval: false` on a refund if asked. A UI-only guard
 * is one anybody with curl steps over. Backend has the enforcement; this one
 * exists because it is the guard that explains itself to a person.
 */
export function automationCeiling(capability: Capability): NoAutomationReason {
  const group = (capability.riskGroup ?? '').trim();
  if (group === 'read_only') return null;
  /*
   * Named apart so the sentence can be. "This changes orders or money" is a
   * statement about the tool; "we could not classify this" is a statement
   * about us, and a reader can act on the first.
   */
  return group === '' || group === 'create_update' ? 'unclassified' : 'changes_orders_or_money';
}

/** The choices an admin may actually pick for this tool, in design order. */
export function choicesFor(capability: Capability): readonly AdminChoice[] {
  return automationCeiling(capability) === null
    ? ['do_it', 'ask_me', 'never']
    : ['ask_me', 'never'];
}

/** Which choice the tool is on now. */
export function currentChoice(capability: Capability): AdminChoice {
  if (!capability.enabled) return 'never';
  return capability.requiresApproval ? 'ask_me' : 'do_it';
}

/**
 * What the write body must be to reach a chosen state.
 *
 * ★ BOTH FIELDS, ALWAYS. The route applies `requiresApproval` only when it
 * is present, so sending `{ enabled: true }` alone on a tool currently set
 * to Never would enable it at whatever approval setting it last had — which
 * on a financial tool could be none. Every transition states both.
 */
export function bodyFor(choice: AdminChoice): {
  readonly enabled: boolean;
  readonly requiresApproval: boolean;
} {
  if (choice === 'never') return { enabled: false, requiresApproval: true };
  return { enabled: true, requiresApproval: choice === 'ask_me' };
}
