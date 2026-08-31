/**
 * The usage ledger, against the real database.
 *
 * The claim under test is the one that costs money if it is wrong: the same
 * unit of usage is never charged by two providers, and a retry never becomes a
 * second charge.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  recordUsage,
  reverseUsage,
  dispatchPendingUsage,
  usageTotals,
  UsageKeyTooLongError,
  MAX_DISPATCH_ATTEMPTS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from "../services/usage-ledger.service";
import * as registry from "../billing-sources";
import type { BillingSourceProvider, UsageDispatchResult } from "../billing-sources";

const RUN = `use-${Date.now().toString(36)}`;
const ORIGINAL = { ...process.env };
const tenantIds: string[] = [];

async function newTenant() {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  tenantIds.push(t.id);
  return t;
}

/** A source we can steer: accept, reject transiently, reject permanently, throw. */
function fakeSource(behaviour: {
  mode: "accept" | "transient" | "permanent" | "throw";
  onCall?: (n: number) => void;
}): BillingSourceProvider {
  let calls = 0;
  return {
    source: "SHOPIFY",
    capabilities: registry.SHOPIFY_APP_PRICING_CAPABILITIES,
    async beginSubscription() { throw new Error("not used"); },
    async fetchSubscription() { return null; },
    async dispatchUsage(): Promise<UsageDispatchResult> {
      calls++;
      behaviour.onCall?.(calls);
      if (behaviour.mode === "throw") throw new Error("socket hang up");
      if (behaviour.mode === "accept") return { accepted: true, providerEventId: `evt_${calls}` };
      if (behaviour.mode === "permanent") {
        return { accepted: false, permanent: true, failureCode: "timestamp_outside_billing_cycle" };
      }
      return { accepted: false, permanent: false, failureCode: "rate_limited" };
    },
  };
}

function useSource(src: BillingSourceProvider) {
  vi.spyOn(registry, "getBillingSource").mockReturnValue(src);
}

function enableShopifyUsage() {
  process.env.SHOPIFY_BILLING_ENABLED = "true";
  process.env.SHOPIFY_BILLING_MODE = "manual";
  process.env.SHOPIFY_USAGE_BILLING_ENABLED = "true";
  process.env.SHOPIFY_USAGE_METER_HANDLES = JSON.stringify({ ai_answer: "ai-answers" });
}

beforeEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (k.startsWith("SHOPIFY_")) delete process.env[k];
});

afterEach(async () => {
  await prisma.usageLedgerEntry.deleteMany({ where: { tenantId: { in: tenantIds } } });
});

afterAll(async () => {
  process.env = { ...ORIGINAL };
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("scenario 17: the same unit is recorded once, however often it is submitted", () => {
  it("a duplicate key returns the ORIGINAL row and writes nothing new", async () => {
    const t = await newTenant();
    const key = `${RUN}-dup-1`;
    const first = await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1,
      occurredAt: new Date(), idempotencyKey: key, billingSource: "SHOPIFY",
    });
    const second = await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1,
      occurredAt: new Date(), idempotencyKey: key, billingSource: "SHOPIFY",
    });

    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await prisma.usageLedgerEntry.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("scenario 23: the same key claimed by a SECOND provider does not create a second charge", async () => {
    const t = await newTenant();
    const key = `${RUN}-crossclaim`;
    const first = await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1,
      occurredAt: new Date(), idempotencyKey: key, billingSource: "GOTCHA_EXTERNAL",
    });
    // A different subsystem believes Shopify owns this unit.
    const second = await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1,
      occurredAt: new Date(), idempotencyKey: key, billingSource: "SHOPIFY",
    });

    expect(second.id).toBe(first.id);
    const rows = await prisma.usageLedgerEntry.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(1);
    // The FIRST attribution wins and is not silently rewritten.
    expect(rows[0].billingSource).toBe("GOTCHA_EXTERNAL");
  });

  it("eight concurrent recordings of one unit produce exactly one row", async () => {
    const t = await newTenant();
    const key = `${RUN}-conc`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        recordUsage({
          tenantId: t.id, metric: "ai_answer", quantity: 1,
          occurredAt: new Date(), idempotencyKey: key, billingSource: "SHOPIFY",
        }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await prisma.usageLedgerEntry.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("refuses a key Shopify could never accept, at RECORD time", async () => {
    const t = await newTenant();
    await expect(recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1, occurredAt: new Date(),
      idempotencyKey: "x".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
      billingSource: "SHOPIFY",
    })).rejects.toBeInstanceOf(UsageKeyTooLongError);
  });
});

