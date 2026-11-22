/**
 * Creating an organization and its first admin.
 *
 * One function, because there is more than one door: the console's "new
 * organization" and the public sign-up both end here. Two copies of these
 * steps would drift, and the drift would be a tenant with no plan record, no
 * roles or no way for its admin to sign in.
 *
 * The order is the design. The selection is checked while there is still
 * nothing to roll back; the Authentik identity comes before the transaction
 * (a remote system cannot take part in one); the provisioning REQUEST is made
 * durable before billing is called, so a billing failure leaves something
 * repairable; and no email goes out until the plan is in place.
 *
 * The answer is the HTTP status and body the console route has always
 * returned, plus the ids of what was created for a caller that goes on to
 * write its own rows.
 */
import {
  prisma,
  ensureIdentity,
  publishEvent,
  writeAudit,
  AuditAction,
  seedTenantRbac,
  ALL_LICENSE_KEYS,
} from "@chatcenter/shared";
import { callBilling } from "../lib/billing-internal";
import { sendOnboardingEmail, sendPaidOnboardingEmail } from "./notification.service";
import { createProvisioningRequest, runProvisioning } from "./billing-provisioning.service";
import { scheduleOnboardingNudge } from "./nudge-engine.service";
import { tenantAdminEntry } from "./invitation.service";

/**
 * The license domains a POC's feature areas are chosen from.
 *
 * Derived from the permission catalog, not listed, so a domain added to the
 * product cannot go missing here - and under default-ALLOW license semantics, a
 * missing domain is a GRANTED one.
 */
export const LICENSE_DOMAINS: string[] = Array.from(
  new Set(ALL_LICENSE_KEYS.map((k) => k.split(":")[0] as string)),
).sort();

/** The commercial decision, already validated by the caller's schema. */
export interface TenantCreationBilling {
  mode: "PAID_PLAN" | "POC";
  planVersionId?: string;
  chatVolumeOptionKey?: string | null;
  voiceVolumeOptionKey?: string | null;
  billingInterval?: "MONTHLY" | "ANNUAL";
  paymentRequiredBeforeAccess?: boolean;
  commercialNote?: string;
  pocCredits?: number;
  pocExpiresAt?: string;
  pocFeatureAreas?: string[];
}

export interface TenantCreationInput {
  name: string;
  slug: string;
  adminEmail: string;
  adminName: string;
  locale: "he" | "en";
  billing: TenantCreationBilling;
  /** Who asked: the operator's user id, or a named system door with no person behind it. */
  actor: { type: "user" | "system"; id: string | null };
}

export interface TenantCreationOutcome {
  /** 201 created; 400 or 409 refused with nothing created; 502 created but the plan setup did not complete. */
  status: 201 | 400 | 409 | 502;
  body: any;
  /** Present whenever a tenant row now exists (201 and 502). */
  created?: { tenantId: string; adminUserId: string };
}

