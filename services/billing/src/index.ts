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
import icountIpnRoutes from "./routes/icount-ipn";
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
// The IPN endpoint iCount can actually reach. Public and unauthenticated by
// design - see the route for why a signature would add nothing.
app.use("/api", icountIpnRoutes);
app.use("/api", internalRoutes);

// Scheduler: trials → activate, period end → renew, pending changes → apply,
// failed renewals → dunning ladder.
//
// Safe to run on several instances without a leader lock. Not by luck: every
// charge it makes is keyed deterministically from the subscription and the
// billing period, so concurrent replicas collide on a unique index instead of
// each opening their own charge. Verified in
// scheduler-multi-instance.integration.test.ts - four replicas renewing the
// same subscription at the same instant produce one charge, one invoice and one
// credit grant, and an unknown outcome still leaves exactly one charge to
// reconcile.
//
// A leader lock would still reduce duplicated scanning, which is a cost
// question rather than a correctness one. Do not remove the deterministic keys
// on the assumption that a lock is doing this job.
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
