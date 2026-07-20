import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

export interface ServiceConfig {
  name: string;
  port: number;
  corsOrigin?: string;
}

export function createServiceApp(config: ServiceConfig): express.Express {
  const app = express();

  // Trust proxy (nginx gateway) - required for express-rate-limit behind reverse proxy
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({
    origin: config.corsOrigin || process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api/", limiter);

  // Capture the raw request body so provider webhooks (e.g. iCount) can verify
  // HMAC signatures over the EXACT bytes received. JSON.stringify(req.body) is
  // NOT byte-identical (key order / whitespace), so without this the signature
  // check would always fail in production.
  app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

  // Health check. `build` is the image's BUILD_SHA (git SHA injected at
  // docker build time) - the ground truth for "which code is this container
  // actually running". Deploy verification reads this instead of trusting
  // that a rebuild wasn't served from a stale cache layer.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: config.name,
      build: process.env.BUILD_SHA || "dev",
      timestamp: new Date().toISOString(),
    });
  });

  // Error handler
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[${config.name}] Unhandled error:`, err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

export function startService(app: express.Express, config: ServiceConfig): void {
  app.listen(config.port, () => {
    console.log(`[${config.name}] running on port ${config.port} (build ${process.env.BUILD_SHA || "dev"})`);
  });
}
