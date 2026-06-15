import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authenticate, resolveTenant, requireActiveTenant, publishEvent, prisma } from "@chatcenter/shared";
import { handleVoiceStream } from "../services/voice-assist.service";

// ─── Zod schemas ─────────────────────────────────────────────

const transcriptSchema = z.object({
  speaker: z.enum(["agent", "customer"]),
  text: z.string().max(5000),
  timestamp: z.number().int().positive(),
  isFinal: z.boolean(),
  confidence: z.number().min(0).max(1),
  seq: z.number().int().nonnegative(),
});

const voiceStreamBody = z.object({
  type: z.literal("voice_stream"),
  tenantId: z.string().min(1),
  conversationId: z.string().min(1),
  messages: z.array(transcriptSchema).min(1).max(20),
});

export type VoiceStreamBody = z.infer<typeof voiceStreamBody>;

// ─── Internal auth middleware ─────────────────────────────────
// Accepts both:
//   Authorization: Bearer {key}   (voice-copilot dispatcher uses this)
//   x-internal-key: {key}         (legacy internal-service pattern)

function internalAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const xKey = req.headers["x-internal-key"];

  let token: string | undefined;
  if (typeof xKey === "string" && xKey.length > 0) {
    token = xKey;
  } else if (typeof authHeader === "string" && authHeader.length > 0) {
    token = authHeader.replace(/^Bearer\s+/i, "");
  }

  const expected = process.env.INTERNAL_SERVICE_KEY || "chatcenter-internal-2026";
  if (!token || token !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const tenantHeader = req.headers["x-tenant-id"];
  if (!tenantHeader || typeof tenantHeader !== "string") {
    res.status(400).json({ error: "missing_tenant" });
    return;
  }

  (req as any).tenantId = tenantHeader;
  next();
}

// ─── Router ───────────────────────────────────────────────────

const router = Router();

router.post("/", internalAuth, async (req: Request, res: Response) => {
  const parsed = voiceStreamBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "malformed", details: parsed.error.issues });
    return;
  }
  await handleVoiceStream(parsed.data, (req as any).tenantId as string, req.headers, res);
});

// ─── /voice/start - agent-initiated outbound call context ──────
// User-authenticated. Records the call intent + notes so the co-pilot has
// context before any STT transcripts arrive.

const voiceStartBody = z.object({
  type: z.literal("voice_start"),
  conversationId: z.string().min(1),
  context: z.object({
    phone: z.string().min(3).max(32),
    notes: z.string().max(2000).nullable().optional(),
    contactName: z.string().max(200).nullable().optional(),
  }),
});

router.post(
  "/start",
  authenticate,
  resolveTenant,
  requireActiveTenant(),
  async (req: Request, res: Response) => {
    const parsed = voiceStartBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "malformed", details: parsed.error.issues });
      return;
    }
    const { conversationId, context } = parsed.data;
    try {
      // Ensure a Conversation row exists (tenant-scoped) so voice transcript
      // dispatch from voice-copilot can find it. Voice conversations are
      // created on-demand here - there's no inbound webhook for outbound calls.
      const existing = await prisma.conversation.findFirst({
        where: { id: conversationId, tenantId: req.tenantId! },
        select: { id: true },
      });
      if (!existing) {
        await prisma.conversation.create({
          data: {
            id: conversationId,
            tenantId: req.tenantId!,
            channel: "VOICE",
            customerExternalId: context.phone,
            customerName: context.contactName ?? null,
            assignedAgentId: req.user!.userId,
            status: "OPEN",
            lastMessageAt: new Date(),
          },
        });
      } else {
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: new Date(), assignedAgentId: req.user!.userId },
        });
      }

      await publishEvent({
        event: "voice.session.starting",
        tenantId: req.tenantId!,
        data: {
          conversationId,
          agentId: req.user!.userId,
          phone: context.phone,
          notes: context.notes ?? null,
          contactName: context.contactName ?? null,
          ts: Date.now(),
        },
      });
      res.status(202).json({ ok: true });
    } catch (err) {
      console.error("voice_start upsert/publish failed:", err);
      res.status(500).json({ error: "publish_failed" });
    }
  }
);

export default router;
