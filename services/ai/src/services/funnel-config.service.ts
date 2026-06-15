/**
 * Tenant Funnel Configuration (Task 2).
 *
 * The platform owns the primitives - ConversationStage, Intent, StrategyName,
 * PlaybookId. Tenants do NOT invent new primitives. They author a *funnel
 * config* that LAYERS on top: tenant-readable stage labels, transitions
 * between them, and a small overlay of strategy / playbook overrides for
 * specific (stage, intent, userType) combinations.
 *
 * Why this shape (and not a totally free-form funnel):
 *   - BEL stays deterministic. A tenant-defined stage cannot drive prompt
 *     logic the platform doesn't know about. It is always *anchored* to a
 *     platform stage (`baseStage`).
 *   - Strategy enum stays closed. Tenants override the mapping, not the set.
 *   - Playbooks stay a curated catalog. Tenants pick from it; they don't
 *     freehand new ones in this layer (a separate playbook-authoring layer
 *     exists if/when we ship it).
 *
 * Failure mode: if a tenant has no funnel config → BEL behaves exactly as
 * today. Funnel config is purely additive.
 */

import type { StageCopilotConfig } from "@chatcenter/shared";
import type {
  ConversationStage,
  Intent,
  UserType,
} from "./behavior-engine.service";
import type { StrategyName } from "./behavior-strategies";
import type { PlaybookId } from "./conversation-playbooks";

// ─── Schema ─────────────────────────────────────────────────

export interface FunnelStage {
  /** Tenant-readable id, unique within the funnel. */
  id: string;
  /** Display name for dashboards / CRM. */
  label: string;
  /**
   * Anchor to a platform stage. BEL resolves prompt behavior from this.
   * Tenants cannot break the contract by inventing new platform stages.
   */
  baseStage: ConversationStage;
  /**
   * Optional entry guard. The transition resolver only places the
   * conversation INTO this stage when the guard matches.
   */
  entry?: StageGuard;
  /**
   * Optional exit guard. Once entered, the stage will only release to a
   * downstream stage when this guard matches (e.g. "objection cleared").
   */
  exit?: StageGuard;
  /**
   * Vendor CRM value this stage corresponds to (e.g. HubSpot's
   * `lifecyclestage` value, Zoho's `Stage` picklist label). Used to
   * resolve the customer's current stage from a CRM context fetch and
   * to write the new stage back on transition.
   */
  crmValue?: string;
  /**
   * Stage-scoped copilot configuration: per-stage goal, required
   * questions, required data fields, exit criteria, and `nextStageId`.
   * When present, supersedes the channel-level CopilotConfig.goals /
   * questions / dataFields during live cue generation and post-call
   * evaluation.
   */
  copilot?: StageCopilotConfig;
}

export interface StageGuard {
  /** Required intents (any-of). Empty/omitted = any intent. */
  intents?: Intent[];
  /** Required user types (any-of). */
  userTypes?: UserType[];
  /** Case-insensitive substring markers in the customer's last message. */
  markers?: string[];
}

export interface FunnelTransition {
  from: string;
  to: string;
  /** Transition fires only when the guard matches. */
  when?: StageGuard;
}

export interface StrategyOverride {
  /** All conditions present must match. */
  match: {
    stageId?: string;          // tenant stage id
    baseStage?: ConversationStage;
    intent?: Intent;
    userType?: UserType;
  };
  strategy: StrategyName;
  /** Audit reason - surfaced in BehaviorState.provenance.overrides. */
  reason: string;
}

export interface PlaybookOverride {
  match: {
    stageId?: string;
    baseStage?: ConversationStage;
    intent?: Intent;
    strategy?: StrategyName;
  };
  /** Replaces the platform default selection for this match. */
  playbookIds: PlaybookId[];
  reason: string;
}

export interface FunnelConfig {
  /** Tenant scope. Resolved from request context, not the funnel itself. */
  tenantId: string;
  /** Funnel id within the tenant (a tenant may run several funnels). */
  funnelId: string;
  /**
   * Department scope. NULL = tenant default (applies to all departments
   * that have no explicit department-scoped funnel).
   */
  departmentId: string | null;
  stages: FunnelStage[];
  transitions: FunnelTransition[];
  strategyOverrides?: StrategyOverride[];
  playbookOverrides?: PlaybookOverride[];
}

