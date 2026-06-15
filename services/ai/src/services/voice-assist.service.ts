/**
 * voice-assist.service.ts
 *
 * Handles a validated voice_stream payload:
 *   1. Cross-tenant guard
 *   2. Top-level idempotency (X-Idempotency-Key)
 *   3. Conversation ownership check
 *   4. Per-message dedupe via Redis NX pipeline
 *   5. Persist new messages to DB
 *   6. Debounced assist trigger on customer final utterances
 *   7. Respond with {ok, processed, deduped}
 *
 * Spec reference: §9, §15 R11
 */

import { Response } from "express";
import { IncomingHttpHeaders } from "http";
import { prisma, publishEvent, getRedis } from "@chatcenter/shared";
import { getEffectiveCopilotConfig, getSuggestions, type ConversationContext } from "./ai-assist.service";
import { loadCustomerContext } from "./memory/customer-context.service";
import { beginTurn, isAbortError } from "./turn-cancellation.service";
import type { VoiceStreamBody } from "../routes/ai-assist-voice";

// ─── Types ────────────────────────────────────────────────────

interface TranscriptMsg {
  speaker: "agent" | "customer";
  text: string;
  timestamp: number;
  isFinal: boolean;
  confidence: number;
  seq: number;
}

// Phase 4 supervisor (services/ai/src/services/intelligence/) is the new
// structured-frame consumer of voice transcripts. The legacy suggestions
// pipeline below was deleted with Phase 4 but its replacement turned out
// to be incomplete - the frontend kept showing zero copilot suggestions.
// Restored as a safety net: scheduleAssistTrigger fires the chat-shaped
// suggestions on every customer final utterance and publishes them as
// `voice.copilot.suggestions`. The Phase 4 supervisor keeps running in
// parallel and emits structured frames as `voice.frame.updated`.

// ─── Debounce state ───────────────────────────────────────────

// Map of `${tenantId}:${conversationId}` → version (Date.now())
// Kept in-process; works correctly within a single service instance.
// For multi-instance deployments the Redis key is the authoritative source.
const debounceVersions = new Map<string, number>();

/**
 * Debounce copilot trigger so rapid customer finals collapse into one
 * AI call. If another final arrives within `delayMs`, the previous timer
 * is voided (version mismatch in Redis) and a new one is set.
 */
export async function scheduleAssistTrigger(
  tenantId: string,
  conversationId: string,
  delayMs = 1500,
): Promise<void> {
  const redis = getRedis();
  const debounceKey = `voice:assist:debounce:${tenantId}:${conversationId}`;
  const ver = Date.now();
  debounceVersions.set(`${tenantId}:${conversationId}`, ver);

  // Overwrite (no NX) to extend the debounce window on rapid finals.
  await redis.set(debounceKey, ver.toString(), "EX", 2);

  setTimeout(async () => {
    try {
      const cur = await redis.get(debounceKey);
      if (cur !== String(ver)) return; // superseded by a newer trigger
      await redis.del(debounceKey);
      debounceVersions.delete(`${tenantId}:${conversationId}`);
      await triggerAssist(tenantId, conversationId);
    } catch (err) {
      console.error("[voice-assist] debounced trigger error:", err);
    }
  }, delayMs);
}

/**
 * Call the chat-shaped getSuggestions pipeline and publish the result so
 * the frontend's `voice.copilot.suggestions` listener fires. We log the
 * suggestion count + duration so it's grep-able when debugging silent
 * copilot panels.
 */
