import { createServiceApp, startService } from "@chatcenter/shared";
import express from "express";
import webhookRoutes from "./routes/webhook";

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

// NOTE: Incoming message worker has been extracted to @chatcenter/incoming-worker service
// for independent scaling. This service is now HTTP-only (handler -> queue pattern).

startService(app, config);
export { app };
