/**
 * GET /api/setup/state — day one, as a state machine.
 *
 * The reasoning lives in @chatcenter/shared (setup-state.ts); this route's only
 * job is to find out what is true. That split is deliberate: the ordering and
 * the "what should I do now" decision are product rules that must be identical
 * everywhere, and a copy of them in a route handler is a copy that drifts.
 *
 * Open to any tenant member. Day one is a screen the whole team lands on, and a
 * new member who cannot see why the workspace is not live yet cannot help.
 */
import { Router, type Request, type Response } from "express";
import {
  prisma,
  authenticate,
  resolveTenant,
  requireOnboardingOrActiveTenant,
  computeSetupState,
  type SetupFacts,
} from "@chatcenter/shared";

const router = Router();
// requireOnboardingOrActiveTenant, NOT requireActiveTenant. This is the screen
// a workspace sees on day one, and a day-one workspace is PENDING_ONBOARDING
// with no plan yet - so the full-application gate refuses the endpoint that
// exists to tell it what to do next. Same chicken-and-egg the middleware's own
// comment describes for connecting the core system.
router.use("/setup/state", authenticate, resolveTenant, requireOnboardingOrActiveTenant());

router.get("/setup/state", async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantId!;

    const [channel, store, knowledge, employee, policy, testConv, teammate, tenant] =
      await Promise.all([
        prisma.channelAccount.findFirst({
          where: { tenantId, connectionStatus: "CONNECTED" },
          select: { createdAt: true },
          orderBy: { createdAt: "asc" },
        }),
        prisma.tenantIntegration.findFirst({
          where: { tenantId, status: "CONNECTED", integration: { category: "ECOMMERCE" } },
          select: { connectedAt: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        }),
        prisma.knowledgeDocument.findFirst({
          where: { tenantId },
          select: { createdAt: true },
          orderBy: { createdAt: "asc" },
        }),
        prisma.aIAgent.findFirst({
          where: { tenantId },
          select: { createdAt: true },
          orderBy: { createdAt: "asc" },
        }),
        prisma.businessPolicy.findUnique({
          where: { tenantId },
          select: { data: true, updatedAt: true },
        }),
        // The rehearsal: a conversation the team marked as a test.
        prisma.conversation.findFirst({
          where: { tenantId, isTest: true },
          select: { createdAt: true },
          orderBy: { createdAt: "asc" },
        }),
        // A SECOND active member - the owner alone is not an invited team.
        prisma.user.findMany({
          where: { tenantId, isActive: true },
          select: { createdAt: true },
          orderBy: { createdAt: "asc" },
          take: 2,
        }),
        prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true, createdAt: true },
        }),
      ]);

    const policyData = (policy?.data ?? {}) as Record<string, unknown>;

    const facts: SetupFacts = {
      completed: {
        connect_channel: channel?.createdAt ?? null,
        connect_store: store?.connectedAt ?? store?.createdAt ?? null,
        add_knowledge: knowledge?.createdAt ?? null,
        hire_employee: employee?.createdAt ?? null,
        // "Set or unset" is all the screen needs - it does not render the rules
        // themselves, so their content stays out of this response.
        handover_rules: hasHandoverRules(policyData) ? (policy?.updatedAt ?? null) : null,
        approval_limits: hasApprovalLimits(policyData) ? (policy?.updatedAt ?? null) : null,
        test_conversation: testConv?.createdAt ?? null,
        invite_team: teammate.length > 1 ? (teammate[1]?.createdAt ?? null) : null,
      },
      isLive: tenant?.status === "ACTIVE",
      trial: await readTrial(tenantId),
    };

    res.json({ data: computeSetupState(facts) });
  } catch (err) {
    console.error("Setup state error:", err);
    res.status(500).json({ error: "Failed to get setup state" });
  }
});

/** Has the owner decided when GOTCHA hands a conversation to a person? */
function hasHandoverRules(data: Record<string, unknown>): boolean {
  const keywords = data.escalationKeywords;
  const topics = data.blockedTopics;
  return (
    (Array.isArray(keywords) && keywords.length > 0) ||
    (Array.isArray(topics) && topics.length > 0)
  );
}

/** Has the owner decided what GOTCHA may do without asking? */
function hasApprovalLimits(data: Record<string, unknown>): boolean {
  return (
    typeof data.maxDiscountPercent === "number" ||
    typeof data.refundRequiresApproval === "boolean" ||
    typeof data.maxRefundAmount === "number"
  );
}

/**
 * Trial headroom, or null when the tenant is not on one.
 *
 * Null is not "no days left" - it is "this is not a trial", and rendering a
 * countdown for a paying customer would be a small lie on their first screen.
 */
async function readTrial(
  tenantId: string,
): Promise<{ daysRemaining: number | null; conversationsUsed: number } | null> {
  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId },
    include: { entity: { include: { subscription: true } } },
  });
  const sub = link?.entity.subscription;
  if (!sub?.trialEndsAt) return null;

  const msLeft = sub.trialEndsAt.getTime() - Date.now();
  const conversationsUsed = await prisma.conversation.count({
    where: {
      tenantId,
      isTest: false,
      createdAt: { gte: sub.currentPeriodStart ?? new Date(0) },
    },
  });

  return {
    // Clamped at zero: an expired trial has none left, not a negative number.
    daysRemaining: Math.max(0, Math.ceil(msLeft / 86_400_000)),
    conversationsUsed,
  };
}

export default router;
