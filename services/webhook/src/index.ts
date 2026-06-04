import { createServiceApp, startService } from "@chatcenter/shared";
import express from "express";
import webhookRoutes from "./routes/webhook";
import triggerRoutes from "./routes/triggers";

const config = { name: "webhook-service", port: parseInt(process.env.PORT || "4003", 10) };
const app = createServiceApp(config);

// Override body parser for webhook - capture raw body for signature verification
// Remove default json parser for /api/webhook and add one with raw body capture
app.use("/api/webhook", express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Routes
app.use("/api/webhook", webhookRoutes);

// Generic inbound webhook triggers (POST /webhooks/:token). Mounted at its own
// prefix — separate from the per-provider handlers above — so it fronts the
// WebhookTrigger model without touching existing provider routing. Uses the
// global express.json() parser from createServiceApp (no raw-body needed: this
// route does basic header-secret auth, not HMAC signature verification).
app.use("/webhooks", triggerRoutes);

// NOTE: Incoming message worker has been extracted to @chatcenter/incoming-worker service
// for independent scaling. This service is now HTTP-only (handler -> queue pattern).

startService(app, config);
export { app };
