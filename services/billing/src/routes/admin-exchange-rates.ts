/**
 * Sysadmin control of the rate money is charged at.
 *
 * This is the surface that decides what every Israeli customer's card is
 * actually debited. Three deliberate properties:
 *
 *   Proposing and approving are separate calls, and the approver may not be the
 *   author. Whoever types a number should not be the only person who can make
 *   it chargeable - a mistyped decimal point is a 10x charge.
 *
 *   Nothing here fetches a rate. The number is entered by a person, and no
 *   endpoint offers to look one up, because a rate arriving from the web during
 *   a charge is a rate nobody approved.
 *
 *   Retiring is offered without a replacement. It is the lever for "stop taking
 *   money at this rate", and it deliberately leaves the platform unable to
 *   charge until someone approves a new one.
 */
import { Router } from "express";
import { authenticate } from "@chatcenter/shared";
import {
  activeRate,
  approveRate,
  chargingRateConfigured,
  convert,
  proposeRate,
  rateHistory,
  retireRate,
  ExchangeRateRefused,
  ExchangeRateUnavailable,
} from "../services/exchange-rate.service";
import { pendingReconciliations, sweepUnknownAttempts } from "../services/reconciliation.service";
import { previewEnforcement } from "../services/enforcement-preview.service";
import { writeAudit, AuditAction } from "@chatcenter/shared";

/**
 * Record who did what to the charging rate.
 *
 * The row itself keeps createdBy and approvedBy, but only for the CURRENT
 * state. An audit entry survives the row being retired or corrected, which is
 * exactly the situation in which someone asks who changed this and when.
 */
async function auditRate(req: any, action: string, rate: any, extra?: Record<string, unknown>) {
  await writeAudit({
    tenantId: "platform",
    actorType: "user",
    actorId: req.user?.userId ?? null,
    action,
    targetType: "billing_exchange_rate",
    targetId: rate?.id ?? null,
    metadata: {
      pair: `${rate?.baseCurrency}->${rate?.quoteCurrency}`,
      rate: String(rate?.rate),
      version: rate?.version,
      status: rate?.status,
      ...extra,
    },
  });
}

const router = Router();

