import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  prisma,
  authenticate,
  requireSystemAdmin,
  requirePlatformPermission,
  PLATFORM_PERMISSIONS,
  validate,
  ensureIdentity,
  createRecoveryLink,
  publishEvent,
  crossTenantMiddleware,
  AI_MODEL_PRICING,
  resolveModelPricing,
  AI_FEATURE_CATEGORIES,
  AI_CATEGORY_ORDER,
  categorySqlCase,
  categoryLabel,
  type AiFeatureCategory,
  writeAudit,
  AuditAction,
  seedTenantRbac,
  ALL_LICENSE_KEYS,
  resolveTenantPlanAccess,
  resolveTenantPlanAccessBatch,
} from "@chatcenter/shared";
import { eraseTenant } from "../services/gdpr.service";
import { sendOnboardingEmail, sendPaidOnboardingEmail} from "../services/notification.service";
import { createProvisioningRequest, runProvisioning, provisioningStatusForTenant } from "../services/billing-provisioning.service";
import { scheduleOnboardingNudge, triggerNudgeNow } from "../services/nudge-engine.service";
import { listOnboardingSnapshots, getOnboardingSnapshot } from "../services/onboarding-state.service";
import { inviteUser, syncIdentityNameByUser, syncMembershipAccess } from "../services/invitation.service";

const router = Router();

/**
 * The license domains a POC's feature areas are chosen from.
 *
 * Derived from the permission catalog, not listed, so a domain added to the
 * product cannot go missing here - and under default-ALLOW license semantics, a
 * missing domain is a GRANTED one.
 */
const LICENSE_DOMAINS: string[] = Array.from(
  new Set(ALL_LICENSE_KEYS.map((k) => k.split(":")[0] as string)),
).sort();

// System-admin routes legitimately need cross-tenant reads (list all
// tenants, aggregate usage across tenants, create new tenant admins,
// etc). Enable the Prisma tenant-guard opt-out for this entire router.
// Safe because every handler below is already gated by authenticate +
// requireSystemAdmin() - only SYSTEM_ADMIN users ever reach this code.
router.use(crossTenantMiddleware);

// ─── System Admin Login ──────────────────────────────────────
//
// REMOVED. System admins authenticate through Authentik like everyone else;
// there is no second password login. SYSTEM_ADMIN is a local RBAC role, so
// requireSystemAdmin() still gates every route below - the role is read from
// the database after Authentik proves the identity.

// ─── System Stats ────────────────────────────────────────────

router.get("/stats", authenticate, requireSystemAdmin(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const [tenantCount, userCount, conversationCount, messageCount, channelCount] = await Promise.all([
      prisma.tenant.count(),
      prisma.user.count(),
      prisma.conversation.count(),
      prisma.message.count(),
      prisma.channelAccount.count({ where: { connectionStatus: "CONNECTED" } }),
    ]);

    const activeTenants = await prisma.tenant.count({ where: { isActive: true } });

    const recentTenants = await prisma.tenant.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, slug: true, createdAt: true, isActive: true },
    });

    res.json({
      data: {
        tenants: { total: tenantCount, active: activeTenants },
        users: userCount,
        conversations: conversationCount,
        messages: messageCount,
        connectedChannels: channelCount,
        recentTenants,
      },
    });
  } catch (err) {
    console.error("System stats error:", err);
    res.status(500).json({ error: "Failed to fetch system stats" });
  }
});

// ─── List Tenants ────────────────────────────────────────────

router.get("/tenants", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const search = (req.query.search as string) || "";
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const skip = (page - 1) * limit;

    const where = search
      ? { OR: [{ name: { contains: search, mode: "insensitive" as const } }, { slug: { contains: search, mode: "insensitive" as const } }] }
      : {};

    const [tenants, total] = await Promise.all([
      prisma.tenant.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              users: true,
              conversations: { where: { status: { not: "CLOSED" } } },
              channelAccounts: { where: { connectionStatus: "CONNECTED" } },
            },
          },
        },
      }),
      prisma.tenant.count({ where }),
    ]);

    // Every row carries its plan state. The console used to show status alone,
    // which meant an ACTIVE tenant with no plan at all looked exactly like a
    // paying one - the single most expensive thing this screen can get wrong.
    const access = await resolveTenantPlanAccessBatch(tenants.map((t) => t.id));

    res.json({
      data: tenants.map((t) => {
        const v = access.get(t.id);
        return {
          ...t,
          planAccess: v
            ? {
                state: v.state,
                label: v.label,
                source: v.source,
                active: v.active,
                planKey: v.planKey,
                expiresAt: v.expiresAt,
                needsReview: v.needsReview,
                reviewReason: v.reviewReason ?? null,
              }
            : null,
        };
      }),
      meta: { total, page, limit },
    });
  } catch (err) {
    console.error("List tenants error:", err);
    res.status(500).json({ error: "Failed to list tenants" });
  }
});

// ─── Get Tenant Detail ───────────────────────────────────────

router.get("/tenants/:id", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id as string },
      include: {
        _count: {
          select: {
            users: true,
            conversations: true,
            messages: true,
            channelAccounts: true,
            departments: true,
            chatbotFlows: true,
          },
        },
      },
    });

    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    // Get users for this tenant
    const users = await prisma.user.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    // Get connected channels
    const channels = await prisma.channelAccount.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, channel: true, displayName: true, connectionStatus: true, isActive: true },
    });

    // Get departments
    const departments = await prisma.department.findMany({
      where: { tenantId: tenant.id },
      select: { id: true, name: true, isActive: true },
      orderBy: { name: "asc" },
    });

    const planAccess = await resolveTenantPlanAccess(tenant.id);

    res.json({
      data: {
        ...tenant,
        users,
        channels,
        departments,
        planAccess: {
          state: planAccess.state,
          label: planAccess.label,
          source: planAccess.source,
          active: planAccess.active,
          planKey: planAccess.planKey,
          planName: planAccess.planName,
          expiresAt: planAccess.expiresAt,
          needsReview: planAccess.needsReview,
          reviewReason: planAccess.reviewReason ?? null,
        },
      },
    });
  } catch (err) {
    console.error("Get tenant error:", err);
    res.status(500).json({ error: "Failed to get tenant" });
  }
});

const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://billing:4009";

