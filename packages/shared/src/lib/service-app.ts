import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { assertEnforcementConfigured } from "./billing/entitlement-gate";
import { initSentry } from "./observability/sentry";

export interface ServiceConfig {
  name: string;
  port: number;
  corsOrigin?: string;
  /**
   * Path prefixes that own their CORS entirely.
   *
   * The default policy below is written for the GOTCHA dashboard: one
   * fixed origin, credentials on. A surface that answers MANY third-party
   * origins (the Shopify storefront widget) needs the opposite, and it
   * cannot simply overwrite the headers afterwards - `cors()` also ENDS
   * the OPTIONS request itself, so a router mounted later never sees a
   * preflight at all and its origin checks are silently bypassed.
   */
  publicCorsPaths?: string[];
}

export function createServiceApp(config: ServiceConfig): express.Express {
  // Before any middleware. Sentry is wired HERE, in the shared factory, for the
  // same reason assertEnforcementConfigured lives in startService below: a step
  // every service has to remember is a step one service will not have, and the
  // service that forgets is the one whose outage nobody sees.
  //
  // No-op without a DSN, so development and tests are unaffected.
  initSentry(config.name);

  const app = express();

  // Trust proxy (nginx gateway) - required for express-rate-limit behind reverse proxy
  app.set("trust proxy", 1);

  app.use(helmet());

  const defaultCors = cors({
    origin: config.corsOrigin || process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  });
  const publicCorsPaths = config.publicCorsPaths ?? [];
  app.use((req, res, next) => {
    if (publicCorsPaths.some((p) => req.path.startsWith(p))) return next();
    return defaultCors(req, res, next);
  });

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

/**
 * Start listening, but not on a configuration that fails open.
 *
 * The billing enforcement check lives HERE rather than in each service's entry
 * point, because a check every service has to remember is a check one service
 * will not have - and the service that forgets becomes the way in. Anything
 * booting through startService gets it whether or not anyone thought about it.
 *
 * Only refuses in production. Development stacks routinely run unenforced and
 * should keep working.
 */
export function startService(app: express.Express, config: ServiceConfig): void {
  assertEnforcementConfigured();

  // Registered HERE and not in createServiceApp: an Express error handler only
  // catches errors from middleware registered BEFORE it, and every route is
  // added by the service after createServiceApp returns. startService is the
  // one shared point that runs once routes exist.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/node");
    if (typeof Sentry.setupExpressErrorHandler === "function") {
      Sentry.setupExpressErrorHandler(app);
    }
  } catch {
    /* no DSN, or SDK absent - the service still starts */
  }

  app.listen(config.port, () => {
    console.log(`[${config.name}] running on port ${config.port} (build ${process.env.BUILD_SHA || "dev"})`);
  });
}
