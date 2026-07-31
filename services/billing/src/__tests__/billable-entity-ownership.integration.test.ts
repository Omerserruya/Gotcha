import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@chatcenter/shared";

/**
 * Every billable entity must be owned by someone.
 *
 * A BillableEntity with no BillableEntityTenant link cannot be billed and
 * cannot be reached from anywhere in the product. It is not a harmless stray
 * row: it is a subscription that could be charging, or a provisioning attempt
 * that half-completed, sitting where nothing will ever look at it again.
 *
 * The dev database had 11,981 of them against 3 real tenants - all leaked by
 * this very suite, because only 2 of 41 files deleted the entity they created.
 * The volume is the actual danger. A single stranded entity from a failed
 * provisioning is a thing you would want to investigate; buried in twelve
 * thousand test artefacts, nobody ever would.
 *
 * `global-teardown.ts` sweeps what the suite leaks. This test is the alarm:
 * cleaning up silently would let the leak grow again the moment the sweep
 * missed a shape.
 */

const RUN = `own-${Date.now()}`;
const created: string[] = [];

afterAll(async () => {
  await prisma.subscription.deleteMany({ where: { billableEntityId: { in: created } } }).catch(() => {});
  await prisma.billingProfile.deleteMany({ where: { billableEntityId: { in: created } } }).catch(() => {});
  await prisma.billableEntity.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: RUN } } }).catch(() => {});
});

describe("the ownership invariant", () => {
  it("a linked entity resolves to its tenant", async () => {
    const tenant = await prisma.tenant.create({
      data: { name: RUN, slug: RUN, status: "ACTIVE" as any },
    });
    const entity = await prisma.billableEntity.create({
      data: { displayName: RUN, kind: "TENANT" as any },
    });
    created.push(entity.id);
    await prisma.billableEntityTenant.create({
      data: { billableEntityId: entity.id, tenantId: tenant.id },
    });

    const found = await prisma.billableEntity.findUnique({
      where: { id: entity.id },
      include: { tenants: true },
    });
    expect(found!.tenants).toHaveLength(1);
    expect(found!.tenants[0].tenantId).toBe(tenant.id);

    await prisma.billableEntityTenant.deleteMany({ where: { billableEntityId: entity.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
  });

  it("an entity created without a link is UNOWNED, and detectable as such", async () => {
    // The exact shape the suite was leaking. The point is that the query which
    // finds it is cheap and unambiguous - there was never a detection problem,
    // only the absence of anything doing the detecting.
    const entity = await prisma.billableEntity.create({
      data: { displayName: `${RUN}-unowned`, kind: "TENANT" as any },
    });
    created.push(entity.id);

    const unowned = await prisma.billableEntity.findMany({
      where: { id: entity.id, tenants: { none: {} } },
      select: { id: true },
    });
    expect(unowned.map((u) => u.id)).toContain(entity.id);
  });
});

// Anything older than this is garbage from a PREVIOUS session, not this one.
//
// Getting "when did this run start" from inside a test is harder than it
// looks. `new Date()` at import is wrong because files run serially and the
// ones before this have unswept fixtures in flight. `process.uptime()` is also
// wrong - vitest gives each file its own worker, so uptime restarts and the
// same problem returns wearing a different hat.
//
// So this deliberately does not try. A full billing run takes minutes; an hour
// is comfortably longer than any run and comfortably shorter than "left over
// from yesterday". What it measures is unambiguous: entities that outlived a
// whole session, which is the only thing global-teardown could have missed.
const STALE_BEFORE = new Date(Date.now() - 60 * 60 * 1000);

describe("the database is not accumulating unowned entities", () => {
  it("reports how many exist, and fails if the estate has drifted", async () => {
    const [total, tenants, strays] = await Promise.all([
      prisma.billableEntity.count(),
      prisma.tenant.count(),
      // Entities that survived a whole previous session. The suite's own
      // in-flight fixtures are excluded by construction - the other files
      // legitimately hold unowned entities until global-teardown sweeps them,
      // and counting those would fail a perfectly healthy run.
      prisma.billableEntity.count({
        where: { tenants: { none: {} }, createdAt: { lt: STALE_BEFORE } },
      }),
    ]);

    if (strays > 0) {
      console.warn(
        `[ownership] ${strays} unowned billable entities are more than an hour old ` +
          `(${total} total, ${tenants} tenants). Each is a row nothing in the product can ` +
          `reach. If this is climbing, global-teardown.ts is not catching a shape.`,
      );
    }

    // A ratchet, not zero. Some strays are legitimate history - a provisioning
    // that failed mid-way is SUPPOSED to leave evidence - and failing the whole
    // billing suite over pre-existing data would just get this test deleted.
    // It fails when accumulation becomes absurd relative to the real estate,
    // which is what 11,981-against-3 looked like before the sweep existed.
    expect(
      strays,
      `unowned entities have outgrown the estate: ${strays} surviving vs ${tenants} tenants`,
    ).toBeLessThan(Math.max(50, tenants * 20));
  });
});