export async function createTenantWithAdmin(input: TenantCreationInput): Promise<TenantCreationOutcome> {
  const { name, slug, adminEmail, adminName, billing, locale, actor } = input;
  const paid = billing.mode === "PAID_PLAN";
  const isPoc = billing.mode === "POC";
  const actorId = actor.id ?? undefined;

  // Validate the POC selection BEFORE anything is created, for the same
  // reason the paid one is: a rejected expiry or an unknown feature area must
  // fail while there is still no tenant to roll back.
  const pocExpiresAt = isPoc ? new Date(billing.pocExpiresAt as string) : null;
  if (isPoc) {
    if (!pocExpiresAt || Number.isNaN(pocExpiresAt.getTime()) || pocExpiresAt <= new Date()) {
      return { status: 400, body: { error: "Invalid billing selection", code: "expiry_must_be_in_the_future" } };
    }
    const unknown = (billing.pocFeatureAreas as string[]).filter((f) => !LICENSE_DOMAINS.includes(f));
    if (unknown.length) {
      return { status: 400, body: { error: "Invalid billing selection", code: "unknown_feature_domain", domains: unknown } };
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
      return { status: 400, body: { error: "Invalid billing selection", code: check.body?.error } };
    }
    void writeAudit({
      tenantId: null as any, actorType: actor.type, actorId,
      action: AuditAction.PAID_TENANT_PROVISIONING_REQUESTED,
      targetType: "plan_version", targetId: billing.planVersionId,
      metadata: { slug, chatVolumeOptionKey: billing.chatVolumeOptionKey ?? null, voiceVolumeOptionKey: billing.voiceVolumeOptionKey ?? null },
    });
  }

  // Check slug uniqueness
  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) {
    return { status: 409, body: { error: "A tenant with this slug already exists" } };
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
      data: { name, slug, status: paid ? "PENDING_PAYMENT" : "PENDING_ADMIN_SETUP", defaultLocale: locale },
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
  const created = { tenantId: result.tenant.id, adminUserId: result.admin.id };

  // Seed the built-in TenantRole rows + the admin's role assignment so the
  // Users page role picker and fine-grained permissions work from day one.
  // Degrade-soft: the boot-time sweep re-covers any tenant this misses.
  await seedTenantRbac(result.tenant.id).catch((err) =>
    console.error("[system] rbac seed for new tenant failed:", err?.message),
  );

  void writeAudit({
    tenantId: result.tenant.id, actorType: actor.type, actorId,
    action: AuditAction.TENANT_CREATED, targetType: "tenant", targetId: result.tenant.id,
    metadata: { name, slug, adminEmail },
  });
  void writeAudit({
    tenantId: result.tenant.id, actorType: actor.type, actorId,
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
        tenantId: result.tenant.id, actorType: actor.type, actorId,
        action: AuditAction.PAID_TENANT_PROVISIONING_FAILED,
        targetType: "tenant", targetId: result.tenant.id,
        metadata: { mode: billing.mode, failureCode: prov.body?.error ?? "unknown" },
      });
      return {
        status: 502,
        created,
        body: {
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
        },
      };
    }

    if (isPoc) {
      pocProvisioning = prov.body;
      void writeAudit({
        tenantId: result.tenant.id, actorType: actor.type, actorId,
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
      tenantId: result.tenant.id, actorType: actor.type, actorId,
      action: AuditAction.PAID_TENANT_CREATED,
      targetType: "tenant", targetId: result.tenant.id,
      metadata: { planKey: paidProvisioning.summary?.planKey, planVersion: paidProvisioning.summary?.planVersion },
    });
    void writeAudit({
      tenantId: result.tenant.id, actorType: actor.type, actorId,
      action: AuditAction.PENDING_CHECKOUT_CREATED,
      targetType: "checkout", targetId: paidProvisioning.checkoutReference,
      metadata: { amount: paidProvisioning.summary?.amount, currency: paidProvisioning.summary?.currency },
    });
    // The link id is audited; the raw token never is.
    void writeAudit({
      tenantId: result.tenant.id, actorType: actor.type, actorId,
      action: AuditAction.PAYMENT_CONTINUATION_LINK_CREATED,
      targetType: "continuation_link", targetId: paidProvisioning.link?.id,
      metadata: { expiresAt: paidProvisioning.link?.expiresAt },
    });
  }

  // Send onboarding email with magic link (non-blocking).
  if (paid && paidProvisioning) {
    // Password FIRST, payment second. Without this the email carried only a
    // checkout link, which authorizes a checkout and not a person - so the
    // customer bought the product without ever authenticating and then hit a
    // sign-in wall for a password nobody had set, with the repair route
    // gated behind permissions they could not yet hold.
    const entry = await tenantAdminEntry(result.tenant.id).catch(() => null);
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
      setupUrl: entry?.needsPassword ? entry.actionUrl : null,
      locale,
    }).catch((err) => {
      // Delivery failure must not activate anything. Resend is the repair.
      console.error("Failed to send paid onboarding email:", err?.message ?? err);
    });
  } else {
    sendOnboardingEmail(result.tenant.id, adminEmail, adminName, name, slug, result.admin.id, locale).catch((err) => {
      console.error("Failed to send onboarding email:", err);
    });
  }

  // Arm the onboarding nudge so a tenant that never starts gets a follow-up.
  scheduleOnboardingNudge(result.tenant.id, "1d").catch(() => {});

  return {
    status: 201,
    created,
    body: {
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
  },
  };
}