/** Internal GET against the billing service. Never throws. */
async function callBillingGet(path: string): Promise<{ ok: boolean; body: any }> {
  try {
    const res = await fetch(`${BILLING_SERVICE_URL}/api/internal/billing/${path}`, {
      headers: { "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "" },
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  } catch (err: any) {
    return { ok: false, body: { error: "billing_unreachable", message: err?.message } };
  }
}

/** One internal call to the billing service. Never throws; returns a verdict. */
async function callBilling(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; body: any }> {
  try {
    const res = await fetch(`${BILLING_SERVICE_URL}/api/internal/billing/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": process.env.INTERNAL_SERVICE_KEY || "",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = await res.json().catch(() => ({}));
    return { ok: res.ok, body: parsed };
  } catch (err: any) {
    // A billing outage must not silently produce a tenant with no billing
    // state, so this is reported as a failure rather than swallowed.
    return { ok: false, body: { error: "billing_unreachable", message: err?.message } };
  }
}

// ─── Create Tenant ───────────────────────────────────────────

/**
 * Mandatory billing provisioning.
 *
 * Exactly one of PAID_PLAN or POC. "No billing" is gone: it created an
 * organization with full product access and no commercial record of why, and
 * every such tenant then had to be noticed by a person before it was ever
 * reconciled. An evaluation is a legitimate reason to not be charging someone;
 * having never decided is not.
 *
 * TRIAL, CUSTOM_PLAN and MANUAL_CONTRACT keep their own explicit paths with
 * their own rules - a manual contract in particular activates a paid plan on an
 * operator's word alone and sits behind a stronger permission than this.
 *
 * There is deliberately no price, credit or currency field for the paid path:
 * every commercial value is recomputed server-side from the option keys, and
 * sending one is a 400 rather than a silent no-op. The POC credit budget is
 * different in kind - it is not a price, it is the allowance an operator is
 * choosing to give away - so it is accepted, bounded, and audited.
 */
const billingSchema = z
  .object({
    mode: z.enum(["PAID_PLAN", "POC"]),
    planVersionId: z.string().min(1).optional(),
    chatVolumeOptionKey: z.string().min(1).nullable().optional(),
    voiceVolumeOptionKey: z.string().min(1).nullable().optional(),
    billingInterval: z.enum(["MONTHLY", "ANNUAL"]).optional(),
    paymentRequiredBeforeAccess: z.boolean().optional(),
    commercialNote: z.string().max(2000).optional(),
    // ── POC ──
    pocCredits: z.number().int().positive().max(1_000_000).optional(),
    pocExpiresAt: z.string().datetime().optional(),
    pocFeatureAreas: z.array(z.string().min(1)).optional(),
  })
  // strict() BEFORE refine(): a stray `price` or `credits` is rejected, not
  // silently ignored, so a caller cannot keep sending one believing it works.
  .strict()
  .refine((b) => b.mode !== "PAID_PLAN" || !!b.planVersionId, {
    message: "planVersionId is required for PAID_PLAN",
    path: ["planVersionId"],
  })
  .refine((b) => b.mode !== "POC" || typeof b.pocCredits === "number", {
    message: "pocCredits is required for POC",
    path: ["pocCredits"],
  })
  .refine((b) => b.mode !== "POC" || !!b.pocExpiresAt, {
    // An evaluation with no end is not an evaluation, it is free product.
    message: "pocExpiresAt is required for POC",
    path: ["pocExpiresAt"],
  })
  .refine((b) => b.mode !== "POC" || (b.pocFeatureAreas?.length ?? 0) > 0, {
    message: "pocFeatureAreas must name at least one feature area",
    path: ["pocFeatureAreas"],
  });

/** Exported so the policy can be tested as the rule it is, not via a mock. */
export const createTenantSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  adminEmail: z.string().email(),
  adminName: z.string().min(1),
  // Required. An organization without a commercial decision is the thing this
  // whole route now exists to prevent.
  billing: billingSchema,
});

router.post("/tenants", authenticate, requireSystemAdmin(), validate(createTenantSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, slug, adminEmail, adminName, billing } = req.body;
    const paid = billing.mode === "PAID_PLAN";
    const isPoc = billing.mode === "POC";
    const actorId = (req as any).user?.userId as string | undefined;

    // Validate the POC selection BEFORE anything is created, for the same
    // reason the paid one is: a rejected expiry or an unknown feature area must
    // fail while there is still no tenant to roll back.
    const pocExpiresAt = isPoc ? new Date(billing.pocExpiresAt) : null;
    if (isPoc) {
      if (!pocExpiresAt || Number.isNaN(pocExpiresAt.getTime()) || pocExpiresAt <= new Date()) {
        res.status(400).json({ error: "Invalid billing selection", code: "expiry_must_be_in_the_future" });
        return;
      }
      const unknown = (billing.pocFeatureAreas as string[]).filter((f) => !LICENSE_DOMAINS.includes(f));
      if (unknown.length) {
        res.status(400).json({ error: "Invalid billing selection", code: "unknown_feature_domain", domains: unknown });
        return;
      }
    }

    // Validate the commercial selection BEFORE anything is created. A bad plan
    // or volume key must fail while there is still no tenant to roll back.
    if (paid) {
      const check = await callBilling("validate-paid-plan", {
        planVersionId: billing.planVersionId,
        chatVolumeOptionKey: billing.chatVolumeOptionKey ?? null,
        voiceVolumeOptionKey: billing.voiceVolumeOptionKey ?? null,
        billingInterval: billing.billingInterval,
      });
      if (!check.ok) {
        res.status(400).json({ error: "Invalid billing selection", code: check.body?.error });
        return;
      }
      void writeAudit({
        tenantId: null as any, actorType: "user", actorId,
        action: AuditAction.PAID_TENANT_PROVISIONING_REQUESTED,
        targetType: "plan_version", targetId: billing.planVersionId,
        metadata: { slug, chatVolumeOptionKey: billing.chatVolumeOptionKey ?? null, voiceVolumeOptionKey: billing.voiceVolumeOptionKey ?? null },
      });
    }

    // Check slug uniqueness
    const existing = await prisma.tenant.findUnique({ where: { slug } });
    if (existing) {
      res.status(409).json({ error: "A tenant with this slug already exists" });
      return;
    }

    // Provision the identity BEFORE the transaction. Authentik is a remote
    // system and cannot participate in a database transaction; doing it first
    // means a failure here aborts cleanly with no tenant created, rather than
    // leaving a tenant whose admin can never log in.
    const identity = await ensureIdentity(adminEmail, adminName);

    // Create tenant + admin membership + onboarding tracker in transaction.
    // The Identity row is upserted first (outside the tx is fine - it is
    // keyed by the immutable subject and safe to leave behind on rollback).
    const localIdentity = await prisma.identity.upsert({
      where: { authentikSubject: identity.subject },
      update: {},
      create: {
        authentikSubject: identity.subject,
        email: adminEmail.toLowerCase(),
        name: adminName,
      },
    });

    const result = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        // A paid tenant starts owing money. PENDING_PAYMENT denies the paid
        // product at the shared access matrix while still permitting identity
        // onboarding and payment setup.
        data: { name, slug, status: paid ? "PENDING_PAYMENT" : "PENDING_ADMIN_SETUP" },
      });

      const admin = await tx.user.create({
        data: {
          tenantId: tenant.id,
          identityId: localIdentity.id,
          email: adminEmail,
          name: adminName,
          role: "ADMIN",
        },
      });

      // Initialize onboarding tracker
      await tx.tenantOnboarding.create({
        data: { tenantId: tenant.id, currentStep: "BUSINESS_PROFILE" },
      });

      return { tenant, admin };
    });

    // Seed the built-in TenantRole rows + the admin's role assignment so the
    // Users page role picker and fine-grained permissions work from day one.
    // Degrade-soft: the boot-time sweep re-covers any tenant this misses.
    await seedTenantRbac(result.tenant.id).catch((err) =>
      console.error("[system] rbac seed for new tenant failed:", err?.message),
    );

    void writeAudit({
      tenantId: result.tenant.id, actorType: "user", actorId: (req as any).user?.userId,
      action: AuditAction.TENANT_CREATED, targetType: "tenant", targetId: result.tenant.id,
      metadata: { name, slug, adminEmail },
    });
    void writeAudit({
      tenantId: result.tenant.id, actorType: "user", actorId: (req as any).user?.userId,
      action: AuditAction.USER_CREATED, targetType: "user", targetId: result.admin.id,
      metadata: { email: adminEmail, role: "ADMIN" },
    });

    // Publish TenantCreated event
    await publishEvent({
      event: "tenant:created",
      tenantId: result.tenant.id,
      data: {
        tenantName: name,
        tenantSlug: slug,
        adminEmail,
        adminName,
      },
    });

    // Billing scaffolding. The REQUEST is made durable first, so a billing
    // failure leaves a recoverable state rather than a tenant whose requested
    // plan is recorded nowhere. Both modes go through this: a POC that failed
    // halfway is exactly as stuck as a paid one, and just as repairable.
    let paidProvisioning: any = null;
    let pocProvisioning: any = null;
    {
      const provRequest = await createProvisioningRequest({
        tenantId: result.tenant.id,
        requestedBy: actorId ?? null,
        selection: paid
          ? {
              mode: "PAID_PLAN",
              planVersionId: billing.planVersionId,
              chatVolumeOptionKey: billing.chatVolumeOptionKey ?? null,
              voiceVolumeOptionKey: billing.voiceVolumeOptionKey ?? null,
              billingInterval: billing.billingInterval ?? null,
              commercialNote: billing.commercialNote ?? null,
            }
          : {
              mode: "POC",
              planVersionId: null,
              commercialNote: billing.commercialNote ?? null,
              pocCredits: billing.pocCredits,
              pocExpiresAt,
              pocFeatureAreas: billing.pocFeatureAreas ?? [],
            },
      });

      const outcome = await runProvisioning(provRequest.id);
      const prov = { ok: outcome.ok, body: outcome.body ?? { error: outcome.failureCode } };

      if (!prov.ok) {
        // The tenant exists but plan setup did not complete. It is inert: a
        // PENDING_PAYMENT tenant is denied the paid product by the access
        // matrix, and a POC tenant that never got its subscription has no
        // access source, which the same matrix now also denies. The durable
        // provisioning request holds exactly what was requested, so REPAIR can
        // finish the job without the operator re-entering anything. No email is
        // sent, because there is nothing yet to send anyone to.
        void writeAudit({
          tenantId: result.tenant.id, actorType: "user", actorId,
          action: AuditAction.PAID_TENANT_PROVISIONING_FAILED,
          targetType: "tenant", targetId: result.tenant.id,
          metadata: { mode: billing.mode, failureCode: prov.body?.error ?? "unknown" },
        });
        res.status(502).json({
          error: "Tenant created but plan setup did not complete",
          code: outcome.failureCode ?? "provisioning_failed",
          data: {
            tenant: { id: result.tenant.id, name, slug, status: result.tenant.status },
            admin: { id: result.admin.id, email: adminEmail, name: adminName },
            billing: {
              mode: billing.mode,
              provisioningState: outcome.state,
              // Repair, not "create the tenant again".
              canRepair: outcome.state === "FAILED_RETRYABLE" || outcome.state === "PENDING",
              paidAccessGranted: false,
              emailSent: false,
            },
          },
        });
        return;
      }

      if (isPoc) {
        pocProvisioning = prov.body;
        void writeAudit({
          tenantId: result.tenant.id, actorType: "user", actorId,
          action: AuditAction.POC_PROVISIONED,
          targetType: "tenant", targetId: result.tenant.id,
          metadata: {
            credits: billing.pocCredits,
            expiresAt: pocExpiresAt?.toISOString() ?? null,
            featuresEnabled: pocProvisioning?.featuresEnabled ?? billing.pocFeatureAreas,
            note: billing.commercialNote ?? null,
          },
        });
      } else {
        paidProvisioning = prov.body;
      }
    }

    if (paid) {
      void writeAudit({
        tenantId: result.tenant.id, actorType: "user", actorId,
        action: AuditAction.PAID_TENANT_CREATED,
        targetType: "tenant", targetId: result.tenant.id,
        metadata: { planKey: paidProvisioning.summary?.planKey, planVersion: paidProvisioning.summary?.planVersion },
      });
      void writeAudit({
        tenantId: result.tenant.id, actorType: "user", actorId,
        action: AuditAction.PENDING_CHECKOUT_CREATED,
        targetType: "checkout", targetId: paidProvisioning.checkoutReference,
        metadata: { amount: paidProvisioning.summary?.amount, currency: paidProvisioning.summary?.currency },
      });
      // The link id is audited; the raw token never is.
      void writeAudit({
        tenantId: result.tenant.id, actorType: "user", actorId,
        action: AuditAction.PAYMENT_CONTINUATION_LINK_CREATED,
        targetType: "continuation_link", targetId: paidProvisioning.link?.id,
        metadata: { expiresAt: paidProvisioning.link?.expiresAt },
      });
    }

    // Send onboarding email with magic link (non-blocking).
    if (paid && paidProvisioning) {
      sendPaidOnboardingEmail({
        tenantId: result.tenant.id,
        adminEmail,
        adminName,
        tenantName: name,
        adminUserId: result.admin.id,
        continuationToken: paidProvisioning.link.token,
        checkoutReference: paidProvisioning.checkoutReference,
        linkExpiresAt: new Date(paidProvisioning.link.expiresAt),
        // Rendered from the IMMUTABLE snapshot, never the live plan row.
        planName: paidProvisioning.summary.planName,
        amount: paidProvisioning.summary.amount,
        currency: paidProvisioning.summary.currency,
        includedCredits: paidProvisioning.summary.includedCredits,
      }).catch((err) => {
        // Delivery failure must not activate anything. Resend is the repair.
        console.error("Failed to send paid onboarding email:", err?.message ?? err);
      });
    } else {
      sendOnboardingEmail(result.tenant.id, adminEmail, adminName, name, slug, result.admin.id).catch((err) => {
        console.error("Failed to send onboarding email:", err);
      });
    }

    // Arm the onboarding nudge so a tenant that never starts gets a follow-up.
    scheduleOnboardingNudge(result.tenant.id, "1d").catch(() => {});

    res.status(201).json({
      data: {
        tenant: { id: result.tenant.id, name: result.tenant.name, slug: result.tenant.slug, status: result.tenant.status },
        admin: { id: result.admin.id, email: result.admin.email, name: result.admin.name },
        // Safe summary only. The raw continuation token is never returned by
        // any API - it exists solely for the one email that carries it.
        ...(pocProvisioning
          ? {
              billing: {
                mode: "POC",
                credits: pocProvisioning.credits,
                expiresAt: pocProvisioning.expiresAt,
                featuresEnabled: pocProvisioning.featuresEnabled,
                featuresDenied: pocProvisioning.featuresDenied,
                // Said plainly, because the operator is giving product away and
                // should be certain nothing will ever be charged for it.
                charges: "none",
                renewal: "none",
                paidAccessGranted: true,
              },
            }
          : {}),
        ...(paidProvisioning
          ? {
              billing: {
                mode: "PAID_PLAN",
                checkoutReference: paidProvisioning.checkoutReference,
                planName: paidProvisioning.summary.planName,
                amount: paidProvisioning.summary.amount,
                currency: paidProvisioning.summary.currency,
                includedCredits: paidProvisioning.summary.includedCredits,
                billingInterval: paidProvisioning.summary.billingInterval,
                linkExpiresAt: paidProvisioning.link.expiresAt,
                paidAccessGranted: false,
              },
            }
          : {}),
      },
    });
  } catch (err) {
    console.error("Create tenant error:", err);
    res.status(500).json({ error: "Failed to create tenant" });
  }
});

// ─── Manual External Contract ───────────────────────────────

/**
 * Activate a tenant whose payment arrived outside the product.
 *
 * Behind a STRONGER permission than provisioning, because it activates a paid
 * subscription with no payment processor involved: the only evidence is an
 * operator asserting the money arrived. Every field below is therefore
 * mandatory, and all of it is audited.
 *
 * It never claims an iCount payment occurred and creates no Charge row.
 */
const manualContractSchema = z
  .object({
    amount: z.number().positive(),
    currency: z.string().min(3).max(3),
    externalReference: z.string().min(1).max(200),
    paymentSourceDescription: z.string().min(1).max(200),
    reason: z.string().min(1).max(1000),
  })
  .strict();

router.post(
  "/tenants/:id/activate-manual-contract",
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.BILLING_MANUAL_ACTIVATE),
  validate(manualContractSchema),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.params.id as string;
    const actorId = (req as any).user?.userId as string | undefined;
    const { amount, currency, externalReference, paymentSourceDescription, reason } = req.body;

    const result = await callBilling("activate-manual-contract", {
      tenantId, amount, currency, externalReference, paymentSourceDescription, reason,
      actor: actorId ?? null,
    });

    if (!result.ok) {
      void writeAudit({
        tenantId, actorType: "user", actorId,
        action: AuditAction.PAID_TENANT_PROVISIONING_FAILED,
        targetType: "manual_contract", targetId: tenantId,
        metadata: { failureCode: result.body?.error },
      });
      res.status(400).json({ error: result.body?.error ?? "manual_contract_failed" });
      return;
    }

    // Audited with the external reference and reason, never with a provider
    // transaction id - there isn't one, and implying otherwise would be false.
    void writeAudit({
      tenantId, actorType: "user", actorId,
      action: AuditAction.MANUAL_CONTRACT_ACTIVATED,
      targetType: "tenant", targetId: tenantId,
      metadata: {
        externalReference, paymentSource: paymentSourceDescription, reason,
        amount: String(amount), currency,
        firstActivation: result.body?.firstActivation,
      },
    });

    res.json({
      data: {
        activated: true,
        firstActivation: result.body?.firstActivation,
        tenantStatus: "ACTIVE",
        paymentSource: "MANUAL_EXTERNAL_CONTRACT",
        providerTransaction: null,
      },
    });
  },
);

/** Manual contracts on record, for the Sysadmin billing history view. */
router.get(
  "/tenants/:id/manual-contracts",
  authenticate,
  requirePlatformPermission(PLATFORM_PERMISSIONS.BILLING_READ),
  async (req: Request, res: Response): Promise<void> => {
    const result = await callBillingGet(`manual-contracts/${req.params.id}`);
    res.json({ data: result.ok ? result.body?.data ?? [] : [] });
  },
);

// ─── Repair Billing Provisioning ────────────────────────────

/**
 * Finish billing setup for a tenant whose provisioning did not complete.
 *
 * Distinct from resend on purpose. Resend REUSES an existing checkout; repair
 * CREATES the records that were never made. Letting one button do both would
 * hide a broken provisioning behind an action that looks like it worked.
 *
 * Idempotent: billing converges on the request's deterministic key, so calling
 * this repeatedly - or concurrently - yields one checkout, one initial payment
 * attempt and one active link.
 */
router.post("/tenants/:id/repair-billing-provisioning", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.params.id as string;
  const actorId = (req as any).user?.userId as string | undefined;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, status: true },
  });
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const status = await provisioningStatusForTenant(tenantId);
  if (!status) {
    res.status(409).json({ error: "NO_PROVISIONING_REQUEST" });
    return;
  }
  // The status guard belongs to the PAID path only. A paid tenant that is not
  // PENDING_PAYMENT has either already paid or was never awaiting payment, and
  // "repairing" it would create a checkout for an organization that does not owe
  // anything. A POC tenant is never PENDING_PAYMENT at all - it owes nothing -
  // so applying the same guard to it would make a half-provisioned POC
  // permanently unrepairable, which is the exact state repair exists for.
  if (status.mode !== "POC" && tenant.status !== "PENDING_PAYMENT") {
    res.status(409).json({ error: "TENANT_NOT_PENDING_PAYMENT", tenantStatus: tenant.status });
    return;
  }
  if (status.state === "COMPLETED") {
    // Nothing to repair. Resend is the right action here.
    res.status(409).json({ error: "BILLING_PROVISIONING_ALREADY_COMPLETE" });
    return;
  }

  const outcome = await runProvisioning(status.id);
  if (!outcome.ok) {
    res.status(502).json({
      error: "BILLING_PROVISIONING_FAILED",
      code: outcome.failureCode,
      state: outcome.state,
      canRepair: outcome.state === "FAILED_RETRYABLE",
    });
    return;
  }

  // The link and the email happen only AFTER a checkout exists, so a broken
  // link can never be sent.
  const admin = await prisma.user.findFirst({
    where: { tenantId, role: "ADMIN" },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true },
  });

  let emailSent = false;
  if (admin && outcome.body?.link?.token) {
    try {
      await sendPaidOnboardingEmail({
        tenantId,
        adminEmail: admin.email,
        adminName: admin.name ?? admin.email,
        tenantName: tenant.name,
        adminUserId: admin.id,
        continuationToken: outcome.body.link.token,
        checkoutReference: outcome.body.checkoutReference,
        linkExpiresAt: new Date(outcome.body.link.expiresAt),
        planName: outcome.body.summary.planName,
        amount: outcome.body.summary.amount,
        currency: outcome.body.summary.currency,
        includedCredits: outcome.body.summary.includedCredits,
      });
      emailSent = true;
      void writeAudit({
        tenantId, actorType: "user", actorId,
        action: AuditAction.PAID_TENANT_EMAIL_SENT,
        targetType: "tenant", targetId: tenantId,
      });
    } catch {
      // Billing setup is now correct; only delivery failed. Resend repairs that.
      void writeAudit({
        tenantId, actorType: "user", actorId,
        action: AuditAction.PAID_TENANT_EMAIL_FAILED,
        targetType: "tenant", targetId: tenantId,
      });
    }
  }

  void writeAudit({
    tenantId, actorType: "user", actorId,
    action: AuditAction.BILLING_PROVISIONING_REPAIRED,
    targetType: "provisioning_request", targetId: status.id,
    metadata: { checkoutReference: outcome.body?.checkoutReference, emailSent },
  });

  res.json({
    data: {
      repaired: true,
      tenantStatus: tenant.status,
      billing: {
        mode: status.mode,
        provisioningState: "COMPLETED",
        ...(status.mode === "POC"
          ? {
              credits: outcome.body?.credits,
              expiresAt: outcome.body?.expiresAt,
              featuresEnabled: outcome.body?.featuresEnabled,
              paidAccessGranted: true,
            }
          : {
              checkoutReference: outcome.body?.checkoutReference,
              planName: outcome.body?.summary?.planName,
              amount: outcome.body?.summary?.amount,
              currency: outcome.body?.summary?.currency,
              linkExpiresAt: outcome.body?.link?.expiresAt,
              emailSent,
              paidAccessGranted: false,
            }),
      },
    },
  });
});

/** Safe provisioning state for the Sysadmin tenant UI. */
router.get("/tenants/:id/billing-provisioning", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  const status = await provisioningStatusForTenant(req.params.id as string);
  res.json({ data: status });
});

// ─── Remediation: give an existing plan-less tenant a plan ──

/**
 * Assign a paid plan to an organization that has none.
 *
 * The other half of what the audit offers. A tenant with no plan can already be
 * given a POC from its own page; without this it could not be given a paid plan
 * at all, and the only remaining route would have been to create a second
 * organization and move people to it.
 *
 * It refuses a tenant that already holds access. Re-pointing a live plan is a
 * plan CHANGE - it has to reckon with an existing subscription, a period, and
 * money already taken - and doing it through a route meant for the empty case
 * would silently skip all of that.
 */
const assignPaidPlanSchema = z
  .object({
    planVersionId: z.string().min(1),
    chatVolumeOptionKey: z.string().min(1).nullable().optional(),
    voiceVolumeOptionKey: z.string().min(1).nullable().optional(),
    billingInterval: z.enum(["MONTHLY", "ANNUAL"]).optional(),
    commercialNote: z.string().max(2000).optional(),
  })
  .strict();

router.post("/tenants/:id/assign-paid-plan", authenticate, requireSystemAdmin(), validate(assignPaidPlanSchema), async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.params.id as string;
  const actorId = (req as any).user?.userId as string | undefined;
  const { planVersionId, chatVolumeOptionKey, voiceVolumeOptionKey, billingInterval, commercialNote } = req.body;

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, status: true } });
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const access = await resolveTenantPlanAccess(tenantId);
  if (access.active) {
    res.status(409).json({ error: "TENANT_ALREADY_HAS_A_PLAN", state: access.state, label: access.label });
    return;
  }

  const check = await callBilling("validate-paid-plan", {
    planVersionId,
    chatVolumeOptionKey: chatVolumeOptionKey ?? null,
    voiceVolumeOptionKey: voiceVolumeOptionKey ?? null,
    billingInterval,
  });
  if (!check.ok) {
    res.status(400).json({ error: "Invalid billing selection", code: check.body?.error });
    return;
  }

  // The tenant now owes its first payment, which is what PENDING_PAYMENT means.
  // Set BEFORE provisioning: if billing fails, the tenant must be left in the
  // state that denies the paid product, not the one that grants it.
  await prisma.tenant.update({ where: { id: tenantId }, data: { status: "PENDING_PAYMENT" } });

  const provRequest = await createProvisioningRequest({
    tenantId,
    requestedBy: actorId ?? null,
    selection: {
      mode: "PAID_PLAN",
      planVersionId,
      chatVolumeOptionKey: chatVolumeOptionKey ?? null,
      voiceVolumeOptionKey: voiceVolumeOptionKey ?? null,
      billingInterval: billingInterval ?? null,
      commercialNote: commercialNote ?? null,
    },
  });

  const outcome = await runProvisioning(provRequest.id);
  if (!outcome.ok) {
    res.status(502).json({
      error: "BILLING_PROVISIONING_FAILED",
      code: outcome.failureCode,
      state: outcome.state,
      canRepair: outcome.state === "FAILED_RETRYABLE" || outcome.state === "PENDING",
    });
    return;
  }

  const admin = await prisma.user.findFirst({
    where: { tenantId, role: "ADMIN" },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true },
  });

  let emailSent = false;
  if (admin && outcome.body?.link?.token) {
    try {
      await sendPaidOnboardingEmail({
        tenantId,
        adminEmail: admin.email,
        adminName: admin.name ?? admin.email,
        tenantName: tenant.name,
        adminUserId: admin.id,
        continuationToken: outcome.body.link.token,
        checkoutReference: outcome.body.checkoutReference,
        linkExpiresAt: new Date(outcome.body.link.expiresAt),
        planName: outcome.body.summary.planName,
        amount: outcome.body.summary.amount,
        currency: outcome.body.summary.currency,
        includedCredits: outcome.body.summary.includedCredits,
      });
      emailSent = true;
    } catch {
      // Setup is correct; only delivery failed. Resend repairs that.
    }
  }

  void writeAudit({
    tenantId, actorType: "user", actorId,
    action: AuditAction.PAID_TENANT_CREATED,
    targetType: "tenant", targetId: tenantId,
    metadata: { assignedToExistingTenant: true, planKey: outcome.body?.summary?.planKey, emailSent },
  });

  res.json({
    data: {
      tenantStatus: "PENDING_PAYMENT",
      billing: {
        mode: "PAID_PLAN",
        checkoutReference: outcome.body?.checkoutReference,
        planName: outcome.body?.summary?.planName,
        amount: outcome.body?.summary?.amount,
        currency: outcome.body?.summary?.currency,
        emailSent,
        paidAccessGranted: false,
      },
    },
  });
});

/**
 * The feature areas a POC may be scoped to.
 *
 * Served rather than hardcoded in the UI so the picker cannot fall behind the
 * catalog - a domain missing from the picker is one an operator cannot grant,
 * and, under default-ALLOW, one they cannot deny either.
 */
router.get("/poc-feature-domains", authenticate, requireSystemAdmin(), async (_req: Request, res: Response): Promise<void> => {
  res.json({ data: LICENSE_DOMAINS });
});

// ─── Estate-wide plan audit ─────────────────────────────────

/**
 * Every tenant, grouped by how it holds access.
 *
 * Read-only. A tenant with no plan is REPORTED, never repaired automatically:
 * assigning a paid plan would invent a commercial agreement nobody made, and
 * granting credits would just make the anomaly stop showing up.
 */
router.get("/tenants-plan-audit", authenticate, requireSystemAdmin(), async (_req: Request, res: Response): Promise<void> => {
  const report = await callBillingGet("tenant-plan-audit");
  if (!report.ok) {
    res.status(502).json({ error: "PLAN_AUDIT_UNAVAILABLE", code: report.body?.error });
    return;
  }
  res.json({ data: report.body });
});

// ─── Resend Paid Payment / Onboarding Link ──────────────────

/**
 * Issue a replacement continuation link for a tenant awaiting payment.
 *
 * Reuses the SAME checkout and the SAME payment attempt: a resend is a new
 * envelope for the existing offer, never a new offer, so the customer cannot be
 * re-priced by an administrator clicking a button. Issuing revokes the previous
 * link, so at most one is ever valid.
 */
router.post("/tenants/:id/resend-payment-link", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  const tenantId = req.params.id as string;
  const actorId = (req as any).user?.userId as string | undefined;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true, status: true },
  });
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  if (tenant.status !== "PENDING_PAYMENT") {
    res.status(409).json({ error: "Tenant is not awaiting payment", tenantStatus: tenant.status });
    return;
  }

  const admin = await prisma.user.findFirst({
    where: { tenantId, role: "ADMIN" },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true },
  });
  if (!admin) {
    res.status(409).json({ error: "Tenant has no administrator to send to" });
    return;
  }

  // Resend reuses an existing checkout. If provisioning never completed there
  // is nothing to reuse, and the operator needs repair instead.
  const provStatus = await provisioningStatusForTenant(tenantId);
  if (provStatus && provStatus.state !== "COMPLETED") {
    res.status(409).json({ error: "BILLING_PROVISIONING_INCOMPLETE", canRepair: provStatus.canRepair });
    return;
  }

  const resend = await callBilling("resend-payment-link", { tenantId, actor: actorId ?? null });
  if (!resend.ok) {
    const code = resend.body?.error ?? "PAYMENT_LINK_NOT_AVAILABLE";
    const httpStatus = code === "PAYMENT_LINK_RATE_LIMITED" ? 429 : code === "BILLING_PROVISIONING_INCOMPLETE" ? 409 : 400;
    res.status(httpStatus).json({
      error: code,
      ...(resend.body?.retryAfterSeconds ? { retryAfterSeconds: resend.body.retryAfterSeconds } : {}),
    });
    return;
  }

  const planRow = await prisma.plan.findFirst({
    where: { key: resend.body.summary.planKey, version: resend.body.summary.planVersion },
    select: { name: true },
  });

  try {
    await sendPaidOnboardingEmail({
      tenantId,
      adminEmail: admin.email,
      adminName: admin.name ?? admin.email,
      tenantName: tenant.name,
      adminUserId: admin.id,
      continuationToken: resend.body.link.token,
      checkoutReference: resend.body.checkoutReference,
      linkExpiresAt: new Date(resend.body.link.expiresAt),
      planName: planRow?.name ?? resend.body.summary.planKey,
      amount: resend.body.summary.amount,
      currency: resend.body.summary.currency,
      includedCredits: resend.body.summary.includedCredits,
      resend: true,
    });
  } catch {
    // The new link exists and the old one is revoked either way; the admin can
    // try again once the mail transport recovers.
    res.status(502).json({ error: "link_issued_but_email_failed", recoverable: true });
    return;
  }

  void writeAudit({
    tenantId, actorType: "user", actorId,
    action: AuditAction.PAYMENT_CONTINUATION_LINK_REVOKED,
    targetType: "checkout", targetId: resend.body.checkoutReference,
  });
  void writeAudit({
    tenantId, actorType: "user", actorId,
    action: AuditAction.PAYMENT_CONTINUATION_LINK_RESENT,
    targetType: "continuation_link", targetId: resend.body.link.id,
    metadata: { expiresAt: resend.body.link.expiresAt },
  });

  // Safe response: never the raw token.
  res.json({
    data: {
      resent: true,
      sentTo: admin.email,
      linkExpiresAt: resend.body.link.expiresAt,
      checkoutReference: resend.body.checkoutReference,
    },
  });
});

// ─── Resend Onboarding Link ─────────────────────────────────

router.post("/tenants/:id/resend-onboarding", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id as string },
      select: { id: true, name: true, slug: true, status: true },
    });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    if (tenant.status === "ACTIVE") {
      res.status(400).json({ error: "Tenant has already completed onboarding" });
      return;
    }

    // A paid tenant has TWO front doors, and only one of them asks for money.
    //
    // This email carries an Authentik setup link that lands the customer
    // authenticated inside the setup wizard - it says so in as many words: "no
    // login required". Sent to a tenant that owes money, it hands over the
    // identity and the wizard while the checkout sits untouched, which is
    // exactly how a paid workspace was reached without paying: the operator
    // clicked Resend onboarding, the customer followed it, created their
    // account, landed in /setup, and never saw a payment screen.
    //
    // The payment link is a different button, so this refuses and names it
    // rather than sending the customer through the wrong door politely.
    if (tenant.status === "PENDING_PAYMENT") {
      res.status(409).json({
        error: "TENANT_AWAITING_PAYMENT",
        hint: "This organization is on a paid plan and has not paid. Use Resend payment link; the onboarding email would let them into setup without paying.",
        tenantStatus: tenant.status,
      });
      return;
    }

    // Find the admin user for this tenant
    const admin = await prisma.user.findFirst({
      where: { tenantId: tenant.id, role: "ADMIN", isActive: true },
      select: { id: true, email: true, name: true },
    });
    if (!admin) {
      res.status(400).json({ error: "No active admin user found for this tenant" });
      return;
    }

    // Previous links do not need invalidating here: Authentik owns the
    // lifetime of its own recovery links.

    // Send new onboarding email with fresh magic link
    await sendOnboardingEmail(tenant.id, admin.email, admin.name, tenant.name, tenant.slug, admin.id);

    res.json({
      data: {
        message: "Onboarding link resent successfully",
        sentTo: admin.email,
      },
    });
  } catch (err) {
    console.error("Resend onboarding error:", err);
    res.status(500).json({ error: "Failed to resend onboarding link" });
  }
});

// ─── Delete Tenant (hierarchical cascade) ──────────────────
router.delete("/tenants/:id", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.params.id as string;
    const force = req.query.force === "true";

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, status: true },
    });

    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    // Must be disabled unless force
    if (tenant.status === "ACTIVE" && !force) {
      res.status(400).json({ error: "Tenant must be disabled before deletion. Use ?force=true to override." });
      return;
    }

    // Comprehensive GDPR off-boarding purge: DB (all tenant-scoped rows,
    // including UsageLog/AuditLog/consent/retention that the FK cascade misses)
    // + Qdrant vectors + Authentik identities, with a DataSubjectRequest and
    // audit trail recorded before the tenant row is removed. Replaces the old
    // partial cascade that orphaned Qdrant, UsageLog, AuditLog, and IdP data.
    const purge = await eraseTenant(tenantId, (req as any).user?.userId);

    res.json({ data: { deleted: true, tenantId, tenantName: tenant.name, ...purge } });
  } catch (err: any) {
    console.error("Delete tenant error:", err);
    res.status(500).json({ error: "Failed to delete tenant" });
  }
});

// ─── Reset Onboarding (non-destructive) ─────────────────────
//
// Returns a tenant to a brand-new onboarding state WITHOUT deleting the tenant
// or its people. Deterministic + idempotent.
//
// DELETED (everything onboarding created / derived):
//   BusinessDiscovery (discovery, health, readiness, goals, recommendations,
//   the narrated report), BusinessProfile (the confirmed understanding),
//   TenantOnboarding tracker, the generated AI employee(s) + their
//   AIAgentKnowledge links + RouterRules, onboarding departments + members,
//   and all ScheduledNudges. Tenant.status → PENDING_ONBOARDING.
//
// PRESERVED (deliberately - not onboarding artifacts, and unsafe to destroy):
//   the tenant row, its users, connected OAuth integrations + channels
//   (revoking live tokens is irreversible), and imported KnowledgeBases
//   (real customer content). The next login runs onboarding from scratch;
//   any already-connected system is simply detected as already-connected.
router.post("/tenants/:id/reset-onboarding", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.params.id as string;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const removed = await prisma.$transaction(async (tx) => {
      const agents = await tx.aIAgent.findMany({ where: { tenantId }, select: { id: true } });
      const agentIds = agents.map((a) => a.id);

      const r = {
        aiAgentKnowledge: (await tx.aIAgentKnowledge.deleteMany({ where: { aiAgentId: { in: agentIds } } })).count,
        routerRules: (await tx.routerRule.deleteMany({ where: { tenantId } })).count,
        aiAgents: (await tx.aIAgent.deleteMany({ where: { tenantId } })).count,
        departmentMembers: (await tx.departmentMember.deleteMany({ where: { department: { tenantId } } })).count,
        departments: (await tx.department.deleteMany({ where: { tenantId } })).count,
        businessDiscovery: (await (tx as any).businessDiscovery.deleteMany({ where: { tenantId } })).count,
        businessProfile: (await tx.businessProfile.deleteMany({ where: { tenantId } })).count,
        onboarding: (await tx.tenantOnboarding.deleteMany({ where: { tenantId } })).count,
        scheduledNudges: (await (tx as any).scheduledNudge.deleteMany({ where: { tenantId } })).count,
      };

      // Return to a fresh onboarding state (admin already exists → PENDING_ONBOARDING).
      await tx.tenant.update({ where: { id: tenantId }, data: { status: "PENDING_ONBOARDING" } });
      return r;
    });

    // Re-arm a fresh onboarding nudge so a reset tenant that never restarts is
    // followed up like any brand-new tenant.
    scheduleOnboardingNudge(tenantId, "1d").catch(() => {});

    res.json({ data: { reset: true, tenantId, tenantName: tenant.name, removed, status: "PENDING_ONBOARDING" } });
  } catch (err: any) {
    console.error("Reset onboarding error:", err);
    res.status(500).json({ error: "Failed to reset onboarding" });
  }
});

// ─── System Admin: Onboarding Console ───────────────────────
// One row per tenant with every onboarding milestone, derived progress,
// health, and the Next Recommended Action. The operational board.
router.get("/onboarding-console", authenticate, requireSystemAdmin(), async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await listOnboardingSnapshots();
    res.json({ data: { rows, generatedAt: new Date().toISOString() } });
  } catch (err: any) {
    console.error("Onboarding console error:", err);
    res.status(500).json({ error: "Failed to load onboarding console" });
  }
});

// Single-tenant snapshot (used by the tenant detail drawer).
router.get("/tenants/:id/onboarding-snapshot", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const snapshot = await getOnboardingSnapshot(req.params.id as string);
    if (!snapshot) { res.status(404).json({ error: "Tenant not found" }); return; }
    res.json({ data: { snapshot } });
  } catch (err: any) {
    console.error("Onboarding snapshot error:", err);
    res.status(500).json({ error: "Failed to load snapshot" });
  }
});

// Admin-triggered manual nudge - arms + delivers immediately, returns outcome.
router.post("/tenants/:id/nudge", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenantId = req.params.id as string;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }
    const result = await triggerNudgeNow(tenantId);
    res.json({ data: result });
  } catch (err: any) {
    console.error("Manual nudge error:", err);
    res.status(500).json({ error: "Failed to send nudge" });
  }
});

// ─── Update Tenant ───────────────────────────────────────────

const updateTenantSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  // Voice Phase-1 master toggle and its two sub-flags. Flipping
  // voiceCopilotEnabled is what makes /settings/voice-channels appear in
  // the tenant's sidebar (see frontend/src/lib/use-voice-flags.ts).
  voiceCopilotEnabled: z.boolean().optional(),
  voiceInboxUiEnabled: z.boolean().optional(),
  voiceIncomingEnabled: z.boolean().optional(),
});

router.patch("/tenants/:id", authenticate, requireSystemAdmin(), validate(updateTenantSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id as string } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    // Explicit allowlist (updateTenantSchema fields). slug is intentionally
    // immutable and never accepted from the body.
    const { name, isActive, voiceCopilotEnabled, voiceInboxUiEnabled, voiceIncomingEnabled } = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (isActive !== undefined) data.isActive = isActive;
    if (voiceCopilotEnabled !== undefined) data.voiceCopilotEnabled = voiceCopilotEnabled;
    if (voiceInboxUiEnabled !== undefined) data.voiceInboxUiEnabled = voiceInboxUiEnabled;
    if (voiceIncomingEnabled !== undefined) data.voiceIncomingEnabled = voiceIncomingEnabled;
    const updated = await prisma.tenant.update({
      where: { id: req.params.id as string },
      data,
      select: { id: true, name: true, slug: true, isActive: true, updatedAt: true },
    });

    void writeAudit({
      tenantId: updated.id, actorType: "user", actorId: (req as any).user?.userId,
      action: isActive === false ? AuditAction.TENANT_DEACTIVATED
        : isActive === true ? AuditAction.TENANT_ACTIVATED : AuditAction.TENANT_UPDATED,
      targetType: "tenant", targetId: updated.id, metadata: { fields: Object.keys(data) },
    });
    res.json({ data: updated });
  } catch (err) {
    console.error("Update tenant error:", err);
    res.status(500).json({ error: "Failed to update tenant" });
  }
});

// ─── Create User in Tenant ───────────────────────────────────

// No password field: the invite provisions an Authentik identity and the user
// chooses their password through the emailed setup link.
const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["ADMIN", "AGENT"]).optional().default("AGENT"),
});

router.post("/tenants/:id/users", authenticate, requireSystemAdmin(), validate(createUserSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id as string } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const { email, name, role } = req.body;

    const result = await inviteUser(tenant.id, email, name, role);
    void writeAudit({
      tenantId: tenant.id, actorType: "user", actorId: (req as any).user?.userId,
      action: AuditAction.USER_CREATED, targetType: "user", targetId: result.user.id,
      metadata: { email, role },
    });
    res.status(201).json({ data: result.user, setupLink: result.setupLink });
  } catch (err) {
    console.error("Create user error:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// ─── Update User (SysAdmin: name, email, role, active) ──

const updateUserSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  role: z.enum(["ADMIN", "AGENT"]).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/tenants/:id/users/:userId", authenticate, requireSystemAdmin(), validate(updateUserSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId as string, tenantId: req.params.id as string },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { isActive, role, name, email } = req.body;
    const data: any = {};
    if (typeof isActive === "boolean") data.isActive = isActive;
    // Never alter a SYSTEM_ADMIN's role through the tenant-scoped endpoint.
    if (role && ["ADMIN", "AGENT"].includes(role) && user.role !== "SYSTEM_ADMIN") data.role = role;
    if (typeof name === "string" && name.trim()) data.name = name.trim();
    if (typeof email === "string" && email.trim()) {
      const nextEmail = email.trim();
      if (nextEmail !== user.email) {
        const clash = await prisma.user.findFirst({
          where: { tenantId: req.params.id as string, email: nextEmail, id: { not: user.id } },
          select: { id: true },
        });
        if (clash) {
          res.status(409).json({ error: "Another user in this tenant already uses this email" });
          return;
        }
        data.email = nextEmail;
      }
    }
    // Passwords are not GOTCHA's to set. A system admin who needs to restore
    // access issues a setup link via POST /agents/:id/reset-password, which
    // routes through Authentik's recovery flow.

    const updated = await prisma.user.update({
      where: { id: user.id },
      data,
      select: { id: true, email: true, name: true, role: true, isActive: true },
    });

    // Keep Authentik's display name in sync on a rename. (Email/username change
    // is intentionally NOT propagated to Authentik here - that is a
    // verification-gated identity change; see the identity operations guide.)
    if (typeof data.name === "string" && data.name !== user.name) {
      void syncIdentityNameByUser(user.id, updated.name);
    }
    // Enable/disable must be consistent across both systems (see agents.ts).
    if (typeof data.isActive === "boolean" && data.isActive !== user.isActive) {
      void syncMembershipAccess(user.id, data.isActive);
    }

    void writeAudit({
      tenantId: req.params.id as string, actorType: "user", actorId: (req as any).user?.userId,
      action: (data as any).role !== undefined ? AuditAction.ROLE_CHANGED : AuditAction.USER_UPDATED,
      targetType: "user", targetId: updated.id, metadata: { fields: Object.keys(data) },
    });
    res.json({ data: updated });
  } catch (err) {
    console.error("Update user error:", err);
    res.status(500).json({ error: "Failed to update user" });
  }
});

// ─── Delete User (SysAdmin) ──────────────────────────────────

router.delete("/tenants/:id/users/:userId", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const currentUserId = (req as any).user?.userId as string | undefined;
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId as string, tenantId: req.params.id as string },
      select: { id: true, role: true, name: true },
    });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (user.role === "SYSTEM_ADMIN") {
      res.status(400).json({ error: "Cannot delete a system admin user" });
      return;
    }
    if (currentUserId && user.id === currentUserId) {
      res.status(400).json({ error: "You cannot delete your own account" });
      return;
    }

    // User relations cascade / SetNull at the DB level (conversations →
    // assignedAgentId SetNull, departmentMember → Cascade), so a single
    // delete cleans up cleanly.
    await prisma.user.delete({ where: { id: user.id } });
    void writeAudit({
      tenantId: req.params.id as string, actorType: "user", actorId: (req as any).user?.userId,
      action: AuditAction.USER_DELETED, targetType: "user", targetId: user.id,
      metadata: { name: user.name, role: user.role },
    });
    res.json({ data: { deleted: true, userId: user.id, name: user.name } });
  } catch (err) {
    console.error("Delete user error:", err);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// ─── Bot Configuration (SysAdmin) ───────────────────────────

const botConfigSchema = z.object({
  botEnabled: z.boolean(),
  botType: z.enum(["CHATBOT_FLOW", "AUTONOMOUS_AI"]).optional(),
});

router.patch("/tenants/:id/bot-config", authenticate, requireSystemAdmin(), validate(botConfigSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { botEnabled, botType } = req.body;

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id as string } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const data: any = { botEnabled };
    if (botEnabled && botType) {
      data.botType = botType;
      if (botType === "AUTONOMOUS_AI") {
        data.firstTakeCareEnabled = true;
      } else {
        data.firstTakeCareEnabled = false;
      }
    } else if (!botEnabled) {
      // When disabling, keep botType as-is but don't clear it
    }

    const updated = await prisma.tenant.update({
      where: { id: req.params.id as string },
      data,
      select: { id: true, botEnabled: true, botType: true, firstTakeCareEnabled: true },
    });

    res.json({ data: updated });
  } catch (err) {
    console.error("Update bot config error:", err);
    res.status(500).json({ error: "Failed to update bot configuration" });
  }
});

// ─── Toggle First-Take-Care Feature ─────────────────────────

router.patch("/tenants/:id/first-take-care", authenticate, requireSystemAdmin(), async (req: Request, res: Response): Promise<void> => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id as string } });
    if (!tenant) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const updated = await prisma.tenant.update({
      where: { id: req.params.id as string },
      data: { firstTakeCareEnabled: enabled },
      select: { id: true, firstTakeCareEnabled: true },
    });

    res.json({ data: { enabled: updated.firstTakeCareEnabled } });
  } catch (err) {
    console.error("Toggle first-take-care error:", err);
    res.status(500).json({ error: "Failed to toggle First-Take-Care" });
  }
});

// ─── Seed System Admin (one-time setup) ──────────────────────

const seedSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  setupSecret: z.string().min(1),
});

router.post("/seed", validate(seedSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, name, setupSecret } = req.body;

    // JWT_SECRET is gone with the local signing key, so the setup secret must
    // now be configured explicitly rather than silently borrowing it.
    const expectedSecret = process.env.SYSTEM_ADMIN_SETUP_SECRET;
    if (!expectedSecret || setupSecret !== expectedSecret) {
      res.status(403).json({ error: "Invalid setup secret" });
      return;
    }

    // Check if any SYSTEM_ADMIN already exists
    const existingAdmin = await prisma.user.findFirst({ where: { role: "SYSTEM_ADMIN" } });
    if (existingAdmin) {
      res.status(409).json({ error: "System admin already exists" });
      return;
    }

    // Create a "system" tenant for the system admin
    let systemTenant = await prisma.tenant.findUnique({ where: { slug: "system" } });
    if (!systemTenant) {
      systemTenant = await prisma.tenant.create({
        data: { name: "System", slug: "system" },
      });
    }

    const identity = await ensureIdentity(email, name);
    const localIdentity = await prisma.identity.upsert({
      where: { authentikSubject: identity.subject },
      update: {},
      create: { authentikSubject: identity.subject, email: email.toLowerCase(), name },
    });
    const admin = await prisma.user.create({
      data: {
        tenantId: systemTenant.id,
        identityId: localIdentity.id,
        email,
        name,
        role: "SYSTEM_ADMIN",
      },
    });

    // No token is returned: GOTCHA cannot mint one. The new system admin sets
    // a password via this link and then logs in through Authentik like anyone
    // else.
    const setupLink = await createRecoveryLink(identity.pk);

    res.status(201).json({
      data: {
        user: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
        setupLink,
      },
    });
  } catch (err) {
    console.error("Seed system admin error:", err);
    res.status(500).json({ error: "Failed to seed system admin" });
  }
});

// ─── System Admin: Usage Stats (all tenants) ───────────────

router.get("/usage/stats", authenticate, requireSystemAdmin(), async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Aggregate by type across all tenants
    const byType = await prisma.usageLog.groupBy({
      by: ["type"],
      where: { createdAt: { gte: since } },
      _sum: { quantity: true, costUsd: true },
      _count: { id: true },
    });

    const stats: Record<string, { total: number; count: number; costUsd: number }> = {};
    for (const row of byType) {
      stats[row.type] = {
        total: row._sum.quantity || 0,
        count: row._count.id,
        costUsd: Number(row._sum.costUsd ?? 0),
      };
    }

    // AI-specific: feature + model breakdowns (only rows where type='ai_tokens')
    const aiWhere = { type: "ai_tokens", createdAt: { gte: since } };
    // Cached prompt tokens live on `metadata.cachedPromptTokens` (JSONB) - Prisma
    // can't aggregate them via groupBy, so we run parallel raw aggregates and
    // merge by key. Empty/missing values count as 0.
    const [byFeature, byModel, aiTotals, cachedTotalsRows, cachedByFeatureRows, cachedByModelRows] = await Promise.all([
      prisma.usageLog.groupBy({
        by: ["feature"],
        where: aiWhere,
        _sum: { promptTokens: true, completionTokens: true, quantity: true, costUsd: true },
        _count: { id: true },
        orderBy: { feature: "asc" },
      }),
      prisma.usageLog.groupBy({
        by: ["model"],
        where: aiWhere,
        _sum: { promptTokens: true, completionTokens: true, quantity: true, costUsd: true },
        _count: { id: true },
        orderBy: { model: "asc" },
      }),
      prisma.usageLog.aggregate({
        where: aiWhere,
        _sum: { promptTokens: true, completionTokens: true, quantity: true, costUsd: true },
        _count: { id: true },
      }),
      prisma.$queryRaw<Array<{ cached: bigint }>>`
        SELECT COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached
        FROM   usage_logs
        WHERE  type = 'ai_tokens' AND created_at >= ${since}
      `,
      prisma.$queryRaw<Array<{ feature: string | null; cached: bigint }>>`
        SELECT feature,
               COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached
        FROM   usage_logs
        WHERE  type = 'ai_tokens' AND created_at >= ${since}
        GROUP  BY feature
      `,
      prisma.$queryRaw<Array<{ model: string | null; cached: bigint }>>`
        SELECT model,
               COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached
        FROM   usage_logs
        WHERE  type = 'ai_tokens' AND created_at >= ${since}
        GROUP  BY model
      `,
    ]);

    const cachedTotal = Number(cachedTotalsRows[0]?.cached ?? 0);
    const cachedByFeature = new Map(
      cachedByFeatureRows.map((r) => [r.feature ?? "unknown", Number(r.cached)]),
    );
    const cachedByModel = new Map(
      cachedByModelRows.map((r) => [r.model ?? "unknown", Number(r.cached)]),
    );

    const aiTokens = {
      totalTokens: aiTotals._sum.quantity || 0,
      promptTokens: aiTotals._sum.promptTokens || 0,
      completionTokens: aiTotals._sum.completionTokens || 0,
      costUsd: Number(aiTotals._sum.costUsd ?? 0),
      calls: aiTotals._count.id || 0,
      // Cache observability - derived from OpenAI's prompt_tokens_details.cached_tokens
      // captured in trackAIUsage(). Hit % is cached / total prompt; savings is the
      // 50%-discount applied at billing time vs. uncached.
      cachedPromptTokens: cachedTotal,
      byFeature: byFeature.map((r) => ({
        feature: r.feature ?? "unknown",
        totalTokens: r._sum.quantity || 0,
        promptTokens: r._sum.promptTokens || 0,
        completionTokens: r._sum.completionTokens || 0,
        cachedPromptTokens: cachedByFeature.get(r.feature ?? "unknown") ?? 0,
        costUsd: Number(r._sum.costUsd ?? 0),
        calls: r._count.id,
      })),
      byModel: byModel.map((r) => ({
        model: r.model ?? "unknown",
        totalTokens: r._sum.quantity || 0,
        promptTokens: r._sum.promptTokens || 0,
        completionTokens: r._sum.completionTokens || 0,
        cachedPromptTokens: cachedByModel.get(r.model ?? "unknown") ?? 0,
        costUsd: Number(r._sum.costUsd ?? 0),
        calls: r._count.id,
      })),
    };

    // Total events
    const totalEvents = await prisma.usageLog.count({ where: { createdAt: { gte: since } } });

    res.json({ data: { stats, aiTokens, totalEvents, period: days } });
  } catch (err) {
    console.error("System usage stats error:", err);
    res.status(500).json({ error: "Failed to get system usage stats" });
  }
});

// ─── System Admin: Usage by Tenant ──────────────────────────

router.get("/usage/by-tenant", authenticate, requireSystemAdmin(), async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Per-tenant type totals (includes cost for ai_tokens rows)
    const byTenant = await prisma.usageLog.groupBy({
      by: ["tenantId", "type"],
      where: { createdAt: { gte: since } },
      _sum: { quantity: true, costUsd: true },
      _count: { id: true },
    });

    // Per-tenant AI feature breakdown - answers "which feature used how many
    // tokens per tenant" directly, no JSON probing needed.
    const [byTenantFeature, cachedByTenantFeatureRows] = await Promise.all([
      prisma.usageLog.groupBy({
        by: ["tenantId", "feature"],
        where: { type: "ai_tokens", createdAt: { gte: since } },
        _sum: { promptTokens: true, completionTokens: true, quantity: true, costUsd: true },
        _count: { id: true },
      }),
      // Cached tokens live on `metadata` JSONB; aggregate via raw SQL and merge
      // by (tenantId, feature) below. Missing values count as 0.
      prisma.$queryRaw<Array<{ tenant_id: string; feature: string | null; cached: bigint }>>`
        SELECT tenant_id,
               feature,
               COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached
        FROM   usage_logs
        WHERE  type = 'ai_tokens' AND created_at >= ${since}
        GROUP  BY tenant_id, feature
      `,
    ]);
    const cachedByTenantFeature = new Map(
      cachedByTenantFeatureRows.map((r) => [`${r.tenant_id}::${r.feature ?? "unknown"}`, Number(r.cached)]),
    );

    // Get tenant names
    const tenantIds = [...new Set(byTenant.map((r) => r.tenantId))];
    const tenants = await prisma.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true, slug: true },
    });
    const tenantMap = new Map(tenants.map((t) => [t.id, t]));

    // Group by tenant
    const grouped: Record<
      string,
      {
        tenant: any;
        usage: Record<string, { total: number; count: number; costUsd: number }>;
        aiByFeature: Array<{
          feature: string;
          totalTokens: number;
          promptTokens: number;
          completionTokens: number;
          cachedPromptTokens: number;
          costUsd: number;
          calls: number;
        }>;
        aiCostUsd: number;
        aiCachedPromptTokens: number;
        aiPromptTokens: number;
      }
    > = {};
    for (const row of byTenant) {
      if (!grouped[row.tenantId]) {
        grouped[row.tenantId] = {
          tenant: tenantMap.get(row.tenantId) || { id: row.tenantId, name: "Unknown", slug: "" },
          usage: {},
          aiByFeature: [],
          aiCostUsd: 0,
          aiCachedPromptTokens: 0,
          aiPromptTokens: 0,
        };
      }
      grouped[row.tenantId].usage[row.type] = {
        total: row._sum.quantity || 0,
        count: row._count.id,
        costUsd: Number(row._sum.costUsd ?? 0),
      };
    }
    for (const row of byTenantFeature) {
      if (!grouped[row.tenantId]) continue;
      const cost = Number(row._sum.costUsd ?? 0);
      const cachedForRow =
        cachedByTenantFeature.get(`${row.tenantId}::${row.feature ?? "unknown"}`) ?? 0;
      const prompt = row._sum.promptTokens || 0;
      grouped[row.tenantId].aiByFeature.push({
        feature: row.feature ?? "unknown",
        totalTokens: row._sum.quantity || 0,
        promptTokens: prompt,
        completionTokens: row._sum.completionTokens || 0,
        cachedPromptTokens: cachedForRow,
        costUsd: cost,
        calls: row._count.id,
      });
      grouped[row.tenantId].aiCostUsd += cost;
      grouped[row.tenantId].aiCachedPromptTokens += cachedForRow;
      grouped[row.tenantId].aiPromptTokens += prompt;
    }

    // Sort by total usage descending
    const data = Object.values(grouped).sort((a, b) => {
      const aTotal = Object.values(a.usage).reduce((sum, u) => sum + u.total, 0);
      const bTotal = Object.values(b.usage).reduce((sum, u) => sum + u.total, 0);
      return bTotal - aTotal;
    });

    res.json({ data });
  } catch (err) {
    console.error("System usage by tenant error:", err);
    res.status(500).json({ error: "Failed to get usage by tenant" });
  }
});

// ─── System Admin: Pricing-Model Unit Economics ────────────
//
// Powers /system/pricing. For each customer-facing AI surface (Autonomous
// Agent, Inbox Co-pilot, Call-pilot, Embedded Chat, etc) we return raw
// totals plus unit averages: $/call and $/conversation. The frontend turns
// those into a pricing calculator (markup % → suggested price per unit) and
// a trends chart.
//
// Notes:
//  - Categorisation lives in @chatcenter/shared/lib/ai-feature-categories so
//    backend SQL CASE and frontend display labels stay in sync.
//  - We split prompt vs completion cost using AI_MODEL_PRICING because input
//    and output are billed at very different rates (e.g. gpt-4o = $2.50 in /
//    $10 out per 1M). The stored UsageLog.costUsd column already reflects
//    cache discounts; we re-derive the split here without re-applying them.
//  - Per-conversation averages count distinct `metadata.conversationId` -
//    embeddings and one-shot classifications won't have one, so those
//    categories return null for that metric.

router.get("/pricing/unit-costs", authenticate, requireSystemAdmin(), async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    type CategoryAgg = {
      category: AiFeatureCategory;
      calls: bigint;
      conversations: bigint;
      prompt_tokens: bigint;
      completion_tokens: bigint;
      cached_prompt_tokens: bigint;
      total_tokens: bigint;
      cost_usd: string | number | null;
    };
    type CategoryModelAgg = {
      category: AiFeatureCategory;
      model: string | null;
      calls: bigint;
      prompt_tokens: bigint;
      completion_tokens: bigint;
      cached_prompt_tokens: bigint;
    };

    // The category CASE expression is built from the shared mapping so both
    // queries below classify identically.
    const caseSql = categorySqlCase("feature");

    const [byCategory, byCategoryModel] = await Promise.all([
      prisma.$queryRawUnsafe<CategoryAgg[]>(
        `
        SELECT
          ${caseSql} AS category,
          COUNT(*)::bigint AS calls,
          COUNT(DISTINCT metadata->>'conversationId')
            FILTER (WHERE metadata->>'conversationId' IS NOT NULL)::bigint AS conversations,
          COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
          COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached_prompt_tokens,
          COALESCE(SUM(quantity), 0)::bigint AS total_tokens,
          COALESCE(SUM(cost_usd), 0) AS cost_usd
        FROM usage_logs
        WHERE type = 'ai_tokens' AND created_at >= $1
        GROUP BY category
        `,
        since,
      ),
      prisma.$queryRawUnsafe<CategoryModelAgg[]>(
        `
        SELECT
          ${caseSql} AS category,
          model,
          COUNT(*)::bigint AS calls,
          COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
          COALESCE(SUM(COALESCE((metadata->>'cachedPromptTokens')::int, 0)), 0)::bigint AS cached_prompt_tokens
        FROM usage_logs
        WHERE type = 'ai_tokens' AND created_at >= $1
        GROUP BY category, model
        `,
        since,
      ),
    ]);

    // Re-derive input vs output cost per category from real model mix. The
    // stored cost_usd column is the blended cached/uncached total; we want
    // to separate the input-side spend from the output-side spend so the
    // pricing calculator can show two rates (in vs out per 1K).
    const modelMixByCategory = new Map<AiFeatureCategory, CategoryModelAgg[]>();
    for (const row of byCategoryModel) {
      const k = row.category;
      const arr = modelMixByCategory.get(k) ?? [];
      arr.push(row);
      modelMixByCategory.set(k, arr);
    }

    const categoryDefMap = new Map(AI_FEATURE_CATEGORIES.map((d) => [d.key, d] as const));

    const categories = byCategory.map((row) => {
      const promptTokens = Number(row.prompt_tokens);
      const completionTokens = Number(row.completion_tokens);
      const cachedPromptTokens = Number(row.cached_prompt_tokens);
      const totalTokens = Number(row.total_tokens);
      const calls = Number(row.calls);
      const conversations = Number(row.conversations);
      const costUsd = Number(row.cost_usd ?? 0);

      // Per-model split: bill uncached prompt at full rate, cached at the
      // model's cached rate, completion at full rate. Mirrors trackAIUsage()'s
      // accounting via the same shared resolver (prefix-aware, gpt-5-safe).
      let inputCostUsd = 0;
      let outputCostUsd = 0;
      const modelMix = (modelMixByCategory.get(row.category) ?? []).map((m) => {
        const pricing = resolveModelPricing(m.model);
        const mPrompt = Number(m.prompt_tokens);
        const mCompletion = Number(m.completion_tokens);
        const mCached = Math.min(Number(m.cached_prompt_tokens), mPrompt);
        const mUncached = Math.max(0, mPrompt - mCached);
        const mIn =
          (mUncached / 1_000_000) * pricing.prompt +
          (mCached / 1_000_000) * (pricing.cachedPrompt ?? pricing.prompt * 0.5);
        const mOut = (mCompletion / 1_000_000) * pricing.completion;
        inputCostUsd += mIn;
        outputCostUsd += mOut;
        return {
          model: m.model ?? "unknown",
          calls: Number(m.calls),
          promptTokens: mPrompt,
          completionTokens: mCompletion,
          cachedPromptTokens: mCached,
          inputCostUsd: mIn,
          outputCostUsd: mOut,
        };
      });

      // Blended per-1K rates over the actual model mix consumed. Null when
      // there are no tokens of that direction (e.g. embeddings have no
      // completion tokens).
      const blendedInputUsdPer1K = promptTokens > 0 ? (inputCostUsd / promptTokens) * 1000 : null;
      const blendedOutputUsdPer1K =
        completionTokens > 0 ? (outputCostUsd / completionTokens) * 1000 : null;

      const def = categoryDefMap.get(row.category);

      return {
        category: row.category,
        label: def?.label ?? categoryLabel(row.category),
        description: def?.description ?? "",
        color: def?.color ?? "slate",
        perConversation: def?.perConversation ?? false,
        calls,
        conversations,
        promptTokens,
        completionTokens,
        cachedPromptTokens,
        totalTokens,
        costUsd,
        // Re-derived split - may drift slightly from stored costUsd because
        // of rounding; surface both so the dashboard can show observed total
        // and the in/out breakdown.
        inputCostUsd,
        outputCostUsd,
        blendedInputUsdPer1K,
        blendedOutputUsdPer1K,
        avgCostPerCall: calls > 0 ? costUsd / calls : 0,
        avgCostPerConversation: conversations > 0 ? costUsd / conversations : null,
        avgTokensPerCall: calls > 0 ? totalTokens / calls : 0,
        avgTokensPerConversation: conversations > 0 ? totalTokens / conversations : null,
        cacheHitPct: promptTokens > 0 ? (cachedPromptTokens / promptTokens) * 100 : null,
        modelMix,
      };
    });

    // Stable ordering - categories without any data still appear with zeros
    // so the calculator UI can offer them as inputs even before traffic.
    const present = new Map(categories.map((c) => [c.category, c]));
    const ordered = AI_CATEGORY_ORDER.map((key) => {
      if (present.has(key)) return present.get(key)!;
      const def = categoryDefMap.get(key);
      return {
        category: key,
        label: def?.label ?? categoryLabel(key),
        description: def?.description ?? "",
        color: def?.color ?? "slate",
        perConversation: def?.perConversation ?? false,
        calls: 0,
        conversations: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
        blendedInputUsdPer1K: null as number | null,
        blendedOutputUsdPer1K: null as number | null,
        avgCostPerCall: 0,
        avgCostPerConversation: null as number | null,
        avgTokensPerCall: 0,
        avgTokensPerConversation: null as number | null,
        cacheHitPct: null as number | null,
        modelMix: [] as Array<{
          model: string;
          calls: number;
          promptTokens: number;
          completionTokens: number;
          cachedPromptTokens: number;
          inputCostUsd: number;
          outputCostUsd: number;
        }>,
      };
    });

    const totals = ordered.reduce(
      (acc, c) => {
        acc.calls += c.calls;
        acc.conversations += c.conversations;
        acc.promptTokens += c.promptTokens;
        acc.completionTokens += c.completionTokens;
        acc.cachedPromptTokens += c.cachedPromptTokens;
        acc.totalTokens += c.totalTokens;
        acc.costUsd += c.costUsd;
        acc.inputCostUsd += c.inputCostUsd;
        acc.outputCostUsd += c.outputCostUsd;
        return acc;
      },
      {
        calls: 0,
        conversations: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedPromptTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
      },
    );

    res.json({
      data: {
        period: days,
        categories: ordered,
        totals,
        // Echo pricing table so the calculator can render "what we pay per
        // 1M tokens per model" without an extra round-trip.
        pricing: AI_MODEL_PRICING,
      },
    });
  } catch (err) {
    console.error("Pricing unit-costs error:", err);
    res.status(500).json({ error: "Failed to compute pricing unit costs" });
  }
});

// ─── System Admin: Pricing-Model Cost Trends ────────────────
//
// Daily cost-per-category buckets for the period. Used by the trends chart
// on /system/pricing. Returns dense buckets (zero-filled) so the chart x-axis
// never has gaps.

router.get("/pricing/trends", authenticate, requireSystemAdmin(), async (req: Request, res: Response) => {
  try {
    const days = Math.min(parseInt(req.query.days as string) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    since.setUTCHours(0, 0, 0, 0);

    const caseSql = categorySqlCase("feature");

    type TrendRow = {
      day: Date;
      category: AiFeatureCategory;
      cost_usd: string | number | null;
      calls: bigint;
    };
    const rows = await prisma.$queryRawUnsafe<TrendRow[]>(
      `
      SELECT
        date_trunc('day', created_at)::date AS day,
        ${caseSql} AS category,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COUNT(*)::bigint AS calls
      FROM usage_logs
      WHERE type = 'ai_tokens' AND created_at >= $1
      GROUP BY day, category
      ORDER BY day
      `,
      since,
    );

    // Build the full day list (UTC) - zero-fill missing days so the chart
    // shows a continuous timeline.
    const dayList: string[] = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let d = new Date(since); d <= today; d.setUTCDate(d.getUTCDate() + 1)) {
      dayList.push(d.toISOString().slice(0, 10));
    }

    // Pre-seed zero series per category in stable order.
    const seriesMap = new Map<AiFeatureCategory, { cost: number[]; calls: number[] }>();
    for (const key of AI_CATEGORY_ORDER) {
      seriesMap.set(key, {
        cost: new Array(dayList.length).fill(0),
        calls: new Array(dayList.length).fill(0),
      });
    }
    const dayIndex = new Map(dayList.map((d, i) => [d, i] as const));

    for (const row of rows) {
      const dayStr = (row.day instanceof Date ? row.day : new Date(row.day))
        .toISOString()
        .slice(0, 10);
      const idx = dayIndex.get(dayStr);
      if (idx === undefined) continue;
      const series = seriesMap.get(row.category) ?? seriesMap.get("other")!;
      series.cost[idx] = Number(row.cost_usd ?? 0);
      series.calls[idx] = Number(row.calls);
    }

    const categoryDefMap = new Map(AI_FEATURE_CATEGORIES.map((d) => [d.key, d] as const));
    const series = AI_CATEGORY_ORDER.map((key) => {
      const def = categoryDefMap.get(key);
      const s = seriesMap.get(key)!;
      return {
        category: key,
        label: def?.label ?? categoryLabel(key),
        color: def?.color ?? "slate",
        cost: s.cost,
        calls: s.calls,
      };
    });

    res.json({
      data: {
        period: days,
        days: dayList,
        series,
      },
    });
  } catch (err) {
    console.error("Pricing trends error:", err);
    res.status(500).json({ error: "Failed to compute pricing trends" });
  }
});

export default router;
