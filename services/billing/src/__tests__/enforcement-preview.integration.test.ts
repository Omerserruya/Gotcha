/**
 * The enforcement preview, and the one property that makes it worth having.
 *
 * It has to agree with the gate. A preview that quietly disagrees is worse than
 * none, because someone will read it, believe it, and flip enforcement on the
 * strength of it.
 *
 * So the central test here is not "does it list the right tenants" in the
 * abstract - it is "does its verdict match checkAiAllowed for the same tenant".
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { prisma, checkAiAllowed, grantUnits } from "@chatcenter/shared";
import { previewEnforcement } from "../services/enforcement-preview.service";

const RUN = `pre-${Date.now()}`;
const tenantIds: string[] = [];
const entityIds: string[] = [];
const ORIGINAL = { ...process.env };

async function tenant(
  status: any,
  opts: { subscription?: any; conversations?: number; credits?: number } = {},
) {
  const n = `${RUN}-${Math.random().toString(36).slice(2, 8)}`;
  const t = await prisma.tenant.create({ data: { name: n, slug: n, status } });
  const e = await prisma.billableEntity.create({ data: { displayName: n } });
  await prisma.billableEntityTenant.create({ data: { billableEntityId: e.id, tenantId: t.id } });
  tenantIds.push(t.id);
  entityIds.push(e.id);

  if (opts.subscription) {
    await prisma.subscription.create({
      data: {
        billableEntityId: e.id,
        planKey: "ai_workforce", planVersion: 1,
        status: opts.subscription,
        enforcementEnabled: true,
        snapshotPrice: 499, snapshotCurrency: "USD", snapshotIncludedCredits: 2000,
      },
    });
  }

  for (let i = 0; i < (opts.conversations ?? 0); i += 1) {
    await prisma.conversation.create({
      data: {
        tenantId: t.id,
        channel: "WHATSAPP",
        status: "OPEN",
        customerExternalId: `+9725${Math.floor(Math.random() * 10_000_000)}`,
      },
    });
  }

  if (opts.credits) {
    // Through the wallet, not by inserting a lot: the balance the gate reads is
    // a materialized snapshot, and there is an invariant elsewhere that only
    // the wallet writes lots. A test that bypasses it would be testing a state
    // the system cannot actually be in.
    // PURCHASED rather than INCLUDED: the included allowance is scoped to a
    // billing period, so a grant with no period key is correctly not counted.
    // Purchased credits are the customer's property and are always spendable,
    // which is what "has something left to spend" means here.
    await grantUnits({
      tenantId: t.id,
      bucket: "PURCHASED",
      grantType: "PURCHASE",
      units: opts.credits,
      source: "test",
    });
  }
  return t;
}

function rowFor(preview: Awaited<ReturnType<typeof previewEnforcement>>, tenantId: string) {
  return preview.affected.find((a) => a.tenantId === tenantId);
}

beforeEach(() => {
  process.env.BILLING_ENFORCEMENT_MODE = "hard";
});

afterAll(async () => {
  await prisma.aiUnitLot.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
  await prisma.conversation.deleteMany({ where: { tenantId: { in: tenantIds } } }).catch(() => undefined);
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: entityIds } } });
  await prisma.billableEntityTenant.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  process.env = { ...ORIGINAL };
});

describe("the preview agrees with the gate", () => {
  it("lists exactly the tenants the runtime would refuse", async () => {
    const unpaid = await tenant("PENDING_PAYMENT");
    const suspended = await tenant("SUSPENDED");
    const fine = await tenant("ACTIVE");

    const preview = await previewEnforcement();

    for (const t of [unpaid, suspended, fine]) {
      const gate = await checkAiAllowed(t.id);
      const listed = Boolean(rowFor(preview, t.id));
      // The property that makes this worth reading: it cannot disagree.
      expect(listed, `preview and gate disagree for ${t.status}`).toBe(!gate.allowed);
    }
  });

  it("gives the same reason the gate gives", async () => {
    const unpaid = await tenant("PENDING_PAYMENT");
    const suspended = await tenant("SUSPENDED");

    const preview = await previewEnforcement();
    expect(rowFor(preview, unpaid.id)?.reason).toBe((await checkAiAllowed(unpaid.id)).reason);
    expect(rowFor(preview, suspended.id)?.reason).toBe((await checkAiAllowed(suspended.id)).reason);
  });

  it("does not list a healthy tenant", async () => {
    // Credits matter: an active subscription with an empty wallet is genuinely
    // refused by the gate, so listing THAT would be correct. A healthy tenant
    // is one with a plan and something left to spend.
    const ok = await tenant("ACTIVE", { subscription: "ACTIVE", credits: 2000 });
    const preview = await previewEnforcement();
    // Listing a working customer would send someone investigating nothing.
    expect(rowFor(preview, ok.id)).toBeUndefined();
    expect((await checkAiAllowed(ok.id)).allowed).toBe(true);
  });

  it("lists an active subscription whose wallet is empty", async () => {
    const broke = await tenant("ACTIVE", { subscription: "ACTIVE" });
    const preview = await previewEnforcement();
    // Not a false positive - the gate refuses this tenant too.
    expect(rowFor(preview, broke.id)?.reason).toBe("units_exhausted");
    expect((await checkAiAllowed(broke.id)).allowed).toBe(false);
  });
});

describe("it says whether anyone would notice", () => {
  it("marks a tenant with recent conversations as live", async () => {
    const busy = await tenant("PENDING_PAYMENT", { conversations: 2 });
    const preview = await previewEnforcement();
    const row = rowFor(preview, busy.id);
    // The number that decides whether this is a quiet config change or an
    // outage for somebody's customers.
    expect(row?.live).toBe(true);
    expect(row?.recentConversations).toBeGreaterThanOrEqual(2);
  });

  it("marks a dormant tenant as not live", async () => {
    const quiet = await tenant("PENDING_PAYMENT");
    const preview = await previewEnforcement();
    expect(rowFor(preview, quiet.id)?.live).toBe(false);
  });

  it("puts live tenants first", async () => {
    await tenant("PENDING_PAYMENT");
    await tenant("PENDING_PAYMENT", { conversations: 3 });
    const preview = await previewEnforcement();
    const ours = preview.affected.filter((a) => tenantIds.includes(a.tenantId));
    const firstDead = ours.findIndex((a) => !a.live);
    if (firstDead >= 0) {
      // Nobody scrolls. The ones that matter have to be at the top.
      expect(ours.slice(firstDead).every((a) => !a.live)).toBe(true);
    }
  });

  it("counts by reason, so the shape of the problem is visible at a glance", async () => {
    await tenant("PENDING_PAYMENT");
    const preview = await previewEnforcement();
    expect(preview.totals.tenants).toBeGreaterThan(0);
    expect(preview.totals.byReason.payment_required).toBeGreaterThan(0);
  });
});

describe("it reports the mode honestly", () => {
  it("says it is a forecast when enforcement is off", async () => {
    process.env.BILLING_ENFORCEMENT_MODE = "off";
    const preview = await previewEnforcement();
    // Still lists who WOULD be affected - that is the entire point of asking
    // before switching it on.
    expect(preview.enforcing).toBe(false);
    expect(preview.mode).toBe("off");
  });

  it("says it is already in force when hard", async () => {
    process.env.BILLING_ENFORCEMENT_MODE = "hard";
    const preview = await previewEnforcement();
    // Now the same list is a report of tenants currently being refused, not a
    // forecast - and it should read differently to whoever is looking.
    expect(preview.enforcing).toBe(true);
  });

  it("changes nothing", async () => {
    const t = await tenant("PENDING_PAYMENT");
    const before = await prisma.tenant.findUnique({ where: { id: t.id } });
    await previewEnforcement();
    const after = await prisma.tenant.findUnique({ where: { id: t.id } });
    expect(after).toEqual(before);
  });
});
