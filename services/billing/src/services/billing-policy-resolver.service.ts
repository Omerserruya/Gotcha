/**
 * Which commercial arrangement applies once Shopify is in the picture.
 *
 * This runs SERVER-SIDE after a verified Shopify install, and its answer
 * decides whether the merchant is sent to Shopify's plan-selection page, kept
 * on GOTCHA's own billing, or shown a billing-pending screen.
 *
 * Three rules shape the whole file.
 *
 * 1. UNRESOLVED IS A REAL ANSWER, AND IT IS THE DEFAULT.
 *    Shopify has not told us whether split billing is permitted for GOTCHA.
 *    Until they do, and until an operator explicitly configures a policy mode,
 *    the honest answer is "we do not know", which lands the merchant on a
 *    non-charging BILLING_PENDING screen. That is a mildly annoying outcome.
 *    Guessing produces either an App Store rejection or a merchant billed
 *    twice for one capability, which are not mildly annoying.
 *
 * 2. NOBODY IS GRANDFATHERED BECAUSE THEY SAY SO.
 *    Grandfathering hands somebody ongoing paid access on the strength of
 *    claims about the past. It therefore requires BOTH an explicit
 *    configuration switch AND evidence this system actually holds - an active
 *    external subscription that predates the install. A customer's assertion,
 *    an email address that looks familiar, or a shop name that matches a
 *    workspace name are not evidence, and none of them are consulted here.
 *
 * 3. EVERY DECISION IS WRITTEN DOWN, WITH WHAT IT RESTED ON.
 *    A policy is a function of code AND configuration, and both change. An
 *    answer stored without its evidence and its versions cannot be audited
 *    later, and grandfathering is exactly the decision somebody will ask about
 *    a year from now.
 */
import { prisma } from "@chatcenter/shared";
import type { BillingPolicy, PolicyEvidenceQuality, Prisma } from "@prisma/client";
import {
  shopifyAllowGrandfathered,
  shopifyAllowSplitBilling,
  shopifyBillingEnabled,
  shopifyBillingMode,
  shopifyPolicyMode,
} from "../billing-sources/shopify/config";

export interface ResolvePolicyInput {
  tenantId: string;
  /** The verified connection this decision is about. */
  commerceConnectionId?: string | null;
  /** "app_store" | "in_app_connect" | "admin". Recorded, never inferred. */
  acquisitionSource?: string | null;
  decidedBy?: string | null;
  now?: Date;
}

export interface PolicyDecision {
  policy: BillingPolicy;
  /** Machine-readable. Stable enough to alert on and to test against. */
  reason: string;
  grandfathered: boolean;
  evidenceQuality: PolicyEvidenceQuality;
  evidence: Record<string, unknown>;
  /**
   * True when the merchant must be sent to Shopify to choose a plan. Never
   * true for a decision that has not resolved.
   */
  requiresShopifyPlanSelection: boolean;
  /**
   * True when an external subscription and a Shopify one would both be live
   * and somebody has to reconcile them. Recorded rather than acted on: this
   * code never cancels an external subscription.
   */
  requiresMigrationReview: boolean;
}

/**
 * Identifies the code and configuration that produced a decision.
 *
 * Not a version number anyone maintains by hand - that would go stale on the
 * first change nobody remembered to bump. `configVersion` is the set of
 * switches that actually alter the outcome, so two decisions that differ can
 * be told apart by reading them.
 */
function codeVersion(): string {
  // Reuses the release identifiers the stack already carries rather than
  // inventing a third one. Sentry resolves a build the same way
  // (SENTRY_RELEASE, then BUILD_SHA), so a policy decision and the error report
  // from the same deploy name the same build.
  return (process.env.SENTRY_RELEASE || process.env.BUILD_SHA || "unknown").slice(0, 32);
}

function configVersion(): string {
  return [
    `enabled=${shopifyBillingEnabled()}`,
    `mode=${shopifyBillingMode()}`,
    `policy=${shopifyPolicyMode() ?? "unset"}`,
    `split=${shopifyAllowSplitBilling()}`,
    `grandfathered=${shopifyAllowGrandfathered()}`,
  ].join(" ");
}

