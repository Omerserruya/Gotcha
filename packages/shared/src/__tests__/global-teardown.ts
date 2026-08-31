/**
 * Sweep the billable entities this package's tests leave behind.
 *
 * services/billing has had this since its own suite was found leaking a few
 * hundred rows per run. `packages/shared` had no vitest config at all, so it
 * had no teardown either - and three of its files create BillableEntity rows:
 * paid-access-gate, enforcement-tenant-state and tenant-plan-access.
 *
 * The result was a leak nobody could see from either side. The billing suite's
 * ownership guard counts unowned entities across the WHOLE database, so it was
 * the thing that eventually failed, while the rows it was complaining about
 * were being created by a different package's tests. Measured when this was
 * added: 391 unowned entities, 195 of them created within a few hours, all
 * carrying the `gate-` and `enf-` prefixes that belong to this package.
 *
 * Deliberately identical in behaviour to services/billing's copy rather than
 * shared between them: the two suites run as separate processes with separate
 * configs, and a common module would have to live somewhere that neither
 * package's build owns.
 */
import { prisma } from "../lib/prisma";

// Captured at module load, i.e. before any test file runs.
const SUITE_STARTED_AT = new Date();

export async function teardown(): Promise<void> {
  try {
    let removed = 0;

    // Deleting a TENANT cascades to its link rows, which orphans entities that
    // were still linked when an earlier pass listed them. One pass is not
    // always enough, and a partial sweep is worse than none: it looks like the
    // leak is handled while the count creeps up.
    for (let pass = 0; pass < 4; pass++) {
      const orphans = await prisma.billableEntity.findMany({
        where: { createdAt: { gte: SUITE_STARTED_AT }, tenants: { none: {} } },
        select: { id: true },
      });
      if (orphans.length === 0) break;
      const ids = orphans.map((o) => o.id);
      await prisma.subscription.deleteMany({ where: { billableEntityId: { in: ids } } });
      await prisma.billingProfile.deleteMany({ where: { billableEntityId: { in: ids } } });
      removed += (await prisma.billableEntity.deleteMany({ where: { id: { in: ids } } })).count;
    }

    if (removed === 0) return;

    const residue = await prisma.billableEntity.count({
      where: { createdAt: { gte: SUITE_STARTED_AT }, tenants: { none: {} } },
    });
    console.log(
      `[shared-teardown] removed ${removed} unowned billable entities created by this run` +
        (residue > 0
          ? `; ${residue} could NOT be removed - the sweep is missing a shape, do not assume the leak is closed`
          : ""),
    );
  } catch (err: any) {
    // Never fail a green run over cleanup. A noisy warning is the right
    // outcome; a suite that reports failure because tidying went wrong is not.
    console.warn("[shared-teardown] sweep failed:", err?.message ?? err);
  }
}