describe("routing: a row goes only to the source it already names", () => {
  it("dispatches a SHOPIFY row through the Shopify source", async () => {
    const t = await newTenant();
    enableShopifyUsage();
    useSource(fakeSource({ mode: "accept" }));
    await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 3, occurredAt: new Date(),
      idempotencyKey: `${RUN}-route-1`, billingSource: "SHOPIFY",
    });

    const s = await dispatchPendingUsage();
    expect(s.dispatched).toBe(1);
    const row = await prisma.usageLedgerEntry.findUnique({ where: { idempotencyKey: `${RUN}-route-1` } });
    expect(row!.status).toBe("ACKED");
    expect(row!.providerEventId).toBe("evt_1");
  });

  it("an externally billed row is never sent to Shopify - it cannot meter", async () => {
    const t = await newTenant();
    enableShopifyUsage();
    await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1, occurredAt: new Date(),
      idempotencyKey: `${RUN}-ext-1`, billingSource: "GOTCHA_EXTERNAL",
    });
    const s = await dispatchPendingUsage();
    // GOTCHA_EXTERNAL implements no dispatchUsage: settlement is the PAYG
    // path's job, not this one's.
    expect(s.dispatched).toBe(0);
    expect(s.skipped).toBe(1);
    const row = await prisma.usageLedgerEntry.findUnique({ where: { idempotencyKey: `${RUN}-ext-1` } });
    expect(row!.skipReason).toBe("source_cannot_meter_usage");
  });

  it("scenario 22: with usage billing disabled, nothing is sent - and nothing is lost", async () => {
    const t = await newTenant();
    useSource(fakeSource({ mode: "accept" }));
    await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1, occurredAt: new Date(),
      idempotencyKey: `${RUN}-off-1`, billingSource: "SHOPIFY",
    });
    const s = await dispatchPendingUsage();
    expect(s.skipped).toBe(1);
    const row = await prisma.usageLedgerEntry.findUnique({ where: { idempotencyKey: `${RUN}-off-1` } });
    expect(row!.skipReason).toBe("shopify_usage_billing_disabled");
    // The usage itself is still on the books.
    expect(row!.quantity.toString()).toBe("1");
  });

  it("an unmapped metric is skipped rather than sent under a guessed handle", async () => {
    const t = await newTenant();
    enableShopifyUsage(); // maps ai_answer only
    useSource(fakeSource({ mode: "accept" }));
    await recordUsage({
      tenantId: t.id, metric: "shopify_action", quantity: 1, occurredAt: new Date(),
      idempotencyKey: `${RUN}-nomap`, billingSource: "SHOPIFY",
    });
    const s = await dispatchPendingUsage();
    expect(s.skipped).toBe(1);
    const row = await prisma.usageLedgerEntry.findUnique({ where: { idempotencyKey: `${RUN}-nomap` } });
    expect(row!.skipReason).toBe("no_meter_handle_configured");
  });
});

describe("scenario 18: provider timeout and retry", () => {
  it("a thrown transport error is retried, with backoff, and not double-sent", async () => {
    const t = await newTenant();
    enableShopifyUsage();
    let calls = 0;
    useSource(fakeSource({ mode: "throw", onCall: () => { calls++; } }));
    await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1, occurredAt: new Date(),
      idempotencyKey: `${RUN}-timeout`, billingSource: "SHOPIFY",
    });

    const s = await dispatchPendingUsage();
    expect(s.failed).toBe(1);
    const row = await prisma.usageLedgerEntry.findUnique({ where: { idempotencyKey: `${RUN}-timeout` } });
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(1);
    expect(row!.failureCode).toBe("dispatch_exception");
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // Immediately running again must NOT re-send: the backoff is what stops a
    // failing provider being hammered.
    const again = await dispatchPendingUsage();
    expect(again.considered).toBe(0);
    expect(calls).toBe(1);
  });

  it("a permanent rejection stops immediately instead of retrying forever", async () => {
    const t = await newTenant();
    enableShopifyUsage();
    useSource(fakeSource({ mode: "permanent" }));
    await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1, occurredAt: new Date(),
      idempotencyKey: `${RUN}-perm`, billingSource: "SHOPIFY",
    });
    const s = await dispatchPendingUsage();
    expect(s.skipped).toBe(1);
    const row = await prisma.usageLedgerEntry.findUnique({ where: { idempotencyKey: `${RUN}-perm` } });
    expect(row!.status).toBe("SKIPPED");
    expect(row!.failureCode).toBe("timestamp_outside_billing_cycle");
    expect(row!.nextAttemptAt).toBeNull();
  });

  it("exhausted retries dead-letter VISIBLY rather than disappearing", async () => {
    const t = await newTenant();
    enableShopifyUsage();
    useSource(fakeSource({ mode: "transient" }));
    const key = `${RUN}-dead`;
    await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1, occurredAt: new Date(),
      idempotencyKey: key, billingSource: "SHOPIFY",
    });

    for (let i = 0; i < MAX_DISPATCH_ATTEMPTS; i++) {
      // Step past each backoff window rather than sleeping through it.
      await prisma.usageLedgerEntry.updateMany({ where: { idempotencyKey: key }, data: { nextAttemptAt: null } });
      await dispatchPendingUsage();
    }

    const row = await prisma.usageLedgerEntry.findUnique({ where: { idempotencyKey: key } });
    expect(row!.status).toBe("FAILED");
    expect(row!.attempts).toBe(MAX_DISPATCH_ATTEMPTS);
    // Still there, still readable, still carrying why.
    expect(row!.failureCode).toBe("rate_limited");
  });
});