/** Statuses that mean the workspace is genuinely paying us today. */
const PAYING_STATUSES = ["ACTIVE", "TRIALING", "PAST_DUE", "GRANDFATHERED"] as const;

/**
 * Decide, without writing anything.
 *
 * Kept separate from `resolveAndRecordBillingPolicy` so the decision can be
 * previewed - by a test, by an admin screen, by an operator asking "what would
 * happen if I turned this on" - without leaving an audit row that says a
 * decision was taken when none was.
 */
export async function decideBillingPolicy(input: ResolvePolicyInput): Promise<PolicyDecision> {
  const now = input.now ?? new Date();

  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, createdAt: true },
  });

  const link = await prisma.billableEntityTenant.findUnique({
    where: { tenantId: input.tenantId },
    select: { billableEntityId: true },
  });

  const existing = link
    ? await prisma.subscription.findUnique({
        where: { billableEntityId: link.billableEntityId },
        select: {
          id: true, status: true, planKey: true, billingSource: true,
          createdAt: true, currentPeriodEnd: true,
        },
      })
    : null;

  const hasPayingExternal =
    !!existing &&
    existing.billingSource === "GOTCHA_EXTERNAL" &&
    (PAYING_STATUSES as readonly string[]).includes(existing.status);

  const evidence: Record<string, unknown> = {
    accountCreatedAt: tenant?.createdAt?.toISOString() ?? null,
    acquisitionSource: input.acquisitionSource ?? null,
    externalSubscriptionStatus: existing?.status ?? null,
    externalSubscriptionSince: existing?.createdAt?.toISOString() ?? null,
    externalBillingSource: existing?.billingSource ?? null,
    hasPayingExternalSubscription: hasPayingExternal,
    evaluatedAt: now.toISOString(),
  };

  const unresolved = (reason: string): PolicyDecision => ({
    policy: "UNRESOLVED",
    reason,
    grandfathered: false,
    // The evidence may be perfectly good; what is missing is a POLICY. Saying
    // UNKNOWN here would mislead whoever reviews these rows later.
    evidenceQuality: tenant ? "INFERRED" : "UNKNOWN",
    evidence,
    requiresShopifyPlanSelection: false,
    requiresMigrationReview: false,
  });

  // ── Gate 1: is the integration switched on at all? ──
  // A disabled flag must land in a non-charging pending state, never in
  // accidental paid access and never in a real charge.
  if (!shopifyBillingEnabled()) return unresolved("shopify_billing_disabled");
  if (shopifyBillingMode() === "disabled") return unresolved("shopify_billing_mode_unset");

  const mode = shopifyPolicyMode();
  if (!mode) return unresolved("policy_mode_unset");

  if (!tenant) {
    // No workspace to decide about. Distinct from "we have no policy": this is
    // a data problem and should be visible as one.
    return {
      ...unresolved("tenant_not_found"),
      evidenceQuality: "REVIEW_REQUIRED",
    };
  }

  // ── Gate 2: grandfathering, which needs a switch AND evidence ──
  if (mode === "grandfathered_only" || (hasPayingExternal && shopifyAllowGrandfathered())) {
    if (!shopifyAllowGrandfathered()) {
      // The mode asks for it and the switch forbids it. Refusing to guess
      // which of the two an operator meant.
      return unresolved("grandfathering_not_permitted");
    }
    if (!hasPayingExternal) {
      // The one case that must never become a silent yes. There is no
      // qualifying subscription, so there is nothing to grandfather, and the
      // absence of evidence is recorded as REVIEW_REQUIRED rather than as a
      // decision that the customer does not qualify.
      return {
        policy: "UNRESOLVED",
        reason: "grandfathering_requested_without_evidence",
        grandfathered: false,
        evidenceQuality: "REVIEW_REQUIRED",
        evidence,
        requiresShopifyPlanSelection: false,
        requiresMigrationReview: false,
      };
    }
    return {
      policy: "GRANDFATHERED_EXTERNAL",
      reason: "active_external_subscription_predates_install",
      grandfathered: true,
      // CONFIRMED: this rests on a subscription row in our own database, not
      // on anything anybody told us.
      evidenceQuality: "CONFIRMED",
      evidence,
      requiresShopifyPlanSelection: false,
      requiresMigrationReview: false,
    };
  }

  // ── Gate 3: connector add-on, which is split billing by definition ──
  if (mode === "connector_addon") {
    if (!shopifyAllowSplitBilling()) {
      // The mode IS split billing. Running it with split billing forbidden
      // would bill the connector through Shopify while GOTCHA Core keeps
      // charging - the exact double-charge this refuses to risk.
      return unresolved("split_billing_not_permitted");
    }
    return {
      policy: "SHOPIFY_CONNECTOR_ADDON",
      reason: hasPayingExternal
        ? "external_core_retained_shopify_bills_connector"
        : "no_external_subscription_shopify_bills_connector",
      grandfathered: false,
      evidenceQuality: "CONFIRMED",
      evidence,
      requiresShopifyPlanSelection: true,
      requiresMigrationReview: false,
    };
  }

  // ── Gate 4: full Shopify ──
  return {
    policy: "FULL_SHOPIFY",
    reason: hasPayingExternal
      ? "shopify_billing_with_external_subscription_to_reconcile"
      : "shopify_bills_everything",
    grandfathered: false,
    evidenceQuality: "CONFIRMED",
    evidence,
    requiresShopifyPlanSelection: true,
    // Deliberately NOT a cancellation. An external subscription is still live
    // and somebody has to decide what happens to it; this code records that a
    // human decision is owed and does nothing irreversible on its own.
    requiresMigrationReview: hasPayingExternal,
  };
}

