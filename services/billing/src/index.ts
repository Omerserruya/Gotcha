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
import { runBillingCycle } from "./services/subscription.service";
import { runDunning } from "./services/dunning.service";
import { sweepUnknownAttempts } from "./services/reconciliation.service";
import { expireStaleLeases } from "./services/payment-attempt.service";
import { expireStaleQuotes } from "./services/payment-quote.service";
import { expireStaleSessions } from "./services/tokenization.service";
import { purgeSpentCheckoutArtifacts } from "./services/billing-retention.service";
import { assertIcountConfig } from "./providers/icount-config";

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
    try {
      const cycle = await runBillingCycle();
      const dunning = await runDunning();
      // Sysadmin cost analytics: discover conversations that closed since the
      // last tick and settle the ones whose late-job window has elapsed. Runs
      // here rather than on conversation close so the AI hot path never waits
      // on aggregation.
      const usage = await settleDueConversations().catch((err: any) => {
        console.warn("[billing][usage] settle failed:", err?.message ?? err);
        return { settled: 0, discovered: 0 };
      });
      // Charges whose outcome we never learned. Nothing else resolves them, and
      // left alone they are either a customer who paid and did not get their
      // plan, or one who did not pay and did. Both need answering.
      const reconciled = await sweepUnknownAttempts().catch((err: any) => {
        console.warn("[billing][reconcile] sweep failed:", err?.message ?? err);
        return { examined: 0, resolvedPaid: 0, resolvedUnpaid: 0, escalated: 0 };
      });
      // Housekeeping: leases whose holder died, and quotes nobody used.
      await expireStaleLeases().catch(() => undefined);
      await expireStaleQuotes().catch(() => undefined);
      await expireStaleSessions().catch(() => undefined);
      // Spent checkout artifacts. Never touches anything that records money
      // moving - see the service for exactly where that line is drawn.
      const purged = await purgeSpentCheckoutArtifacts().catch((err: any) => {
        console.warn("[billing][retention] purge failed:", err?.message ?? err);
        return { tokenizationSessions: 0, continuationLinks: 0, unusedQuotes: 0 };
      });
      if (cycle.trials || cycle.renewals || cycle.pending || dunning.retried || dunning.suspended || usage.settled || usage.discovered || reconciled.examined
        || purged.tokenizationSessions || purged.continuationLinks || purged.unusedQuotes) {
        console.log("[billing][cycle]", { cycle, dunning, usage, reconciled, purged });
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
