/**
 * Who does not have to pay Shopify, and why.
 *
 * Grandfathering is the one decision in this system that hands somebody ongoing
 * paid access on the strength of claims about the past. It is therefore the one
 * most worth getting wrong-proof rather than merely correct today.
 *
 * THE RULE
 * --------
 * A workspace is automatically eligible when its GOTCHA subscription STARTED
 * BEING PAID before the App Store listing was published. Both halves matter and
 * both have been got wrong before:
 *
 *   • "started being paid", not "was created". An account that signed up in
 *     January and first paid in November is a NEW customer commercially, and
 *     the November payment is after publication. Reading `tenant.createdAt`
 *     here - the obvious shortcut, since it is one join closer - would grandfather
 *     them, which is the exact case the confirmed billing model calls out.
 *
 *   • "before publication", against a CONFIGURED cutoff. The publication date
 *     is not known while this is being written. An unset cutoff means nobody is
 *     eligible, never everybody.
 *
 * EVIDENCE, IN DESCENDING STRENGTH
 * --------------------------------
 *   1. `Invoice.paidAt`  - money actually arrived. Unambiguous.
 *   2. `SubscriptionEvent` -> ACTIVE/TRIALING - the subscription went live.
 *   3. `Subscription.createdAt` while currently paying - weakest, and marked
 *      INFERRED so a reviewer can see the decision rested on it.
 *
 * `tenant.createdAt` appears in the evidence blob as CONTEXT and is never
 * compared against the cutoff. It is recorded precisely so that a later reader
 * can confirm it was not what decided the outcome.
 *
 * IDEMPOTENCE
 * -----------
 * `ShopifyGrandfatherGrant.tenantId` is unique. A merchant may install,
 * uninstall and reinstall any number of times; eligibility is a fact about
 * history and must not be re-litigated on each pass, least of all against
 * whatever flags happen to be set that day. `ensureGrandfatherGrant` returns
 * the standing grant if there is one and only decides when there is not.
 *
 * WHAT THIS MODULE REFUSES TO READ
 * --------------------------------
 * Anything the browser sent. There is no `grandfathered` query parameter, no
 * request body field, and no header consulted anywhere in this file. The only
 * inputs are a tenant id resolved from a validated session and rows in our own
 * database.
 */

import { prisma } from "@chatcenter/shared";
import type { PolicyEvidenceQuality, Prisma } from "@prisma/client";
import {
  shopifyAllowGrandfathered,
  shopifyGrandfatherDevStores,
  shopifyPublicationCutoff,
} from "../billing-sources/shopify/config";

/** Subscription states that mean the workspace is genuinely paying us. */
const PAYING_STATUSES = ["ACTIVE", "TRIALING", "PAST_DUE", "GRANDFATHERED"] as const;

/** Which row produced `paidSince`. Ordered strongest first. */
export type PaidSinceEvidence =
  | "invoice_paid_at"
  | "subscription_activated_event"
  | "subscription_created_at";

export interface GrandfatherEligibility {
  eligible: boolean;
  /** Machine-readable and stable enough to assert on in tests. */
  reason: string;
  paidSince: Date | null;
  paidSinceEvidence: PaidSinceEvidence | null;
  cutoffAt: Date | null;
  evidenceQuality: PolicyEvidenceQuality;
  evidence: Record<string, unknown>;
}

export interface EligibilityInput {
  tenantId: string;
  /**
   * Whether Shopify told us this is a development/partner store.
   *
   * Supplied by the caller from VERIFIED shop data, never guessed from the
   * domain - `*.myshopify.com` looks identical for both. Undefined means
   * "not known", which is treated as "not a dev store": refusing every
   * unknown would block real merchants whenever the shop read failed.
   */
  isDevelopmentStore?: boolean;
  now?: Date;
}

/**
 * The earliest moment this payer demonstrably started paying.
 *
 * Returns null when there is no evidence of payment at all, which is the
 * correct answer for a workspace that has never paid - distinct from an error,
 * and distinct from "paid a long time ago".
 */
