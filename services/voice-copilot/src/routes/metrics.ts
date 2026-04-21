import { Router, Request, Response } from "express";
import type { Registry } from "prom-client";

export function createMetricsRouter(registry: Registry): Router {
  const router = Router();

  router.get("/metrics", async (_req: Request, res: Response) => {
    res.set("Content-Type", registry.contentType);
    res.send(await registry.metrics());
  });

  return router;
}
