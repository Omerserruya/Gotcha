import { prisma, parseCopilotConfig } from "@chatcenter/shared";
import { loadFunnelForTenant, loadFunnelById } from "../funnel-config.repo";
import type { FunnelConfig, FunnelStage } from "../funnel-config.service";

/**
 * Resolve the active pipeline stage for a conversation.
 *
 * Lookup chain (CRM is authority — see CLAUDE.md "Services = Truth"):
 *   1. Fetch the customer's vendor CRM record (already-cached via
 *      crm-identity service / contact.metadata.crmContactId).
 *   2. Read the vendor's stage value (HubSpot lifecyclestage, Zoho Stage,
 *      Salesforce LeadStatus, etc.) from the cached CrmContactSummary on
 *      contact.metadata.crmStageCache.value when present.
 *   3. Match it against the active TenantFunnel.stages[].crmValue.
 *   4. Fall back to the funnel's FIRST stage when nothing matches (new
 *      contact / vendor stage outside the configured funnel).
 *   5. Return null when no funnel is configured for the tenant/department.
 *
 * Funnel precedence (most-specific wins):
 *   1. Conversation's assigned AI agent (`ai_agents.funnel_id`) — lets a
 *      tenant pin a funnel directly to an AI Employee.
 *   2. Voice-channel override (`voice_channels.copilot_config.funnelId`)
 *      — different funnel per phone number.
 *   3. Department-scoped funnel.
 *   4. Tenant-default funnel.
 *
 * Pure-read, fail-soft: any error returns null so the live runner can
 * fall back to the channel-level copilot config.
 */

export interface ResolvedStage {
  funnel: FunnelConfig;
  stage: FunnelStage;
  /** Where the active stage was sourced from — useful for diagnostics. */
  source: "crm-match" | "crm-fallback-first" | "no-crm";
  /** The raw vendor stage value (when we read one). */
  vendorStage: string | null;
  /** The next stage to advance to, resolved from `copilot.nextStageId`. */
  nextStage: FunnelStage | null;
}

export interface ResolveStageArgs {
  tenantId: string;
  conversationId: string;
  departmentId?: string | null;
}

export async function resolveActiveStage(
  args: ResolveStageArgs,
): Promise<ResolvedStage | null> {
  try {
    // Funnel lookup precedence (most-specific wins):
    //   1. Assigned AI agent's funnel (ai_agents.funnel_id).
    //   2. Voice-channel override (voice_channels.copilot_config.funnelId)
    //      — lets a tenant run different funnels per phone number.
    //   3. Department-scoped funnel.
    //   4. Tenant-default funnel.
    let funnel: FunnelConfig | null = null;
    const agentFunnelId = await readAgentFunnelOverride(
      args.tenantId,
      args.conversationId,
    );
    if (agentFunnelId) {
      funnel = await loadFunnelById({
        tenantId: args.tenantId,
        funnelDbId: agentFunnelId,
      });
    }
    if (!funnel) {
      const channelFunnelId = await readChannelFunnelOverride(
        args.tenantId,
        args.conversationId,
      );
      if (channelFunnelId) {
        funnel = await loadFunnelById({
          tenantId: args.tenantId,
          funnelDbId: channelFunnelId,
        });
      }
    }
    if (!funnel) {
      funnel = await loadFunnelForTenant({
        tenantId: args.tenantId,
        departmentId: args.departmentId ?? null,
      });
    }
    if (!funnel || funnel.stages.length === 0) return null;

    const vendorStage = await readVendorStageForConversation(
      args.tenantId,
      args.conversationId,
    );

    let stage: FunnelStage | null = null;
    let source: ResolvedStage["source"] = "no-crm";

    if (vendorStage) {
      const matched = funnel.stages.find(
        (s) => s.crmValue && s.crmValue.toLowerCase() === vendorStage.toLowerCase(),
      );
      if (matched) {
        stage = matched;
        source = "crm-match";
      }
    }

    if (!stage) {
      // Fall back to first stage when CRM has no value yet or the value
      // doesn't match a configured stage. Conservative: don't guess.
      stage = funnel.stages[0]!;
      source = vendorStage ? "crm-fallback-first" : "no-crm";
    }

    const nextStage = resolveNextStage(funnel, stage);

    return { funnel, stage, source, vendorStage, nextStage };
  } catch (err) {
    console.warn(
      "[stage-resolver] failed:",
      (err as { message?: string })?.message ?? err,
    );
    return null;
  }
}

/**
 * Given a stage, return the stage it should advance to. Prefers the
 * explicit `copilot.nextStageId` reference; falls back to the first
 * outgoing transition; returns null when no successor is configured.
 */
export function resolveNextStage(
  funnel: FunnelConfig,
  current: FunnelStage,
): FunnelStage | null {
  const explicitId = current.copilot?.nextStageId;
  if (explicitId) {
    const explicit = funnel.stages.find((s) => s.id === explicitId);
    if (explicit) return explicit;
  }
  const outgoing = (funnel.transitions || []).find((t) => t.from === current.id);
  if (outgoing) {
    const dest = funnel.stages.find((s) => s.id === outgoing.to);
    if (dest) return dest;
  }
  return null;
}

/**
 * Read the funnel pinned to the conversation's assigned AI agent.
 * Returns TenantFunnel.id (cuid) or null. Highest precedence in the
 * resolver chain — set on the agent editor at /ai-studio/agents/[id].
 */
async function readAgentFunnelOverride(
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    const conv = await (prisma as any).conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { assignedAiAgentId: true },
    });
    const agentId = conv?.assignedAiAgentId;
    if (!agentId) return null;
    const agent = await (prisma as any).aIAgent.findFirst({
      where: { id: agentId, tenantId },
      select: { funnelId: true },
    });
    const id = agent?.funnelId;
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Read the voice-channel's funnel override (when set on copilot_config).
 * Returns the TenantFunnel.id (cuid) or null. We resolve the channel via
 * the latest VoiceCallSession for this conversation — same chain
 * copilot-config-loader uses.
 */
async function readChannelFunnelOverride(
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    const session = await (prisma as any).voiceCallSession.findFirst({
      where: { conversationId, tenantId },
      select: { channelId: true },
      orderBy: { startedAt: "desc" },
    });
    if (!session?.channelId) return null;
    const voiceChannel = await (prisma as any).voiceChannel.findFirst({
      where: { communicationChannelId: session.channelId },
      select: { copilotConfig: true },
    });
    if (!voiceChannel) return null;
    const cfg = parseCopilotConfig(voiceChannel.copilotConfig);
    const id = (cfg as any).funnelId;
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Read the vendor CRM stage value cached on the local Contact's metadata.
 * The crm-panel route writes it on every fetchCrmContext call.
 *
 * We do NOT call the vendor adapter directly here — the BEL must stay
 * cheap and we already paid the round-trip when the workspace opened.
 */
async function readVendorStageForConversation(
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
      select: { channel: true, customerExternalId: true },
    });
    if (!conv?.customerExternalId) return null;
    const contact = await prisma.contact.findFirst({
      where: {
        tenantId,
        channel: conv.channel as any,
        externalId: conv.customerExternalId,
      },
      select: { metadata: true },
    });
    const meta = (contact?.metadata ?? {}) as Record<string, unknown>;
    const cache = meta?.["crmStageCache"] as
      | { value?: string | null; cachedAt?: string }
      | undefined;
    const value = cache?.value;
    if (typeof value === "string" && value.trim()) return value.trim();
    return null;
  } catch {
    return null;
  }
}
