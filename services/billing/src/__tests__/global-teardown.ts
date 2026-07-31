/**
 * Sweep the billable entities the suite created but did not clean up.
 *
 * Billing integration tests run against the real database. Almost every file
 * creates a BillableEntity for its fixtures - only 2 of 41 ever deleted one.
 * The rest tidy up their tenants, checkouts, attempts and quotes and leave the
 * entity behind, so every run leaked a few hundred rows into the shared dev
 * database. Measured before this existed: 11,984 billable_entities against 3
 * real tenants, 11,981 of them orphaned, with display names that are just the
 * suites' own run prefixes (act-, mc-, pb-, rf-, enf-, ...).
 *
 * That is not merely untidy. A BillableEntity with no tenant link cannot be
 * billed and cannot be reached - it is unowned. It also makes every "how many
 * customers are there" query wrong, and it is exactly the kind of noise that
 * makes a real orphan (a provisioning failure that left an entity stranded)
 * impossible to spot.
 *
 * Done here rather than in 39 afterAll blocks: one place that cannot be
 * forgotten by the next test file, and it needs no cooperation from suites
 * that already exist.
 *
 * Deliberately narrow. It deletes ONLY entities that
 *   - have no tenant link at all, and
 *   - were created after this process started.
 * A pre-existing orphan is left alone (that is a data question, not a test
 * question) and a linked entity is never touched no matter how old.
 */

import { prisma } from "@chatcenter/shared";

// Captured at module load, i.e. before any test file runs.
const SUITE_STARTED_AT = new Date();

export async function teardown(): Promise<void> {
  try {
    const orphans = await prisma.billableEntity.findMany({
      where: {
        createdAt: { gte: SUITE_STARTED_AT },
        tenants: { none: {} },
      },
      select: { id: true },
    });

    if (orphans.length === 0) return;

    const ids = orphans.map((o) => o.id);

    // Children first. These have their own FKs onto the entity, and the point
    // of the sweep is to leave nothing behind rather than to rely on whatever
    // cascade happens to be configured.
    await prisma.subscription.deleteMany({ where: { billableEntityId: { in: ids } } });
    await prisma.billingProfile.deleteMany({ where: { billableEntityId: { in: ids } } });
    const { count } = await prisma.billableEntity.deleteMany({ where: { id: { in: ids } } });

    console.log(`[billing-teardown] removed ${count} unowned billable entities created by this run`);
  } catch (err: any) {
    // Never fail the suite on cleanup. A leaked row is a smell; a red build
    // from the janitor is worse, and the invariant test reports the leak
    // anyway.
    console.warn(`[billing-teardown] sweep failed (non-fatal): ${err?.message}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}