/**
 * Decide and persist, returning the decision.
 *
 * The audit row is append-only: a workspace accumulates a history of decisions
 * rather than one mutable answer, so a policy that changed because a flag
 * changed is visible as two rows instead of as a value nobody can explain.
 */
export async function resolveAndRecordBillingPolicy(
  input: ResolvePolicyInput,
): Promise<PolicyDecision & { decisionId: string }> {
  const decision = await decideBillingPolicy(input);
  const tenant = await prisma.tenant.findUnique({
    where: { id: input.tenantId },
    select: { createdAt: true },
  });

  const row = await prisma.billingPolicyDecision.create({
    data: {
      tenantId: input.tenantId,
      policy: decision.policy,
      reason: decision.reason,
      acquisitionSource: input.acquisitionSource ?? null,
      accountCreatedAt: tenant?.createdAt ?? null,
      grandfathered: decision.grandfathered,
      evidence: {
        ...decision.evidence,
        requiresMigrationReview: decision.requiresMigrationReview,
      } as Prisma.InputJsonValue,
      evidenceQuality: decision.evidenceQuality,
      commerceConnectionId: input.commerceConnectionId ?? null,
      codeVersion: codeVersion(),
      configVersion: configVersion(),
      decidedAt: input.now ?? new Date(),
      decidedBy: input.decidedBy ?? "system",
    },
    select: { id: true },
  });

  // Structured, non-sensitive, correlatable. No shop domain, no email, no
  // token - a policy decision is interesting in aggregate and the identifiers
  // are enough to find the row.
  console.log(
    `[billing][policy] tenant=${input.tenantId} decision=${row.id} policy=${decision.policy} ` +
      `reason=${decision.reason} evidence=${decision.evidenceQuality} ` +
      `grandfathered=${decision.grandfathered} migrationReview=${decision.requiresMigrationReview}`,
  );

  return { ...decision, decisionId: row.id };
}

/** The most recent decision for a workspace, or null if none was ever taken. */
export async function latestBillingPolicyDecision(tenantId: string) {
  return prisma.billingPolicyDecision.findFirst({
    where: { tenantId },
    orderBy: { decidedAt: "desc" },
  });
}
