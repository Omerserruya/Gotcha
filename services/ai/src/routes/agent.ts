/**
 * /api/agent - System Copilot HTTP surface.
 *
 *   POST /api/agent/run    → SSE stream of AgentRuntimeEvent (the loop)
 *   POST /api/agent/clear  → wipe memory for this operator
 *
 * The streaming endpoint accepts JSON in the request body (NOT query
 * params) so we can attach the operator's context payload. The response
 * is `text/event-stream` with discriminated events the frontend
 * deserialises into typed turn updates.
 */

import { Router, Request, Response } from "express";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  prisma,
} from "@chatcenter/shared";
import { runAgent, AgentRuntimeEvent } from "../services/agent-runtime.service";
import { clearAgentMemory } from "../services/agent-memory.service";

const router = Router();

router.use(authenticate, resolveTenant, requireActiveTenant());

router.post("/run", async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const userId = ((req as any).user?.userId ?? (req as any).user?.id) as string | undefined;
  if (!userId) {
    res.status(401).json({ error: "no user context" });
    return;
  }

  const { message, sessionId, client, model, ephemeral, aiAgentId } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message (non-empty string) is required" });
    return;
  }
  if (typeof sessionId !== "string" || !sessionId) {
    res.status(400).json({ error: "sessionId (string) is required" });
    return;
  }

  // Pull the operator's identity for the context block. Cheap query,
  // tolerant of missing fields.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, tenantId: true },
  });
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true },
  }).catch(() => null);

  // SSE headers. `X-Accel-Buffering: no` defeats nginx's default buffering;
  // without it tokens land in the browser only after the loop finishes.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => { closed = true; });

  const send = (ev: AgentRuntimeEvent) => {
    if (closed) return;
    res.write(`event: ${ev.type}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  // Heartbeat: nginx's default 60s read-timeout will close idle SSE
  // connections. Send a comment line every 25s so the proxy stays
  // happy on long tool runs.
  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(": ping\n\n");
  }, 25_000);

  try {
    await runAgent(
      {
        operator: {
          tenantId,
          userId,
          userName: user?.name,
          userEmail: user?.email,
          userRole: user?.role,
          tenantName: tenant?.name,
        },
        client: client ?? null,
        message: message.trim(),
        sessionId,
        model,
        ephemeral: !!ephemeral,
        aiAgentId: aiAgentId ?? null,
        authToken: (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || undefined,
      },
      send,
    );
  } catch (err: any) {
    send({ type: "error", message: err?.message || "agent run failed" });
  } finally {
    clearInterval(heartbeat);
    if (!closed) {
      res.write("event: close\ndata: {}\n\n");
      res.end();
    }
  }
});

router.post("/clear", async (req: Request, res: Response) => {
  const tenantId = req.tenantId!;
  const userId = ((req as any).user?.userId ?? (req as any).user?.id) as string | undefined;
  if (!userId) {
    res.status(401).json({ error: "no user context" });
    return;
  }
  const removed = await clearAgentMemory({ tenantId, userId });
  res.json({ removed });
});

export default router;
