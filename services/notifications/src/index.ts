import http from "http";
import { createServiceApp } from "@chatcenter/shared";
import notificationsRoutes from "./routes/notifications";
import notificationPreferencesAdminRoutes from "./routes/notification-preferences-admin";
import { startNotificationsDispatcherWorker } from "./services/dispatcher.worker";
import { startNotificationsEmailWorker } from "./services/email-sender.worker";
import { startNotificationEventBridge } from "./services/event-bridge";
import { startNotificationWsServer } from "./ws-server";

const config = { name: "notifications-service", port: parseInt(process.env.PORT || "4008", 10) };
const app = createServiceApp(config);

app.use("/api", notificationsRoutes);
app.use("/api", notificationPreferencesAdminRoutes);

// Notification engine workers - disable via NOTIFICATIONS_ENABLED=false.
const notificationsEnabled = (process.env.NOTIFICATIONS_ENABLED ?? "true").toLowerCase() !== "false";
if (notificationsEnabled) {
  try {
    startNotificationsDispatcherWorker();
    startNotificationsEmailWorker();
    startNotificationEventBridge();
  } catch (err: any) {
    console.warn("[notifications] worker startup failed:", err?.message);
  }
}

// We need the underlying http.Server so we can attach a WS upgrade handler.
// createServiceApp returns the express app only; startService wraps it with
// app.listen - bypassing it lets us own the http.Server lifecycle.
const server = http.createServer(app);
startNotificationWsServer(server);

server.listen(config.port, () => {
  console.log(`[${config.name}] listening on :${config.port}`);
});

export { app };