async function findPaidSince(
  billableEntityId: string,
): Promise<{ at: Date; evidence: PaidSinceEvidence } | null> {
  // 1. A paid invoice. Money moved, and the date it moved is not a matter of
  //    interpretation.
  const invoice = await prisma.invoice.findFirst({
    where: { billableEntityId, paidAt: { not: null } },
    orderBy: { paidAt: "asc" },
    select: { paidAt: true },
  });
  if (invoice?.paidAt) return { at: invoice.paidAt, evidence: "invoice_paid_at" };

  // 2. The subscription going live. Weaker than a payment but still an event
  //    recorded at the time it happened rather than reconstructed afterwards.
  const subscription = await prisma.subscription.findUnique({
    where: { billableEntityId },
    select: { id: true, createdAt: true, status: true },
  });
  if (!subscription) return null;

  const activation = await prisma.subscriptionEvent.findFirst({
    where: {
      subscriptionId: subscription.id,
      toStatus: { in: ["ACTIVE", "TRIALING"] },
    },
    orderBy: { at: "asc" },
    select: { at: true },
  });
  if (activation?.at) {
    return { at: activation.at, evidence: "subscription_activated_event" };
  }

  // 3. Last resort. Only meaningful if they are paying NOW - a PENDING
  //    subscription created long ago is not evidence of having paid then.
  if ((PAYING_STATUSES as readonly string[]).includes(subscription.status)) {
    return { at: subscription.createdAt, evidence: "subscription_created_at" };
  }

  return null;
}

/**
 * Decide eligibility without writing anything.
 *
 * Separated from the grant so an operator, a test, or an admin screen can ask
 * "would this qualify?" without leaving a row claiming a decision was taken.
 */
export async function assessGrandfatherEligibility(
  input: EligibilityInput,
): Promise<GrandfatherEligibility> {
  const now = input.now ?? new Date();
  const cutoffAt = shopifyPublicationCutoff();

  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, createdAt: true },
  });

  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId: input.tenantId },
    select: { billableEntityId: true },
  });

  const subscription = link
    ? await prisma.subscription.findUnique({
        where: { billableEntityId: link.billableEntityId },
        select: { status: true, planKey: true, billingSource: true, createdAt: true },
      })
    : null;

  const paid = link ? await findPaidSince(link.billableEntityId) : null;

  const evidence: Record<string, unknown> = {
    // Present as CONTEXT. Deliberately never compared against the cutoff - see
    // the module header. A reviewer can confirm from this blob that the
    // decision did not rest on it.
    accountCreatedAt: tenant?.createdAt?.toISOString() ?? null,
    billableEntityId: link?.billableEntityId ?? null,
    subscriptionStatus: subscription?.status ?? null,
    subscriptionPlanKey: subscription?.planKey ?? null,
    subscriptionBillingSource: subscription?.billingSource ?? null,
    paidSince: paid?.at.toISOString() ?? null,
    paidSinceEvidence: paid?.evidence ?? null,
    cutoffAt: cutoffAt?.toISOString() ?? null,
    isDevelopmentStore: input.isDevelopmentStore ?? null,
    evaluatedAt: now.toISOString(),
  };

  const no = (reason: string, quality: PolicyEvidenceQuality = "CONFIRMED"): GrandfatherEligibility => ({
    eligible: false,
    reason,
    paidSince: paid?.at ?? null,
    paidSinceEvidence: paid?.evidence ?? null,
    cutoffAt,
    evidenceQuality: quality,
    evidence,
  });

  // ── Switch ──
  // The flag is checked first so that a deployment with grandfathering off
  // produces one uniform reason, rather than a per-tenant answer that would
  // change the moment somebody flipped it.
  if (!shopifyAllowGrandfathered()) return no("grandfathering_not_permitted", "UNKNOWN");

  // ── Cutoff ──
  // Unset means undecided, not "everyone qualifies".
  if (!cutoffAt) return no("publication_cutoff_not_configured", "REVIEW_REQUIRED");

  if (!tenant) return no("tenant_not_found", "REVIEW_REQUIRED");

  // ── Development stores ──
  // A dev store has no commercial history, so an automatic grant on one is an
  // artefact of testing. Refused unless a deployment opts in.
  if (input.isDevelopmentStore === true && !shopifyGrandfatherDevStores()) {
    return no("development_store_not_auto_grandfathered");
  }

  // ── Evidence ──
  if (!link || !subscription) return no("no_gotcha_subscription");
  if (subscription.billingSource !== "GOTCHA_EXTERNAL") {
    // Already billed by somebody else. Grandfathering is about being kept on
    // GOTCHA's own billing, so there is nothing to keep them on.
    return no("subscription_not_externally_billed");
  }
  if (!paid) return no("no_evidence_of_payment");

  if (paid.at.getTime() >= cutoffAt.getTime()) {
    // The case the model calls out by name: the account may be old, but the
    // money is new, and the money is what counts.
    return no("first_paid_after_publication_cutoff");
  }

  return {
    eligible: true,
    reason: "paid_before_publication_cutoff",
    paidSince: paid.at,
    paidSinceEvidence: paid.evidence,
    cutoffAt,
    // The weakest evidence produces a weaker claim, and says so.
    evidenceQuality: paid.evidence === "subscription_created_at" ? "INFERRED" : "CONFIRMED",
    evidence,
  };
}

