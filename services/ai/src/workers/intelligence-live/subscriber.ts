/**
 * Live intelligence subscriber - Customer Intelligence V2, Phase 2.
 *
 * Subscribes to `message:new` and runs the lean live extractor on OPEN text
 * conversations, folding discovered fields into the V2 model in real time
 * (source=llm_live). This is the text-channel equivalent of the voice
 * LiveAnalysisRunner (architecture §15).
 *
 * Cost discipline:
 *   - Debounce: wait DEBOUNCE_MS of quiet before extracting (one call per
 *     burst, not per message).
 *   - Min-new-content gate: only run once at least MIN_NEW_INBOUND new customer
 *     messages have arrived since the last extraction for that conversation.
 *   - Skips VOICE (own pipeline) and closed conversations.
 *   - Disabled entirely when INTELLIGENCE_LIVE_EXTRACT=off.
 */

import { prisma, subscribeToEvents, type ServiceEvent } from "@chatcenter/shared";
import { getExtractionFieldSpecs } from "../../services/post-conversation-config.service";
import { extractFieldsLive, type ExtractionFieldSpec } from "../../services/intelligence-live-extract.service";
import { ingestConversationFacts } from "../../services/intelligence-ingest.service";
import { requiredKnowledgeFor } from "../../services/skills";

const DEBOUNCE_MS = Number(process.env.INTELLIGENCE_LIVE_DEBOUNCE_MS || 20_000);
const MIN_NEW_INBOUND = Number(process.env.INTELLIGENCE_LIVE_MIN_INBOUND || 2);

let _sub: ReturnType<typeof subscribeToEvents> | null = null;
let _started = false;

interface PendingState {
  timer: NodeJS.Timeout;
  tenantId: string;
  newInbound: number;
}
const pending = new Map<string, PendingState>();

function enabled(): boolean {
  return (process.env.INTELLIGENCE_LIVE_EXTRACT || "on").toLowerCase() !== "off";
}

async function runExtraction(conversationId: string, tenantId: string): Promise<void> {
  // Re-check the conversation is still an open text channel before spending an
  // LLM call. (It may have closed during the debounce window.)
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { status: true, channel: true, assignedAiAgentId: true },
  });
  if (!conv) return;
  if ((conv.channel as unknown as string) === "VOICE") return;
  if (String(conv.status) === "CLOSED" || String(conv.status) === "RESOLVED") return;

  // Tenant-configured extraction specs PLUS the assigned agent's skill
  // required-knowledge keys (business_type, pain_points, current_tools, …).
  // Without the skill keys the extractor never captures the facts the Objective
  // Engine needs, so objectives stay stuck even after the customer answers.
  const specs = await getExtractionFieldSpecs(tenantId);
  const merged = await mergeSkillSpecs(specs, conv.assignedAiAgentId);
  const fields = await extractFieldsLive({ tenantId, conversationId, fields: merged });
  if (!fields.length) return;

  const res = await ingestConversationFacts({
    tenantId, conversationId, fields, source: "llm_live",
  });
  console.log(`[intel-live] conv=${conversationId} extracted=${fields.length} written=${res.written} reviewed=${res.reviewed} opp=${res.opportunityId ? 1 : 0}`);
}

/**
 * Merge the assigned agent's Skill required-knowledge keys into the extraction
 * specs so the live extractor always captures the facts the Objective Engine
 * needs (business_type, pain_points, current_tools, …), regardless of whether
 * the tenant configured a field registry. A tenant-configured spec for the same
 * key wins (keeps its richer description/examples). Fail-soft: any error
 * returns the original specs.
 */
async function mergeSkillSpecs(
  specs: ExtractionFieldSpec[],
  aiAgentId: string | null | undefined,
): Promise<ExtractionFieldSpec[]> {
  if (!aiAgentId) return specs;
  try {
    const agent = await (prisma as any).aiAgent.findUnique({
      where: { id: aiAgentId },
      select: { role: true },
    });
    const required = requiredKnowledgeFor(agent?.role);
    if (!required.length) return specs;
    const have = new Set(specs.map((s) => s.key));
    const additions: ExtractionFieldSpec[] = required
      .filter((f) => !have.has(f.key))
      .map((f) => ({ key: f.key, label: f.label ?? null, description: null }));
    return additions.length ? [...specs, ...additions] : specs;
  } catch {
    return specs;
  }
}

function schedule(conversationId: string, tenantId: string, isInbound: boolean): void {
  const existing = pending.get(conversationId);
  const newInbound = (existing?.newInbound ?? 0) + (isInbound ? 1 : 0);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    const state = pending.get(conversationId);
    pending.delete(conversationId);
    if (!state) return;
    if (state.newInbound < MIN_NEW_INBOUND) return; // not enough new customer content
    runExtraction(conversationId, tenantId).catch((err) => {
      console.warn(`[intel-live] extraction failed conv=${conversationId}:`, err?.message ?? err);
    });
  }, DEBOUNCE_MS);
  // Don't keep the event loop alive on this timer.
  if (typeof timer.unref === "function") timer.unref();

  pending.set(conversationId, { timer, tenantId, newInbound });
}

async function handleMessage(evt: ServiceEvent): Promise<void> {
  if (evt.event !== "message:new") return;
  if (!enabled()) return;
  const data = (evt.data ?? {}) as { conversationId?: string; channel?: string; message?: { direction?: string } };
  const conversationId = data.conversationId;
  const tenantId = evt.tenantId;
  if (!conversationId || !tenantId) return;
  if ((data.channel ?? "").toUpperCase() === "VOICE") return;

  const isInbound = (data.message?.direction ?? "").toUpperCase() === "INBOUND";
  schedule(conversationId, String(tenantId), isInbound);
}

export function startIntelligenceLiveSubscriber(): void {
  if (_started) return;
  if (!enabled()) {
    console.log("[intel-live] disabled (INTELLIGENCE_LIVE_EXTRACT=off)");
    return;
  }
  _started = true;
  try {
    _sub = subscribeToEvents((evt: ServiceEvent) => {
      handleMessage(evt).catch((err) => {
        console.warn("[intel-live.subscriber] handler error:", (err as { message?: string })?.message ?? err);
      });
    });
    console.log(`[intel-live] subscriber started (message:new, debounce=${DEBOUNCE_MS}ms, minInbound=${MIN_NEW_INBOUND})`);
  } catch (err) {
    console.warn("[intel-live.subscriber] subscribe failed:", (err as { message?: string })?.message);
  }
}

export async function stopIntelligenceLiveSubscriber(): Promise<void> {
  for (const [, s] of pending) clearTimeout(s.timer);
  pending.clear();
  if (_sub) {
    try { await _sub.quit(); } catch { /* ignore */ }
    _sub = null;
  }
  _started = false;
}
