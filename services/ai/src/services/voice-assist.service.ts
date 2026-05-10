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
import { prisma, getRedis } from "@chatcenter/shared";
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

// Phase 4: scheduleAssistTrigger + triggerAssist removed. The Conversation
// Intelligence Engine (services/ai/src/services/intelligence/) is now the
// only AI consumer of voice transcripts. The HTTP path below remains for
// message persistence; AI assist runs from the supervisor on the bus.

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