describe("reversal", () => {
  it("a dispatched unit is reversed by a NEW negative row, not an edit", async () => {
    const t = await newTenant();
    enableShopifyUsage();
    useSource(fakeSource({ mode: "accept" }));
    const orig = await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 5, occurredAt: new Date(),
      idempotencyKey: `${RUN}-rev-orig`, billingSource: "SHOPIFY",
    });
    await dispatchPendingUsage();

    const rev = await reverseUsage({ ledgerEntryId: orig.id, idempotencyKey: `${RUN}-rev-new` });
    const revRow = await prisma.usageLedgerEntry.findUnique({ where: { id: rev.id } });
    const origRow = await prisma.usageLedgerEntry.findUnique({ where: { id: orig.id } });

    expect(revRow!.quantity.toString()).toBe("-5");
    expect(revRow!.reversalOfId).toBe(orig.id);
    expect(revRow!.billingSource).toBe("SHOPIFY");
    // It is due for dispatch - Shopify wants the negative under a NEW key.
    expect(revRow!.status).toBe("PENDING");
    expect(origRow!.status).toBe("REVERSED");
  });

  it("reversing something never dispatched does NOT credit the provider", async () => {
    const t = await newTenant();
    const orig = await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 2, occurredAt: new Date(),
      idempotencyKey: `${RUN}-rev2-orig`, billingSource: "SHOPIFY",
    });
    const rev = await reverseUsage({ ledgerEntryId: orig.id, idempotencyKey: `${RUN}-rev2-new` });
    const revRow = await prisma.usageLedgerEntry.findUnique({ where: { id: rev.id } });
    // Never sent, so there is nothing to credit; issuing one would be a refund
    // for a charge that was never made.
    expect(revRow!.status).toBe("SKIPPED");
    expect(revRow!.skipReason).toBe("original_never_dispatched");
  });
});

describe("scenario 19: a cap is a first-class outcome, not an error", () => {
  it("a capped unit is recorded and marked SKIPPED with the reason", async () => {
    const t = await newTenant();
    const r = await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 1, occurredAt: new Date(),
      idempotencyKey: `${RUN}-cap`, billingSource: "SHOPIFY", skipReason: "cap_reached",
    });
    expect(r.status).toBe("SKIPPED");
    const row = await prisma.usageLedgerEntry.findUnique({ where: { id: r.id } });
    // Recorded internally - the work happened and reporting needs it - but it
    // will never reach a provider.
    expect(row!.skipReason).toBe("cap_reached");
    const s = await dispatchPendingUsage();
    expect(s.considered).toBe(0);
  });
});

describe("totals", () => {
  it("nets reversals off, and ignores what was never billable", async () => {
    const t = await newTenant();
    const since = new Date(Date.now() - 60_000);
    await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 10, occurredAt: new Date(),
      idempotencyKey: `${RUN}-tot-1`, billingSource: "SHOPIFY",
    });
    await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: -4, occurredAt: new Date(),
      idempotencyKey: `${RUN}-tot-2`, billingSource: "SHOPIFY",
    });
    await recordUsage({
      tenantId: t.id, metric: "ai_answer", quantity: 99, occurredAt: new Date(),
      idempotencyKey: `${RUN}-tot-3`, billingSource: "SHOPIFY", skipReason: "cap_reached",
    });

    const totals = await usageTotals({ tenantId: t.id, since });
    expect(totals.ai_answer).toBe("6");
  });
});
