/**
 * GET /api/usage/allowance — the tenant's conversation headroom this period.
 *
 * Home draws a progress bar from this and says "at today's pace that lasts
 * until 12 September". `/api/usage/stats` and `/api/usage/by-tenant` cannot
 * serve it: both are requireSystemAdmin() and neither returns a limit or the
 * period boundaries. The allowance lived in billing with no tenant-facing read
 * at all, so the one number a customer most wants about their plan was the one
 * they could not see.
 *
 * The projection is computed HERE rather than in the browser. A client working
 * out its own run-rate would put a different date on Home than the one billing
 * acts on, and the first time those disagree is the last time anyone believes
 * either.
 */
import { Router, type Request, type Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireActiveTenant,
} from "@chatcenter/shared";

const router = Router();
// Every member of the workspace, on purpose: the bar on Home is the team's
// shared headroom (a count and a date, no money and no customer data), and an
// agent running out of conversations needs to see it coming (2026-10-09 review).
router.use("/usage/allowance", authenticate, resolveTenant, requireActiveTenant());

/** Below this many days of headroom the bar turns amber and a notice is due. */
export const ALLOWANCE_WARNING_DAYS = 7;

router.get("/usage/allowance", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;

    // A subscription belongs to a BILLABLE ENTITY, not to a tenant: one entity
    // can bill for several tenants. The link table is the only correct way in,
    // and going straight at Subscription would silently miss every tenant that
    // is billed as part of a group.
    const link = await prisma.billableEntityTenant.findUnique({
      where: { tenantId },
      include: { entity: { include: { subscription: true } } },
    });
    const subscription = link?.entity.subscription ?? null;

    // No subscription is not an error and not a zero allowance - it is a
    // tenant on no plan, and the honest answer is that there is no limit to
    // report rather than a limit of nothing.
    const now = new Date();
    const periodStart =
      subscription?.currentPeriodStart ??
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const periodEnd =
      subscription?.currentPeriodEnd ??
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    // The plan's monthly conversation volume, when one is selected. Null means
    // uncapped, which is a real state and must not be rendered as a full bar.
    let limit: number | null = null;
    if (subscription?.chatVolumeOptionKey) {
      // Plans are versioned, and the volume presets belong to the exact
      // version the tenant is on - reading the latest would quote a limit the
      // customer never agreed to.
      const plan = await prisma.plan.findUnique({
        where: { key_version: { key: subscription.planKey, version: subscription.planVersion } },
        select: { id: true },
      });
      if (plan) {
        const option = await prisma.planVolumeOption.findFirst({
          where: { planId: plan.id, key: subscription.chatVolumeOptionKey },
          select: { monthlyVolume: true },
        });
        limit = option?.monthlyVolume ?? null;
      }
    }

    const used = await prisma.conversation.count({
      where: {
        tenantId,
        // The rehearsal the team ran during setup is not billable volume, and
        // showing it here would have day one start with the bar already moved.
        //
        // BOTH conditions are required and `isTest` alone does not achieve the
        // sentence above: sandbox conversations are written with
        // `isTest = false`, so filtering on it let every AI-employee test the
        // team ran count against the plan. On the dev tenant `isTest` excludes
        // NOTHING and the sandbox prefix excludes the only non-billable row -
        // the guard was inert exactly where it was needed.
        //
        // The prefix is the product's own definition of a sandbox conversation
        // (services/ai/.../sandbox-conversation.service.ts:114), so this cannot
        // drift from what the test chat actually writes.
        //
        // Wrong in the direction that costs the customer: an over-count inflates
        // the volume billed against the plan AND pulls projectedExhaustionAt
        // earlier, so the runway reads shorter than it is.
        isTest: false,
        NOT: { customerExternalId: { startsWith: "sandbox:" } },
        createdAt: { gte: periodStart, lt: periodEnd },
      },
    });

    return res.json({
      data: {
        used,
        limit,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        projectedExhaustionAt: projectExhaustion({ used, limit, periodStart, periodEnd, now }),
      },
    });
  } catch (err) {
    console.error("Usage allowance error:", err);
    return res.status(500).json({ error: "Failed to get usage allowance" });
  }
});

/**
 * When the allowance runs out at the pace set so far this period.
 *
 * Null whenever the answer would be a guess rather than a projection:
 *   - uncapped plans have nothing to exhaust
 *   - a period that has barely started has no pace worth extrapolating, and
 *     one busy first morning would otherwise predict exhaustion by Thursday
 *   - a pace that finishes the period inside the allowance has no date
 *
 * Capped at the period end: "you will run out after your allowance resets" is
 * not a thing that happens, and rendering it would put a date on Home that the
 * billing cycle contradicts.
 */
function projectExhaustion(input: {
  used: number;
  limit: number | null;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
}): string | null {
  const { used, limit, periodStart, periodEnd, now } = input;
  if (limit === null || limit <= 0) return null;
  if (used >= limit) return now.toISOString();

  const elapsedMs = now.getTime() - periodStart.getTime();
  const MIN_ELAPSED_MS = 24 * 60 * 60 * 1000;
  if (elapsedMs < MIN_ELAPSED_MS || used === 0) return null;

  const perMs = used / elapsedMs;
  if (perMs <= 0) return null;

  const exhaustionMs = now.getTime() + (limit - used) / perMs;
  if (exhaustionMs >= periodEnd.getTime()) return null;
  return new Date(Math.round(exhaustionMs)).toISOString();
}

export { projectExhaustion };
export default router;
