import { Router, Request, Response } from "express";
import type { Redis } from "ioredis";
import {
  authenticate,
  resolveTenant,
  requireActiveTenant,
  requireRole,
} from "@chatcenter/shared";
import type { Logger } from "../lib/logger";

export interface LiveDeps {
  redis: Redis;
  logger: Logger;
}

export function createLiveRouter(deps: LiveDeps): Router {
  const router = Router();

  router.get(
    "/",
    authenticate,
    resolveTenant,
    requireActiveTenant(),
    requireRole("ADMIN"),
    async (req: Request, res: Response): Promise<void> => {
      const tenantId = req.tenantId as string;
      const pattern = `voice:tenant:${tenantId}:conversation:*`;

      const rows: object[] = [];
      let cursor = "0";
      const now = Date.now();

      do {
        const result = await deps.redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          100
        );
        cursor = result[0];
        for (const key of result[1]) {
          const h = await deps.redis.hgetall(key);
          if (!h || Object.keys(h).length === 0) continue;
          if (h.state === "ended") continue;
          const conversationId = key.split(":").pop() ?? "";
          rows.push({
            callSid: h.callSid ?? null,
            conversationId,
            agentId: h.agentId || null,
            state: h.state ?? null,
            durationMs: now - parseInt(h.startedAt || "0", 10),
            lastTranscriptLatencyMs: now - parseInt(h.lastFrameAt || "0", 10),
            reconnectCount: parseInt(h.reconnectCount || "0", 10),
            framesReceived: parseInt(h.framesReceived || "0", 10),
            framesDropped: parseInt(h.framesDropped || "0", 10),
          });
          if (rows.length >= 100) break;
        }
      } while (cursor !== "0" && rows.length < 100);

      res.json({ data: rows });
    }
  );

  return router;
}
