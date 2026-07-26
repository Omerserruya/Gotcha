/**
 * Billing service - subscriptions, payments (iCount), invoices, AI-Unit
 * purchases, auto-purchase, dunning. Internal DNS: http://billing:4009.
 *
 * Owns MONEY state + provider webhooks + schedulers. The AI-Unit WALLET and
 * ENTITLEMENT read models live in @chatcenter/shared and are consumed in-process
 * by other services; only WRITES (charge/grant/lifecycle) go through this API.
 */
import { createServiceApp, startService } from "@chatcenter/shared";
import subscriptionRoutes from "./routes/subscription";
import paymentMethodRoutes from "./routes/payment-methods";
import creditsRoutes from "./routes/credits";
import pricingRoutes from "./routes/pricing";
import invoicesRoutes from "./routes/invoices";
import webhookRoutes from "./routes/webhooks";
import internalRoutes from "./routes/internal";
import { runBillingCycle } from "./services/subscription.service";
import { runDunning } from "./services/dunning.service";

const config = { name: "billing-service", port: parseInt(process.env.PORT || "4009", 10) };
const app = createServiceApp(config);

app.use("/api", subscriptionRoutes);
app.use("/api", paymentMethodRoutes);
app.use("/api", creditsRoutes);
app.use("/api", pricingRoutes);
app.use("/api", invoicesRoutes);
app.use("/api", webhookRoutes);
app.use("/api", internalRoutes);

// Scheduler: trials → activate, period end → renew, pending changes → apply,
// failed renewals → dunning ladder. Single-instance dev loop; in multi-instance
// prod, gate with a leader lock or convert to a BullMQ repeatable job.
const schedulerEnabled = (process.env.BILLING_SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false";
const intervalMs = parseInt(process.env.BILLING_CYCLE_INTERVAL_MS || String(60 * 60 * 1000), 10);
if (schedulerEnabled) {
  const tick = async () => {
    try {
      const cycle = await runBillingCycle();
      const dunning = await runDunning();
      if (cycle.trials || cycle.renewals || cycle.pending || dunning.retried || dunning.suspended) {
        console.log("[billing][cycle]", { cycle, dunning });
      }
    } catch (err: any) {
      console.warn("[billing][cycle] failed:", err?.message ?? err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

startService(app, config);

export { app };
