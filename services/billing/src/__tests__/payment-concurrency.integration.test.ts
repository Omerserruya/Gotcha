/**
 * Cross-instance payment execution safety.
 *
 * These run against the REAL database, because the property under test is a
 * PostgreSQL one: a conditional UPDATE row-locks its match, so of N concurrent
 * workers exactly one can win. An in-memory mock would prove nothing - it would
 * only test the mock's own serialisation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@chatcenter/shared";
import {
  beginAttempt,
  claimExecution,
  markProviderRequestStarted,
  markProviderResponseReceived,
  expireStaleLeases,
  releaseExecution,
  mayRetry,
  requiresReconciliation,
} from "../services/payment-attempt.service";

const RUN = `conc-${Date.now()}`;
const keys: string[] = [];

function key(name: string): string {
  const k = `${RUN}:${name}`;
  keys.push(k);
  return k;
}

afterAll(async () => {
  await prisma.paymentAttempt.deleteMany({ where: { attemptKey: { in: keys } } });
});

describe("only one worker may execute a given attempt", () => {
  it("1. eight concurrent workers, one winner", async () => {
    const { attempt } = await beginAttempt({
      attemptKey: key("eight-workers"),
      purpose: "RENEWAL",
      amount: 499,
      currency: "ILS",
    });

    // All eight race for the same row at the same time.
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimExecution({ attemptId: attempt.id, owner: `worker-${i}` }),
      ),
    );

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => !r.claimed)).toHaveLength(7);

    const row = await prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
    expect(row?.executionOwner).toMatch(/^worker-\d$/);
    expect(row?.attemptNumber).toBe(1); // exactly one increment, not eight
  });

  it("2. a unique-key conflict does not let the loser call the provider", async () => {
    const k = key("dup-insert");
    const first = await beginAttempt({ attemptKey: k, purpose: "RENEWAL", amount: 100, currency: "ILS" });
    const second = await beginAttempt({ attemptKey: k, purpose: "RENEWAL", amount: 100, currency: "ILS" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false); // lost the insert race
    expect(second.attempt.id).toBe(first.attempt.id);

    // The loser must not simply proceed. Winning the INSERT and winning the
    // right to EXECUTE are separate decisions.
    const claimA = await claimExecution({ attemptId: first.attempt.id, owner: "A" });
    const claimB = await claimExecution({ attemptId: second.attempt.id, owner: "B" });
    expect([claimA.claimed, claimB.claimed].filter(Boolean)).toHaveLength(1);
  });

  it("3. an active lease blocks every other worker", async () => {
    const { attempt } = await beginAttempt({
      attemptKey: key("active-lease"),
      purpose: "RENEWAL",
      amount: 250,
      currency: "ILS",
    });

    expect((await claimExecution({ attemptId: attempt.id, owner: "holder", leaseMs: 60_000 })).claimed).toBe(true);
    // Lease is live: nobody else gets in, however many try.
    for (const owner of ["other-1", "other-2", "other-3"]) {
      expect((await claimExecution({ attemptId: attempt.id, owner })).claimed).toBe(false);
    }
  });

  it("3b. only the lease holder may mark a provider request as started", async () => {
    const { attempt } = await beginAttempt({
      attemptKey: key("owner-scoped"),
      purpose: "RENEWAL",
      amount: 75,
      currency: "ILS",
    });
    await claimExecution({ attemptId: attempt.id, owner: "holder", leaseMs: 60_000 });

    expect(await markProviderRequestStarted({ attemptId: attempt.id, owner: "impostor" })).toBe(false);
    expect(await markProviderRequestStarted({ attemptId: attempt.id, owner: "holder" })).toBe(true);
    // ...and only once.
    expect(await markProviderRequestStarted({ attemptId: attempt.id, owner: "holder" })).toBe(false);
  });
});

describe("lease expiry distinguishes before and after submission", () => {
  it("4a. expired BEFORE submission is released and reclaimable", async () => {
    const { attempt } = await beginAttempt({
      attemptKey: key("expired-before"),
      purpose: "RENEWAL",
      amount: 10,
      currency: "ILS",
    });
    // Claim with a lease that is already in the past.
    await claimExecution({
      attemptId: attempt.id,
      owner: "dead-worker",
      leaseMs: -1_000,
      now: new Date(Date.now() - 10_000),
    });

    const swept = await expireStaleLeases();
    expect(swept.released).toBeGreaterThanOrEqual(1);

    const row = await prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
    expect(row?.state).toBe("PENDING"); // no charge was ever submitted
    expect(row?.executionOwner).toBeNull();

    // Proof that nothing was sent means a fresh worker may safely take over.
    expect((await claimExecution({ attemptId: attempt.id, owner: "fresh" })).claimed).toBe(true);
  });

  it("4b. expired AFTER submission becomes RECONCILIATION_REQUIRED, not reclaimable", async () => {
    const { attempt } = await beginAttempt({
      attemptKey: key("expired-after"),
      purpose: "RENEWAL",
      amount: 20,
      currency: "ILS",
    });
    await claimExecution({ attemptId: attempt.id, owner: "dead-worker", leaseMs: 60_000 });
    // The worker got as far as sending the request, then died.
    await markProviderRequestStarted({ attemptId: attempt.id, owner: "dead-worker" });
    await prisma.paymentAttempt.update({
      where: { id: attempt.id },
      data: { executionLeaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    const swept = await expireStaleLeases();
    expect(swept.needsReconciliation).toBeGreaterThanOrEqual(1);

    const row = await prisma.paymentAttempt.findUnique({ where: { id: attempt.id } });
    expect(row?.state).toBe("RECONCILIATION_REQUIRED");
    expect(row?.failureCode).toMatch(/lease_expired_after_submission/);

    // A charge may exist at the provider. Nobody may issue another cc/bill.
    expect((await claimExecution({ attemptId: attempt.id, owner: "eager" })).claimed).toBe(false);
    expect(requiresReconciliation(row!.state)).toBe(true);
    expect(mayRetry(row!.state)).toBe(false);
  });

  it("5. UNKNOWN cannot be claimed for another charge", async () => {
    const { attempt } = await beginAttempt({
      attemptKey: key("unknown-state"),
      purpose: "RENEWAL",
      amount: 30,
      currency: "ILS",
    });
    await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { state: "UNKNOWN" } });

    expect((await claimExecution({ attemptId: attempt.id, owner: "anyone" })).claimed).toBe(false);
    expect(mayRetry("UNKNOWN")).toBe(false);
    expect(requiresReconciliation("UNKNOWN")).toBe(true);
  });

  it("5b. MANUAL_REVIEW is equally unclaimable", async () => {
    const { attempt } = await beginAttempt({
      attemptKey: key("manual-review"),
      purpose: "RENEWAL",
      amount: 40,
      currency: "ILS",
    });
    await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { state: "MANUAL_REVIEW" } });
    expect((await claimExecution({ attemptId: attempt.id, owner: "anyone" })).claimed).toBe(false);
  });
});

describe("only the claiming worker reaches the provider", () => {
  it("proves it with a counting provider mock", async () => {
    const { attempt } = await beginAttempt({
      attemptKey: key("provider-mock"),
      purpose: "RENEWAL",
      amount: 499,
      currency: "ILS",
    });

    let providerCalls = 0;
    const chargeIfClaimed = async (owner: string) => {
      const { claimed } = await claimExecution({ attemptId: attempt.id, owner, leaseMs: 60_000 });
      if (!claimed) return "skipped";
      const ok = await markProviderRequestStarted({ attemptId: attempt.id, owner });
      if (!ok) return "skipped";
      providerCalls += 1; // stands in for provider.charge()
      await markProviderResponseReceived({ attemptId: attempt.id, owner });
      return "charged";
    };

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) => chargeIfClaimed(`w${i}`)),
    );

    expect(providerCalls).toBe(1);
    expect(outcomes.filter((o) => o === "charged")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "skipped")).toHaveLength(5);
  });
});