/** The standing grant for a workspace, or null. Only ACTIVE grants count. */
export async function getActiveGrandfatherGrant(tenantId: string) {
  const grant = await prisma.shopifyGrandfatherGrant.findUnique({ where: { tenantId } });
  return grant && grant.status === "ACTIVE" ? grant : null;
}

/**
 * Grant if eligible, and do nothing if a grant already stands.
 *
 * Idempotent by construction rather than by convention: the unique constraint
 * on `tenantId` means two concurrent installs cannot produce two grants, and
 * the create is guarded so the loser of that race reads the winner's row
 * instead of failing the install.
 */
export async function ensureGrandfatherGrant(input: EligibilityInput) {
  const existing = await prisma.shopifyGrandfatherGrant.findUnique({
    where: { tenantId: input.tenantId },
  });

  // A REVOKED grant is left alone. Revocation is a deliberate act by a human,
  // and silently re-granting on the next reinstall would undo it invisibly.
  if (existing) {
    return {
      grant: existing.status === "ACTIVE" ? existing : null,
      created: false,
      assessment: null as GrandfatherEligibility | null,
      reason: existing.status === "ACTIVE" ? "existing_grant" : "grant_revoked",
    };
  }

  const assessment = await assessGrandfatherEligibility(input);
  if (!assessment.eligible) {
    return { grant: null, created: false, assessment, reason: assessment.reason };
  }

  try {
    const grant = await prisma.shopifyGrandfatherGrant.create({
      data: {
        tenantId: input.tenantId,
        status: "ACTIVE",
        source: "AUTOMATIC",
        reason: assessment.reason,
        paidSince: assessment.paidSince,
        paidSinceEvidence: assessment.paidSinceEvidence,
        cutoffAt: assessment.cutoffAt,
        evidence: assessment.evidence as Prisma.InputJsonValue,
        evidenceQuality: assessment.evidenceQuality,
      },
    });
    console.log(
      `[billing][grandfather] granted tenant=${input.tenantId} grant=${grant.id} ` +
        `source=AUTOMATIC evidence=${assessment.paidSinceEvidence} quality=${assessment.evidenceQuality}`,
    );
    return { grant, created: true, assessment, reason: assessment.reason };
  } catch (err: any) {
    // P2002 = the unique constraint fired, i.e. a concurrent install won.
    // Reading its row is the correct outcome; the merchant is grandfathered
    // either way and there must still be exactly one grant.
    if (err?.code === "P2002") {
      const winner = await prisma.shopifyGrandfatherGrant.findUnique({
        where: { tenantId: input.tenantId },
      });
      return {
        grant: winner && winner.status === "ACTIVE" ? winner : null,
        created: false,
        assessment,
        reason: "concurrent_grant",
      };
    }
    throw err;
  }
}

