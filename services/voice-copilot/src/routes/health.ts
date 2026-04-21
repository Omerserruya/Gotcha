import { Router, Request, Response } from "express";
import type { Redis } from "ioredis";

export interface HealthDeps {
  redis: Redis;
  ready: () => boolean;
}

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/readyz", async (_req: Request, res: Response) => {
    if (!deps.ready()) {
      res.status(503).json({ ready: false });
      return;
    }
    try {
      const pingResult = await Promise.race([
        deps.redis.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Redis ping timeout")), 300)
        ),
      ]);
      if (pingResult === "PONG") {
        res.status(200).json({ ready: true });
      } else {
        res.status(503).json({ ready: false });
      }
    } catch {
      res.status(503).json({ ready: false });
    }
  });

  return router;
}