// ─── Resolution ─────────────────────────────────────────────

export interface ResolveOpts {
  funnel?: FunnelConfig | null;
  baseStage: ConversationStage;
  intent: Intent;
  userType: UserType;
  strategy: StrategyName;
  /**
   * The customer's last message - used by `markers` guards. The BEL already
   * normalizes/lowercases it before classification; we accept the raw form
   * and lowercase here so callers don't have to think about it.
   */
  lastMessage: string;
}

export interface FunnelResolution {
  /** First stage whose baseStage matches AND entry guard passes. May be null. */
  stageId: string | null;
  /** Strategy after applying overrides. */
  strategy: StrategyName;
  /** Playbook ids after applying overrides. Null = use platform default. */
  playbookIds: PlaybookId[] | null;
  /** Reasons applied - appended to BEL provenance.overrides. */
  appliedReasons: string[];
}

/**
 * Pure resolver. Given a tenant funnel config + the BEL's already-computed
 * baseStage / intent / userType / strategy, returns the final stage label,
 * possibly-overridden strategy, and possibly-overridden playbook list.
 *
 * Determinism: stages are scanned in array order; the first matching stage
 * wins. Overrides are scanned in array order; the LAST matching override
 * wins (so tenants can write "general → specific" rules and have specific
 * win - same convention as CSS).
 */
export function resolveFunnel(opts: ResolveOpts): FunnelResolution {
  const lastMessage = (opts.lastMessage || "").toLowerCase();
  const reasons: string[] = [];

  if (!opts.funnel) {
    return { stageId: null, strategy: opts.strategy, playbookIds: null, appliedReasons: [] };
  }

  // 1) Pick the tenant stage whose baseStage matches AND entry guard passes.
  let stageId: string | null = null;
  for (const st of opts.funnel.stages) {
    if (st.baseStage !== opts.baseStage) continue;
    if (!guardMatches(st.entry, { intent: opts.intent, userType: opts.userType, lastMessage })) continue;
    stageId = st.id;
    break;
  }
  if (stageId) reasons.push(`funnel.stage=${stageId}`);

  // 2) Apply strategy overrides - last match wins.
  let strategy = opts.strategy;
  for (const ov of opts.funnel.strategyOverrides || []) {
    if (!matchesOverride(ov.match, { stageId, baseStage: opts.baseStage, intent: opts.intent, userType: opts.userType })) continue;
    strategy = ov.strategy;
    reasons.push(`funnel.strategy_override(${ov.reason})→${ov.strategy}`);
  }

  // 3) Apply playbook overrides - last match wins.
  let playbookIds: PlaybookId[] | null = null;
  for (const ov of opts.funnel.playbookOverrides || []) {
    if (!matchesOverride({ ...ov.match, strategy: ov.match.strategy ?? strategy }, {
      stageId,
      baseStage: opts.baseStage,
      intent: opts.intent,
      strategy,
    })) continue;
    playbookIds = ov.playbookIds.slice();
    reasons.push(`funnel.playbook_override(${ov.reason})→[${ov.playbookIds.join(",")}]`);
  }

  return { stageId, strategy, playbookIds, appliedReasons: reasons };
}

function guardMatches(
  guard: StageGuard | undefined,
  ctx: { intent: Intent; userType: UserType; lastMessage: string },
): boolean {
  if (!guard) return true;
  if (guard.intents?.length && !guard.intents.includes(ctx.intent)) return false;
  if (guard.userTypes?.length && !guard.userTypes.includes(ctx.userType)) return false;
  if (guard.markers?.length && !guard.markers.some((m) => ctx.lastMessage.includes(m.toLowerCase()))) return false;
  return true;
}

function matchesOverride(
  match: {
    stageId?: string;
    baseStage?: ConversationStage;
    intent?: Intent;
    userType?: UserType;
    strategy?: StrategyName;
  },
  ctx: {
    stageId: string | null;
    baseStage: ConversationStage;
    intent: Intent;
    userType?: UserType;
    strategy?: StrategyName;
  },
): boolean {
  if (match.stageId && match.stageId !== ctx.stageId) return false;
  if (match.baseStage && match.baseStage !== ctx.baseStage) return false;
  if (match.intent && match.intent !== ctx.intent) return false;
  if (match.userType && ctx.userType && match.userType !== ctx.userType) return false;
  if (match.strategy && ctx.strategy && match.strategy !== ctx.strategy) return false;
  return true;
}