export interface OverrideInput {
  tenantId: string;
  /**
   * The internal admin taking responsibility. REQUIRED, and never a tenant
   * user: the route that reaches this enforces SYSTEM_ADMIN, and an override
   * with no name attached is not auditable, which defeats the point.
   */
  approvedBy: string;
  /** Free text from the admin. Stored verbatim for the audit trail. */
  note?: string;
}

/**
 * Grandfather a workspace on an admin's authority rather than on evidence.
 *
 * This exists because the evidence ladder cannot see everything - a migrated
 * contract, an invoice raised outside the system, a commercial promise made
 * before any of this was built. It is deliberately a SEPARATE function from the
 * automatic path, stamped `ADMIN_OVERRIDE`, so that "who was grandfathered by
 * rule" and "who was grandfathered by decision" are answerable with a WHERE
 * clause rather than by reading a JSON blob.
 *
 * The assessment is still run and still stored, even though it is not obeyed.
 * An override that contradicts the evidence is exactly the row somebody will
 * ask about later, and the answer should include what the system thought at
 * the time.
 */
export async function overrideGrandfatherGrant(input: OverrideInput) {
  if (!input.approvedBy?.trim()) {
    throw new Error("overrideGrandfatherGrant requires approvedBy - an override must be attributable.");
  }

  const assessment = await assessGrandfatherEligibility({ tenantId: input.tenantId });
  const evidence = {
    ...assessment.evidence,
    overrideNote: input.note ?? null,
    automaticAssessment: {
      eligible: assessment.eligible,
      reason: assessment.reason,
      evidenceQuality: assessment.evidenceQuality,
    },
  };

  const grant = await prisma.shopifyGrandfatherGrant.upsert({
    where: { tenantId: input.tenantId },
    create: {
      tenantId: input.tenantId,
      status: "ACTIVE",
      source: "ADMIN_OVERRIDE",
      reason: "admin_override",
      paidSince: assessment.paidSince,
      paidSinceEvidence: assessment.paidSinceEvidence,
      cutoffAt: assessment.cutoffAt,
      evidence: evidence as Prisma.InputJsonValue,
      // A human decision is not evidence about the past, and calling it
      // CONFIRMED would let it hide among the rows that are.
      evidenceQuality: "REVIEW_REQUIRED",
      approvedBy: input.approvedBy,
    },
    update: {
      status: "ACTIVE",
      source: "ADMIN_OVERRIDE",
      reason: "admin_override",
      evidence: evidence as Prisma.InputJsonValue,
      evidenceQuality: "REVIEW_REQUIRED",
      approvedBy: input.approvedBy,
      // Re-granting clears a prior revocation, and the audit columns are
      // cleared with it so a live grant never carries a stale revocation.
      revokedAt: null,
      revokedBy: null,
      revokedReason: null,
    },
  });

  console.log(
    `[billing][grandfather] OVERRIDE tenant=${input.tenantId} grant=${grant.id} by=${input.approvedBy} ` +
      `automaticAssessment=${assessment.eligible ? "eligible" : assessment.reason}`,
  );
  return grant;
}

/** Withdraw a grant. Keeps the row so the history survives. */
export async function revokeGrandfatherGrant(input: {
  tenantId: string;
  revokedBy: string;
  reason: string;
}) {
  if (!input.revokedBy?.trim()) {
    throw new Error("revokeGrandfatherGrant requires revokedBy - a revocation must be attributable.");
  }
  const existing = await prisma.shopifyGrandfatherGrant.findUnique({
    where: { tenantId: input.tenantId },
  });
  if (!existing) return null;

  const grant = await prisma.shopifyGrandfatherGrant.update({
    where: { tenantId: input.tenantId },
    data: {
      status: "REVOKED",
      revokedAt: new Date(),
      revokedBy: input.revokedBy,
      revokedReason: input.reason,
    },
  });
  console.log(
    `[billing][grandfather] REVOKED tenant=${input.tenantId} grant=${grant.id} by=${input.revokedBy}`,
  );
  return grant;
}
