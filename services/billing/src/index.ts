/**
 * Billing service - subscriptions, payments (iCount), invoices, AI-Unit
 * purchases, auto-purchase, dunning. Internal DNS: http://billing:4009.
 *
 * Owns MONEY state + provider webhooks + schedulers. The AI-Unit WALLET and
 * ENTITLEMENT read models live in @chatcenter/shared and are consumed in-process
 * by other services; only WRITES (charge/grant/lifecycle) go through this API.
 */
import { createServiceApp, startService, settleDueConversations } from "@chatcenter/shared";
import subscriptionRoutes from "./routes/subscription";
import paymentMethodRoutes from "./routes/payment-methods";
import creditsRoutes from "./routes/credits";
import pricingRoutes from "./routes/pricing";
import publicPricingRoutes from "./routes/public-pricing";
import adminPricingRoutes from "./routes/admin-pricing";
import adminExchangeRateRoutes from "./routes/admin-exchange-rates";
import adminAnalyticsRoutes from "./routes/admin-analytics";
import invoicesRoutes from "./routes/invoices";
import webhookRoutes from "./routes/webhooks";
import checkoutRoutes from "./routes/checkout";
import checkoutSessionRoutes from "./routes/checkout-session";
import internalRoutes from "./routes/internal";
import { assertIcountConfig } from "./providers/icount-config";
import { runSchedulerTick, tickWasEventful } from "./services/scheduler.service";

// Fail closed before the first request. A billing service configured to talk to
// the real iCount API without a token would accept traffic and then fail every
// charge; refusing to boot surfaces the misconfiguration at deploy time
// instead of at the customer's renewal.
assertIcountConfig();

const config = { name: "billing-service", port: parseInt(process.env.PORT || "4009", 10) };
const app = createServiceApp(config);

app.use("/api", subscriptionRoutes);
app.use("/api", paymentMethodRoutes);
app.use("/api", creditsRoutes);
app.use("/api", pricingRoutes);
// Unauthenticated, cacheable marketing catalog. Gated by PUBLIC_PRICING_ENABLED.
app.use("/api", publicPricingRoutes);
// Platform (Sysadmin) tier. Never reachable by a tenant ADMIN.
app.use("/api", adminPricingRoutes);
app.use("/api", adminExchangeRateRoutes);
app.use("/api", adminAnalyticsRoutes);
app.use("/api", invoicesRoutes);
// Customer-facing checkout status. Read-only: nothing here can complete a
// checkout, and the opaque reference alone is never authorization.
app.use("/api", checkoutRoutes);
app.use("/api", checkoutSessionRoutes);
app.use("/api", webhookRoutes);
app.use("/api", internalRoutes);

// Scheduler: trials → activate, period end → renew, pending changes → apply,
// failed renewals → dunning ladder. Single-instance dev loop; in multi-instance
// prod, gate with a leader lock or convert to a BullMQ repeatable job.
const schedulerEnabled = (process.env.BILLING_SCHEDULER_ENABLED ?? "true").toLowerCase() !== "false";
const intervalMs = parseInt(process.env.BILLING_CYCLE_INTERVAL_MS || String(60 * 60 * 1000), 10);
if (schedulerEnabled) {
  const tick = async () => {
    // Every stage is individually guarded inside runSchedulerTick, so one
    // failing subsystem cannot silently skip the others - see that file for why
    // reconciliation in particular must not be collateral damage.
    const result = await runSchedulerTick();
    if (tickWasEventful(result)) console.log("[billing][cycle]", result);
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
}

startService(app, config);

export { app };
