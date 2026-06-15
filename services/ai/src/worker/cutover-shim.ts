/**
 * Cutover shim: translates legacy call-site shapes into AIWorker calls.
 *
 * Each legacy call site (live-analysis-runner, ai-bot.service, etc.)
 * passes an `AIAgent` row (today the canonical "AI Employee" config).
 * The shim coerces it into an `AIWorkerConfig + AIWorkerSessionProfile`
 * pair the worker can consume.
 *
 * Design correction (vs the original Phase 5 design):
 *   The original shim treated voice channels as having their OWN config
 *   (`LegacyVoiceChannelConfig`) separate from the agent record. This
 *   reflected the pre-refactor reality where `voice_channels.copilot_config`
 *   is its own JSONB blob with NO link to `AIAgent`.
 *
 *   The corrected direction: the SAME `AIAgent` runs across chat,
 *   copilot, AND voice. Voice channels get a new `ai_agent_id` FK
 *   (Phase 6 migration), and the old `copilot_config` columns are
 *   migrated onto the agent. The call-pilot "skill layer" is just
 *   `mode=callpilot` selecting different skill renders - no separate
 *   config blob.
 *
 *   Until the migration runs, `workerConfigFromLegacy` keeps the
 *   transitional path: if a voice call has no `ai_agent_id` yet on its
 *   channel, the call site can still pass `channelConfig` and we'll
 *   fold it in. After Phase 6 migrates, every voice channel carries
 *   an `ai_agent_id` and the channelConfig path goes unused - then
 *   gets deleted.
 *
 * What this shim is NOT:
 *   - It does NOT call the worker - that's up to the call site
 *   - It does NOT decide whether the feature flag is on - that's the
 *     call site's job (see `cutover-flag.ts`)
 */

import type {
  AIWorkerConfig,
  AIWorkerSessionProfile,
  AIWorkerMode,
} from "@chatcenter/shared";

// ─── Canonical input shape: the AIAgent row ─────────────────────

/**
 * Subset of `AIAgent` fields the shim reads. Loosely typed so we can
 * adapt to schema drift without coupling to the Prisma generated types.
 *
 * Post-Phase-6: every call site (chat, copilot, voice) hands us one of
 * these. Voice channels resolve their AIAgent via the new
 * `voice_channels.ai_agent_id` FK.
 */
export interface LegacyAgentRecord {
  id?: string;
  tenantId?: string;
  name?: string;
  // description field removed per spec - agent identity is fully
  // expressed through structured fields (role, persona, identity, etc.).
  tone?: string | null;
  persona?: unknown;
  identity?: unknown;
  /** Locale set on the agent (BCP-47 short code). */
  language?: string | null;
  /**
   * Skill IDs the operator picked for this employee. Phase 5 cutover
   * uses these to compose the prompt. Today's `AIAgent` schema doesn't
   * carry this column yet - call sites resolve a default skill set
   * from the employee's role/department until Phase 6 adds the column.
   */
  skillIds?: string[];
  /** Funnel pinned to this employee. */
  funnelId?: string | null;
}

/**
 * TRANSITIONAL - only used while voice channels still carry an
 * embedded `copilot_config` JSONB blob (pre Phase 6 migration). Once
 * the migration runs and `voice_channels.ai_agent_id` is populated,
 * call sites stop passing this and use `workerConfigFromAgent` instead.
 */
export interface LegacyVoiceChannelConfig {
  language?: string;
  persona?: string;
  goals?: string;
  funnelId?: string;
}

export interface ShimContext {
  sessionId: string;
  tenantId: string;
  conversationId?: string;
  contactId?: string;
  /** Optional customer snapshot to embed into SESSION_PROFILE. */
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
    channel?: string;
    externalId?: string;
  };
  /** Locale resolved by the call site (falls back to agent.language). */
  locale?: string;
  /** Pipeline snapshot from `resolvePipelineContext()`. */
  pipeline?: AIWorkerSessionProfile["pipeline"];
  /** Frozen BEL output (Phase 4 trade-off: snapshotted once per session). */
  behavior?: AIWorkerSessionProfile["behavior"];
}