async function triggerAssist(tenantId: string, conversationId: string): Promise<void> {
  const t0 = Date.now();
  // The debounce above collapses rapid finals into ONE scheduled trigger,
  // but a slow LLM round can still be in-flight when the next debounced
  // trigger fires. beginTurn() aborts the prior trigger's fetch so we
  // don't end up publishing stale suggestions over fresh ones.
  const turn = beginTurn(tenantId, conversationId, "copilot");
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conversation) {
      console.warn(`[voice-assist] triggerAssist: conversation ${conversationId} not found`);
      return;
    }

    const messages = await prisma.message.findMany({
      where: { conversationId, tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { direction: true, body: true, senderName: true, createdAt: true },
    });

    const copilotConfig = await getEffectiveCopilotConfig(tenantId, (conversation as any).departmentId);

    // Effective locale for the live copilot. The hints are for the AGENT,
    // so we resolve the assigned agent's per-user override first; falling
    // back to Tenant.defaultLocale if unset. openai.provider injects a
    // "Respond in <language>" line into the suggest prompt whenever this
    // is non-"en", so without this the live cues come back in English even
    // when the agent has switched the UI to Hebrew.
    let locale: string | undefined;
    try {
      const assignedAgentId = (conversation as any).assignedAgentId as string | null;
      if (assignedAgentId) {
        const agent = await prisma.user.findUnique({
          where: { id: assignedAgentId },
          select: { locale: true },
        });
        if (agent?.locale) locale = agent.locale;
      }
      if (!locale) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { defaultLocale: true },
        });
        if (tenant?.defaultLocale) locale = tenant.defaultLocale;
      }
    } catch (err) {
      console.warn("[voice-assist] locale resolution failed (non-fatal):", err);
    }

    let suggestions: any[] = [];
    if (copilotConfig) {
      // Load the cross-channel customer-memory bundle (open issues, recent
      // summaries across channels, CRM notes, sentiment trend). Fail-soft -
      // a missing CRM link / vendor hiccup must NOT block copilot suggestions.
      const memoryBundle = await loadCustomerContext({ tenantId, conversationId }).catch(() => null);
      const customerMemory = memoryBundle
        ? {
            openIssues: memoryBundle.open_issues.map((i) => ({
              subject: i.subject,
              status: i.status,
              priority: i.priority,
              due_at: i.due_at,
            })),
            recentSummaries: memoryBundle.recent_summaries
              .filter((s) => !s.isCurrentConversation)
              .map((s) => ({
                channel: s.channel,
                summary: s.summary,
                sentiment: s.sentiment,
                qualification: s.qualification,
                occurredAt: s.occurredAt,
              })),
            recentCrmNotes: memoryBundle.recent_crm_notes.map((n) => ({
              body: n.body,
              occurred_at: n.occurred_at,
            })),
            sentimentTrend: memoryBundle.sentiment_trend,
          }
        : undefined;

      const context: ConversationContext = {
        tenantId,
        conversationId,
        customerName: conversation.customerName || undefined,
        messages: messages.reverse().map((m: any) => ({
          direction: m.direction,
          body: m.body,
          senderName: m.senderName || undefined,
          createdAt: m.createdAt.toISOString(),
        })),
        copilotConfig,
        customerMemory,
        locale,
        signal: turn.signal,
      };
      suggestions = await getSuggestions(context);
    } else {
      console.warn(`[voice-assist] triggerAssist: no copilot config for tenant ${tenantId}`);
    }

    await publishEvent({
      event: "voice.copilot.suggestions",
      tenantId,
      data: { conversationId, suggestions },
    } as any);
    console.log(
      `[voice-assist] triggerAssist ok conv=${conversationId} suggestions=${suggestions.length} ms=${Date.now() - t0}`,
    );
  } catch (err) {
    if (isAbortError(err)) {
      console.log(`[voice-assist] triggerAssist aborted conv=${conversationId} (superseded by newer turn)`);
    } else {
      console.error("[voice-assist] triggerAssist error:", err);
    }
  } finally {
    turn.end();
  }
}

// ─── handleVoiceStream ────────────────────────────────────────

export async function handleVoiceStream(
  body: VoiceStreamBody,
  tenantIdFromHeader: string,
  headers: IncomingHttpHeaders,
  res: Response,
): Promise<void> {
  const redis = getRedis();
  const { tenantId, conversationId, messages } = body;

  // 1. Cross-tenant guard
  if (tenantId !== tenantIdFromHeader) {
    res.status(403).json({ error: "cross_tenant_denied" });
    return;
  }

  // 2. Top-level idempotency via X-Idempotency-Key header
  const idemKey = headers["x-idempotency-key"];
  if (typeof idemKey === "string" && idemKey.length > 0) {
    const claimed = await redis.set(
      `aiassist:voice:idem:${idemKey}`,
      "1",
      "EX",
      3600,
      "NX",
    );
    if (claimed === null) {
      // Already processed this request
      res.status(200).json({ ok: true, processed: 0, deduped: messages.length });
      return;
    }
  }

  // 3. Conversation ownership check (scoped to tenant - don't leak existence)
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
  });
  if (!conversation) {
    res.status(403).json({ error: "cross_tenant_denied" });
    return;
  }

  // 4. Per-message dedupe via Redis pipeline
  //    Key pattern: aiassist:voice:msg:{tenantId}:{conversationId}:{speaker}:{seq}
  const dedupeKeys = messages.map(
    (m: TranscriptMsg) => `aiassist:voice:msg:${tenantId}:${conversationId}:${m.speaker}:${m.seq}`,
  );

  const pipeline = redis.pipeline();
  for (const key of dedupeKeys) {
    pipeline.set(key, "1", "EX", 3600, "NX");
  }
  const pipelineResults = await pipeline.exec();

  // Filter to messages whose dedupe key was newly claimed (result === "OK")
  const persistList: TranscriptMsg[] = [];
  if (pipelineResults) {
    for (let i = 0; i < messages.length; i++) {
      const [err, result] = pipelineResults[i] as [Error | null, string | null];
      if (!err && result === "OK") {
        persistList.push(messages[i]);
      }
    }
  }

  // 5. Persist claimed messages
  if (persistList.length > 0) {
    await prisma.message.createMany({
      data: persistList.map((m: TranscriptMsg) => ({
        tenantId,
        conversationId,
        channel: "VOICE" as any,
        direction: (m.speaker === "agent" ? "OUTBOUND" : "INBOUND") as any,
        body: m.text,
        messageType: m.isFinal ? "voice_final" : "voice_partial",
        status: "DELIVERED" as any,
        // Message.metadata is Json? - use it for voice-specific fields
        metadata: {
          voice: {
            seq: m.seq,
            confidence: m.confidence,
            timestamp: m.timestamp,
          },
        },
      })),
    });
  }

  // 6. Assist trigger is owned by voice-copilot-subscriber (pub/sub path).
  //    The HTTP dispatcher path persists only; triggering here would schedule
  //    twice per final (Redis debounce collapses to one execution, but the
  //    extra timer is wasted work).

  // 7. Respond
  res.status(200).json({
    ok: true,
    processed: persistList.length,
    deduped: messages.length - persistList.length,
  });
}
