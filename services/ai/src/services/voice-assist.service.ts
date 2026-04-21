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
import { getEffectiveCopilotConfig, getSuggestions, ConversationContext } from "./ai-assist.service";
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

// ─── Debounce state ───────────────────────────────────────────

// Map of `${tenantId}:${conversationId}` → version (Date.now())
// Kept in-process; works correctly within a single service instance.
// For multi-instance deployments the Redis key is the authoritative source.
const debounceVersions = new Map<string, number>();

// ─── scheduleAssistTrigger ────────────────────────────────────
// Debounces copilot trigger: if another customer final arrives within
// 1500 ms, the previous timer is voided (version mismatch) and a new
// one is set.  The Redis key `voice:assist:debounce:{t}:{c}` stores
// the latest version so timers that fire late detect the staleness.

async function scheduleAssistTrigger(tenantId: string, conversationId: string, delayMs = 1500): Promise<void> {
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

// ─── triggerAssist ────────────────────────────────────────────
// Calls the existing ai-assist getSuggestions flow so the copilot
// panel refreshes after a customer final utterance.
//
// Path taken:
//   1. Load conversation + recent messages from DB
//   2. getEffectiveCopilotConfig (same call as the suggestions route)
//   3. getSuggestions — fires the AI provider
//   4. publishEvent("voice.copilot.suggestions") so the WS layer
//      can push results to the agent UI without a poll.
//
// If no copilot config is found we still publish the event (with
// empty suggestions) so the frontend knows the request was processed.

async function triggerAssist(tenantId: string, conversationId: string): Promise<void> {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conversation) return;

    const messages = await prisma.message.findMany({
      where: { conversationId, tenantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { direction: true, body: true, senderName: true, createdAt: true },
    });

    const copilotConfig = await getEffectiveCopilotConfig(tenantId, (conversation as any).departmentId);

    let suggestions: any[] = [];
    if (copilotConfig) {
      const context: ConversationContext = {
        tenantId,
        conversationId,
        customerName: conversation.customerName || undefined,
        messages: messages
          .reverse()
          .map((m: any) => ({
            direction: m.direction,
            body: m.body,
            senderName: m.senderName || undefined,
            createdAt: m.createdAt.toISOString(),
          })),
        copilotConfig,
      };
      suggestions = await getSuggestions(context);
    }

    await publishEvent({
      event: "voice.copilot.suggestions",
      tenantId,
      data: { conversationId, suggestions },
    } as any);
  } catch (err) {
    console.error("[voice-assist] triggerAssist error:", err);
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

  // 3. Conversation ownership check (scoped to tenant — don't leak existence)
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
        // Message.metadata is Json? — use it for voice-specific fields
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

  // 6. Debounced assist trigger: fires only on customer finals in persistList
  const hasCustomerFinal = persistList.some(
    (m: TranscriptMsg) => m.speaker === "customer" && m.isFinal,
  );
  if (hasCustomerFinal) {
    // Fire-and-forget; errors logged inside scheduleAssistTrigger
    scheduleAssistTrigger(tenantId, conversationId, 1500).catch((err) =>
      console.error("[voice-assist] scheduleAssistTrigger rejection:", err),
    );
  }

  // 7. Respond
  res.status(200).json({
    ok: true,
    processed: persistList.length,
    deduped: messages.length - persistList.length,
  });
}