// ─── Persistence (callsite-owned) ────────────────────────────

/**
 * Loader contract - the caller (ai-bot.service / openai.provider) is
 * responsible for fetching from DB / cache. We accept either:
 *   - a `FunnelConfig` directly (test seam), OR
 *   - `null` when a tenant has no funnel (no-op resolver).
 *
 * No DB read here; the BEL must remain pure (no I/O).
 */
export type FunnelLoader = (opts: { tenantId: string; departmentId?: string | null }) => Promise<FunnelConfig | null>;

// ─── Examples (canonical fixtures used by tests + docs) ──────

export const SAAS_DEFAULT_FUNNEL: FunnelConfig = {
  tenantId: "__example_saas__",
  funnelId: "saas-default",
  departmentId: null,
  // Ordered most-specific-first within a baseStage. The resolver picks the
  // first stage whose baseStage matches AND entry guard passes - so any
  // marker-anchored stage MUST come before a marker-less sibling.
  stages: [
    { id: "lead", label: "New Lead", baseStage: "initial" },
    {
      id: "demo",
      label: "Demo Scheduled",
      baseStage: "exploration",
      entry: { markers: ["demo", "see it in action", "דמו", "הדגמה"] },
    },
    {
      id: "qualified",
      label: "Qualified",
      baseStage: "exploration",
      entry: { intents: ["informational", "transactional"] },
    },
    { id: "objection", label: "Objection", baseStage: "objection" },
    { id: "closing", label: "Closing", baseStage: "decision" },
  ],
  transitions: [
    { from: "lead", to: "qualified", when: { intents: ["informational", "transactional"] } },
    { from: "qualified", to: "demo", when: { markers: ["demo", "הדגמה"] } },
    { from: "demo", to: "closing", when: { intents: ["transactional"] } },
    { from: "qualified", to: "objection", when: { markers: ["expensive", "יקר", "but"] } },
    { from: "objection", to: "closing", when: { intents: ["transactional"] } },
  ],
  strategyOverrides: [
    {
      match: { stageId: "demo", intent: "informational" },
      strategy: "CONVERT",
      reason: "demo-stage informational → CONVERT (push toward booking, not endless info)",
    },
  ],
  playbookOverrides: [
    {
      match: { stageId: "qualified", strategy: "QUALIFY" },
      playbookIds: ["lead_qualification", "demo_request"],
      reason: "qualified-stage QUALIFY → emphasize demo path",
    },
  ],
};

export const SERVICE_DEFAULT_FUNNEL: FunnelConfig = {
  tenantId: "__example_service__",
  funnelId: "service-default",
  departmentId: null,
  // Ordered most-specific-first within a baseStage (see SaaS funnel above).
  stages: [
    { id: "inquiry", label: "Inquiry", baseStage: "initial" },
    {
      id: "quoted",
      label: "Quoted",
      baseStage: "exploration",
      entry: { markers: ["quote", "estimate", "הצעת מחיר", "אומדן"] },
    },
    {
      id: "scoped",
      label: "Scoped",
      baseStage: "exploration",
      entry: { intents: ["informational", "transactional"] },
    },
    { id: "objection", label: "Objection", baseStage: "objection" },
    { id: "booked", label: "Booked", baseStage: "decision" },
  ],
  transitions: [
    { from: "inquiry", to: "scoped", when: { intents: ["informational", "transactional"] } },
    { from: "scoped", to: "quoted", when: { markers: ["quote", "הצעת מחיר"] } },
    { from: "quoted", to: "booked", when: { intents: ["transactional"] } },
    { from: "scoped", to: "objection", when: { markers: ["expensive", "יקר"] } },
  ],
  strategyOverrides: [
    {
      match: { stageId: "quoted", intent: "informational" },
      strategy: "CONVERT",
      reason: "post-quote informational → push to booking",
    },
  ],
  playbookOverrides: [
    {
      match: { stageId: "scoped", strategy: "QUALIFY" },
      playbookIds: ["lead_qualification"],
      reason: "scoped-stage QUALIFY → discovery only",
    },
  ],
};
