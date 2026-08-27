import { createServiceApp, startService } from "@chatcenter/shared";
import express from "express";
import webhookRoutes from "./routes/webhook";
import triggerRoutes from "./routes/triggers";
import triggerAdminRoutes from "./routes/trigger-admin";

// jsonLimit: the SHARED app factory mounts a global express.json() ahead of the
// route-specific parser below, so the limit must be raised there - Coexistence
// history-sync chunks (~300kb) were 413'd by its 100kb default before the
// /api/webhook parser ever ran.
const config = {
  name: "webhook-service",
  port: parseInt(process.env.PORT || "4003", 10),
  jsonLimit: "5mb",
};
const app = createServiceApp(config);

// Override body parser for webhook - capture raw body for signature verification
// Remove default json parser for /api/webhook and add one with raw body capture
//
// `limit`: express.json defaults to 100kb, and Coexistence history-sync chunks
// arrive at ~300kb - so every history webhook 413'd at the parser and the logs
// showed "zero history webhooks" while Meta was in fact delivering them
// (observed in prod 2026-08-18: PayloadTooLargeError, length 295876, limit
// 102400). History is delivered ONCE per onboarding; a rejected chunk is lost
// for good after Meta's retries lapse. 5mb keeps headroom under the gateway's
// 10m client_max_body_size.
app.use("/api/webhook", express.json({
  limit: "5mb",
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  },
}));

// Routes
app.use("/api/webhook", webhookRoutes);

// Generic inbound webhook triggers (POST /webhooks/:token). Mounted at its own
// prefix - separate from the per-provider handlers above - so it fronts the
// WebhookTrigger model without touching existing provider routing. Uses the
// global express.json() parser from createServiceApp (no raw-body needed: this
// route does basic header-secret auth, not HMAC signature verification).
app.use("/webhooks", triggerRoutes);

// Authenticated management API for WebhookTrigger records (provision / inspect /
// rotate secret / enable-disable), called by the Main Playbook's Webhook trigger
// node. Mounted under /api/webhook-triggers - the gateway's /api/webhook prefix
// already proxies this path here, and Express's segment-boundary mount matching
// keeps the /api/webhook raw-body parser above from intercepting it.
app.use("/api/webhook-triggers", triggerAdminRoutes);

// NOTE: Incoming message worker has been extracted to @chatcenter/incoming-worker service
// for independent scaling. This service is now HTTP-only (handler -> queue pattern).

startService(app, config);
export { app };