/** Platform-level, not tenant-level: one rate governs every customer. */
function requirePlatformAdmin(req: any, res: any, next: () => void) {
  if (req.user?.role !== "SYSTEM_ADMIN") {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

const guard = [authenticate as any, requirePlatformAdmin];

function actor(req: any): string {
  // The audit trail needs a person, not a service. Falling back to a generic
  // id would make "who approved this" unanswerable.
  return String(req.user?.userId ?? req.user?.sub ?? "unknown");
}

function shape(rate: any) {
  return {
    id: rate.id,
    baseCurrency: rate.baseCurrency,
    quoteCurrency: rate.quoteCurrency,
    rate: String(rate.rate),
    source: rate.source,
    version: rate.version,
    status: rate.status,
    activeFrom: rate.activeFrom,
    activeUntil: rate.activeUntil,
    createdBy: rate.createdBy,
    approvedBy: rate.approvedBy,
    approvedAt: rate.approvedAt,
    createdAt: rate.createdAt,
  };
}

/** Current state plus history, so the effect of a change is visible before it. */
router.get("/admin/billing/exchange-rates", ...guard, async (req, res) => {
  const base = String(req.query.base ?? "USD");
  const quote = String(req.query.quote ?? "ILS");

  const history = await rateHistory({ base, quote });
  let current = null;
  try {
    current = shape(await activeRate({ base, quote }));
  } catch {
    current = null; // no approved rate - charging is blocked, which the UI shows
  }

  res.json({
    data: {
      current,
      chargingEnabled: await chargingRateConfigured({ base, quote }),
      history: history.map(shape),
      // A worked example, so the person approving sees what a real plan price
      // becomes rather than only a multiplier.
      example: current
        ? {
            commercial: "499.00 USD",
            charge: `${convert("499.00", current.rate).toFixed(2)} ILS`,
          }
        : null,
    },
  });
});

/** Propose a rate. Created as DRAFT: proposing does not make it chargeable. */
router.post("/admin/billing/exchange-rates", ...guard, async (req, res) => {
  const { rate, base, quote, activeFrom, activeUntil, source } = req.body ?? {};
  if (rate === undefined || rate === null || rate === "") {
    return res.status(400).json({ error: "rate_required" });
  }
  try {
    const created = await proposeRate({
      rate: String(rate),
      base: base ? String(base) : undefined,
      quote: quote ? String(quote) : undefined,
      activeFrom: activeFrom ? new Date(activeFrom) : undefined,
      activeUntil: activeUntil ? new Date(activeUntil) : null,
      source: source ? String(source) : undefined,
      createdBy: actor(req),
    });
    await auditRate(req, AuditAction.EXCHANGE_RATE_PROPOSED, created);
    res.status(201).json({ data: shape(created) });
  } catch (err) {
    respond(res, err);
  }
});

/**
 * Approve a draft, making it THE rate.
 *
 * Retires the previous one in the same transaction, and the database refuses a
 * second ACTIVE row - so a race here fails loudly rather than leaving the
 * charge amount to whichever row a query returned first.
 */
router.post("/admin/billing/exchange-rates/:id/approve", ...guard, async (req, res) => {
  try {
    const approved = await approveRate({ id: String(req.params.id), approvedBy: actor(req) });
    // The moment charging behaviour changes for every customer.
    await auditRate(req, AuditAction.EXCHANGE_RATE_APPROVED, approved, {
      approvedBy: approved.approvedBy,
      createdBy: approved.createdBy,
    });
    res.json({ data: shape(approved) });
  } catch (err) {
    respond(res, err);
  }
});

/**
 * Retire a rate without replacing it.
 *
 * Leaves the platform unable to charge, on purpose. That is the point of having
 * the lever.
 */
router.post("/admin/billing/exchange-rates/:id/retire", ...guard, async (req, res) => {
  try {
    const retired = await retireRate({ id: String(req.params.id), actor: actor(req) });
    // Retiring without a replacement stops all charging, so it needs a trail as
    // much as approving does.
    await auditRate(req, AuditAction.EXCHANGE_RATE_RETIRED, retired);
    res.json({ data: shape(retired) });
  } catch (err) {
    respond(res, err);
  }
});

/**
 * Preview a conversion without saving anything.
 *
 * So an approver can check a figure against a real plan price before it becomes
 * the number on someone's statement.
 */
router.post("/admin/billing/exchange-rates/preview", ...guard, async (req, res) => {
  const { rate, amount } = req.body ?? {};
  try {
    const converted = convert(String(amount ?? "499.00"), String(rate));
    if (!converted.isFinite() || converted.lte(0)) {
      return res.status(400).json({ error: "invalid_preview_input" });
    }
    res.json({ data: { charge: converted.toFixed(2), currency: "ILS" } });
  } catch {
    res.status(400).json({ error: "invalid_preview_input" });
  }
});

/**
 * Charges nobody could settle automatically.
 *
 * Deliberately read-only and on the platform surface: resolving one means
 * looking at the provider's own records, and the action that follows is a
 * refund or a manual activation, both of which already have their own audited
 * paths. A one-click "mark as paid" here would be a way to grant a plan with no
 * evidence at all.
 */
router.get("/admin/billing/reconciliations", ...guard, async (_req, res) => {
  res.json({ data: await pendingReconciliations() });
});

/**
 * Run the sweep now.
 *
 * It only ever asks the provider what happened - it never re-submits a charge -
 * so triggering it by hand is safe. Useful when a provider outage has just
 * ended and nobody wants to wait for the next tick.
 */
router.post("/admin/billing/reconciliations/sweep", ...guard, async (_req, res) => {
  try {
    res.json({ data: await sweepUnknownAttempts() });
  } catch (err) {
    console.error("[billing] reconciliation sweep failed:", err);
    res.status(500).json({ error: "sweep_failed" });
  }
});

/**
 * Who would stop being served if enforcement were switched on.
 *
 * Read-only, and worth having because enforcement mode is one environment
 * variable that changes what happens to live customer conversations. Flipping
 * it without knowing the blast radius means learning it from the organizations
 * whose bots went quiet.
 */
router.get("/admin/billing/enforcement-preview", ...guard, async (_req, res) => {
  try {
    res.json({ data: await previewEnforcement() });
  } catch (err) {
    console.error("[billing] enforcement preview failed:", err);
    res.status(500).json({ error: "preview_failed" });
  }
});

function respond(res: any, err: unknown) {
  if (err instanceof ExchangeRateRefused) return res.status(400).json({ error: err.code });
  if (err instanceof ExchangeRateUnavailable) return res.status(409).json({ error: err.code });
  console.error("[billing] exchange rate admin error:", err);
  return res.status(500).json({ error: "exchange_rate_operation_failed" });
}

export default router;
