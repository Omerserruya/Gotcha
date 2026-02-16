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

  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: config.name,
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
    console.log(`[${config.name}] running on port ${config.port}`);
  });
}