// ─── Translation: canonical path (AIAgent only) ─────────────────

/**
 * Build an `AIWorkerConfig` from an `AIAgent` row and the runtime mode.
 *
 * This is the POST-MIGRATION canonical path. Every call site - chat,
 * copilot, and voice (after voice channels carry `ai_agent_id`) - uses
 * this. The voice-specific behavior comes entirely from `mode=callpilot`
 * + the skills the agent has configured; no separate voice config blob.
 *
 * Mode selection:
 *   - live-analysis-runner             → 'callpilot'
 *   - ai-bot.service autonomous turn   → 'autonomous'
 *   - ai-debug.ts / ai-assist.ts       → 'copilot'
 */
export function workerConfigFromAgent(args: {
  agent: LegacyAgentRecord;
  mode: AIWorkerMode;
  /**
   * Skill ids to compose. When the agent row carries `skillIds`, the
   * call site usually passes those through; the `mode` argument lets
   * call sites add mode-specific skills (e.g. `call_pilot_cues` for
   * voice) without mutating the persisted set.
   */
  skillIds: string[];
}): AIWorkerConfig {
  const tenantId = args.agent.tenantId ?? "__unknown__";
  const id = args.agent.id ?? `legacy:${tenantId}`;

  return {
    id,
    tenantId,
    identity: {
      name: args.agent.name ?? "Assistant",
      persona: typeof args.agent.persona === "string" ? args.agent.persona : undefined,
      language: args.agent.language ?? undefined,
    },
    mode: args.mode,
    skillIds: args.skillIds,
    funnelId: args.agent.funnelId ?? null,
    guardrails: {
      blockedTopics: [],
      escalationKeywords: [],
      refundRequiresApproval: true,
      customRules: [],
    },
    knowledgeBaseIds: [],
    metadata: {},
    isActive: true,
  };
}

// ─── Translation: transitional path (voice pre-migration) ───────

/**
 * Build an `AIWorkerConfig` for a voice call where the channel doesn't
 * yet carry an `ai_agent_id` FK (pre Phase 6 migration window).
 *
 * The caller passes the legacy `copilot_config` blob; we project it
 * onto an agent-like record so the worker sees the same shape.
 *
 * **Deleted in Phase 6 cleanup** - once every voice channel has been
 * migrated to reference an AIAgent, no caller ever takes this path.
 */
export function workerConfigFromLegacy(args: {
  mode: AIWorkerMode;
  agent: LegacyAgentRecord;
  channelConfig?: LegacyVoiceChannelConfig;
  skillIds: string[];
  funnelId?: string | null;
}): AIWorkerConfig {
  const tenantId = args.agent.tenantId ?? "__unknown__";
  const id = args.agent.id ?? `legacy:${tenantId}`;
  const language = args.channelConfig?.language ?? args.agent.language ?? undefined;
  const persona =
    args.channelConfig?.persona ??
    (typeof args.agent.persona === "string" ? args.agent.persona : undefined);

  return {
    id,
    tenantId,
    identity: {
      name: args.agent.name ?? "Assistant",
      persona,
      language,
    },
    mode: args.mode,
    skillIds: args.skillIds,
    funnelId: args.funnelId ?? args.channelConfig?.funnelId ?? args.agent.funnelId ?? null,
    guardrails: {
      blockedTopics: [],
      escalationKeywords: [],
      refundRequiresApproval: true,
      customRules: [],
    },
    knowledgeBaseIds: [],
    metadata: {},
    isActive: true,
  };
}

/**
 * Build a session profile from the call-site context.
 *
 * NO TIMESTAMPS land in the rendered profile (`session-profile-builder.ts`
 * drops them) - `capturedAt` is logged but not in the prefix.
 */
export function sessionProfileFromContext(ctx: ShimContext): AIWorkerSessionProfile {
  return {
    sessionId: ctx.sessionId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    customer: ctx.customer ?? {},
    pipeline: ctx.pipeline ?? {},
    behavior: ctx.behavior ?? {},
    capturedAt: new Date().toISOString(),
  };
}
