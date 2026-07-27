/**
 * The IPN endpoint, driven rather than read.
 *
 * The trust model is covered at source level - what the handler must never
 * call, never read, never write. That protects the shape but proves nothing
 * about the behaviour, and the behaviour is the part a real notification
 * depends on: does a genuine IPN actually cause the server to go and check, and
 * does a forged one actually achieve nothing.
 *
 * Driven against the real database and a real router, because both answers come
 * from real rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { prisma } from "@chatcenter/shared";
import ipnRouter from "../routes/icount-ipn";

const RUN = `ipn-${Date.now()}`;
const tenantIds: string[] = [];
const sessionIds: string[] = [];
const eventIds: string[] = [];

const app = express();
app.use(express.json());
app.use("/api", ipnRouter);

async function session(opts: { status?: any } = {}) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({ data: { name: n, slug: n, status: "ACTIVE" } });
  tenantIds.push(tenant.id);

  const s = await prisma.tokenizationSession.create({
    data: {
      tenantId: tenant.id,
      customClientId: `gtok_${n}`,
      pageId: "1",
      status: opts.status ?? "AWAITING_RETURN",
      baselineFingerprints: [],
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  sessionIds.push(s.id);
  return s;
}

const post = (body: unknown) => request(app).post("/api/billing/providers/icount/ipn").send(body);

/**
 * Verification attempts across EVERY session in the database.
 *
 * Deliberately global rather than scoped to this run. Scoped to this run's ids
 * looked equivalent and was not: if correlation stopped filtering on our own
 * references, the query returns whichever row comes first, and in a database
 * carrying sessions from earlier runs that row is not one of ours - so the
 * assertion would pass while the endpoint verified a stranger's session.
 */
async function totalAttempts(): Promise<number> {
  const agg = await prisma.tokenizationSession.aggregate({ _sum: { verificationAttempts: true } });
  return agg._sum.verificationAttempts ?? 0;
}

beforeAll(async () => {
  // Mock mode: the provider performs no network call, so "go and check" is
  // exercised without touching iCount.
  process.env.ICOUNT_MODE = "mock";
});

afterAll(async () => {
  await prisma.billingWebhookEvent.deleteMany({ where: { providerEventId: { in: eventIds } } });
  await prisma.tokenizationSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("a notification about a session we issued", () => {
  it("causes the server to go and check", async () => {
    const s = await session();
    const before = (await prisma.tokenizationSession.findUnique({ where: { id: s.id } }))!;
    expect(before.verificationAttempts).toBe(0);

    const res = await post({ custom_client_id: s.customClientId, status: "paid" });
    expect(res.status).toBe(200);

    const after = (await prisma.tokenizationSession.findUnique({ where: { id: s.id } }))!;
    // The one permitted consequence: we asked iCount, rather than believing the
    // "status: paid" in the body.
    expect(after.verificationAttempts).toBeGreaterThan(before.verificationAttempts);
    expect(after.lastVerifiedAt).not.toBeNull();
  });

  it("correlates by x_order_id too", async () => {
    const s = await session();
    const res = await post({ x_order_id: s.customClientId });
    expect(res.status).toBe(200);
    const after = (await prisma.tokenizationSession.findUnique({ where: { id: s.id } }))!;
    expect(after.verificationAttempts).toBeGreaterThan(0);
  });

  it("re-checks on a redelivery", async () => {
    const s = await session();
    const body = { event_id: `evt_${RUN}_${Math.random().toString(36).slice(2, 8)}`, custom_client_id: s.customClientId };
    eventIds.push(`ipn:${body.event_id}`);

    await post(body);
    const once = (await prisma.tokenizationSession.findUnique({ where: { id: s.id } }))!;

    const second = await post(body);
    expect(second.body.deduped).toBe(true);

    const twice = (await prisma.tokenizationSession.findUnique({ where: { id: s.id } }))!;
    // The first delivery can arrive before the card is actually stored.
    // Refusing to re-check a duplicate would strand a customer who did pay.
    expect(twice.verificationAttempts).toBeGreaterThan(once.verificationAttempts);
  });
});

describe("a notification about something we never issued", () => {
  it("changes nothing and still answers 200", async () => {
    const before = await prisma.tokenizationSession.count();
    const res = await post({ x_order_id: "chk_never_issued", status: "paid", sum: "9999" });
    // 200 because a provider retrying forever helps nobody, and a different
    // answer would reveal whether the reference was real.
    expect(res.status).toBe(200);
    expect(await prisma.tokenizationSession.count()).toBe(before);
  });

  it("records the delivery anyway", async () => {
    const marker = `evt_${RUN}_orphan_${Math.random().toString(36).slice(2, 8)}`;
    eventIds.push(`ipn:${marker}`);
    await post({ event_id: marker, x_order_id: "chk_never_issued" });

    const row = await prisma.billingWebhookEvent.findFirst({
      where: { providerEventId: `ipn:${marker}` },
    });
    // An uncorrelated notification is exactly the evidence someone needs when a
    // customer says they paid and there is no other record of it.
    expect(row).not.toBeNull();
    expect(row!.status).toBe("RECEIVED");
    expect(row!.tenantId).toBeNull();
    expect(row!.processedAt).toBeNull();
  });

  it("grants nothing, charges nothing, creates nothing", async () => {
    const before = {
      charges: await prisma.charge.count(),
      lots: await prisma.aiUnitLot.count(),
      attempts: await prisma.paymentAttempt.count(),
      methods: await prisma.paymentMethod.count(),
    };

    await post({
      x_order_id: "chk_never_issued",
      status: "paid",
      cc_token: "attacker_supplied",
      sum: "9999",
      currency_id: 1,
    });

    // The whole safety argument, as an assertion.
    expect(await prisma.charge.count()).toBe(before.charges);
    expect(await prisma.aiUnitLot.count()).toBe(before.lots);
    expect(await prisma.paymentAttempt.count()).toBe(before.attempts);
    expect(await prisma.paymentMethod.count()).toBe(before.methods);
  });
});

describe("it cannot be aimed at a session it does not name", () => {
  it("leaves other sessions untouched", async () => {
    const target = await session();
    const bystander = await session();

    await post({ custom_client_id: target.customClientId });

    const untouched = (await prisma.tokenizationSession.findUnique({ where: { id: bystander.id } }))!;
    expect(untouched.verificationAttempts).toBe(0);
  });

  it("touches NO session at all when the reference is one we never issued", async () => {
    /**
     * Checked across every session in the database, not one bystander.
     *
     * Picking a single bystander looked equivalent and was not: if correlation
     * stopped filtering on our own references, the query returns whichever row
     * comes first, and whether that is the row under assertion is luck. An
     * unknown reference must move NOTHING, anywhere - which is what this says.
     */
    await session();
    const attemptsBefore = await totalAttempts();

    await post({ x_order_id: `chk_not_ours_${RUN}`, custom_client_id: `gtok_not_ours_${RUN}` });

    expect(await totalAttempts()).toBe(attemptsBefore);
  });

  it("does not act on an already-failed session", async () => {
    const s = await session({ status: "FAILED" });
    await post({ custom_client_id: s.customClientId });

    const after = (await prisma.tokenizationSession.findUnique({ where: { id: s.id } }))!;
    // Terminal is terminal. A notification must not resurrect a session that
    // was already resolved.
    expect(after.status).toBe("FAILED");
    expect(after.verificationAttempts).toBe(0);
  });
});

describe("it will not take arbitrary volume", () => {
  it("refuses a body beyond the limit", async () => {
    const res = await post({ x_order_id: "x", padding: "A".repeat(200_000) });
    expect(res.status).toBe(413);
  });
});
