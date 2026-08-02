/**
 * Sysadmin pricing administration. Platform tier only - never tenant ADMIN.
 *
 * The safety model, in order of importance:
 *
 *   1. An ACTIVE plan version is IMMUTABLE. Editing a live price would rewrite
 *      what every existing customer is on. To change anything commercial you
 *      create a new DRAFT version and publish it; existing subscriptions stay on
 *      their own version until explicitly migrated.
 *   2. Publishing shows its blast radius first (`/preview`): what changed, how
 *      many organizations are on the previous version, and what happens to them.
 *   3. Changing a public estimation ratio creates a new PublicEstimationConfig
 *      version. It never writes to the ledger, an invoice, or an existing
 *      subscription's snapshot - and the actual-usage comparison can only WARN.
 *   4. Every mutation writes an audit row naming the platform capability used.
 */
import { Router } from "express";
import {
  authenticate,
  requirePlatformPermission,
  PLATFORM_PERMISSIONS,
  PLATFORM_PERMISSION_CATALOG,
  prisma,
  writeAudit,
  FEATURE_CATALOG,
  isUnsellable,
  invalidateEstimationCache,
  invalidateCurrencyCache,
  getCurrencyConfig,
  refreshUsdIlsRate,
  resolveEstimation,
  estimatePlanCapacity,
  money,
  materializeEntitlements,
} from "@chatcenter/shared";
import { listCatalogPlans, quote, declaredVolumeOf } from "../services/pricing.service";
import { resolveAndValidatePlan } from "../services/paid-provisioning.service";
import { quote as quotePricing } from "../services/pricing.service";
import { ICOUNT_CAPABILITIES } from "../providers/capabilities";
import { toDecimalString } from "@chatcenter/shared";

const CHARGEABLE_CURRENCIES = ICOUNT_CAPABILITIES.chargeCurrencies;


const router = Router();
const P = PLATFORM_PERMISSIONS;

/**
 * Audit every platform mutation, tagged with the capability the route declared.
 * `tenantId` is the affected organization for a custom plan / POC, and the
 * literal "platform" for global catalog changes.
 */
async function audit(req: any, action: string, targetType: string, targetId: string | null, metadata: Record<string, unknown> = {}) {
  await writeAudit({
    tenantId: metadata.tenantId ? String(metadata.tenantId) : "platform",
    actorType: "user",
    actorId: req.user?.userId ?? null,
    action,
    targetType,
    targetId,
    metadata: { ...metadata, platformPermission: req.platformPermission },
  }).catch((err: any) => console.error("[admin-pricing] audit failed:", err?.message ?? err));
}

/**
 * Keep every copy of a plan's credit allowance in agreement.
 *
 * `plans.included_ai_units` is the total, and the only number this console asks
 * anyone for. Two rows repeat it: `config:credit_split`, which says how the
 * total is presented per channel, and `limit:included_ai_units`, which the
 * entitlement resolver reads. Both were written once at seed time and never
 * again - so an edited plan kept selling and GRANTING the seeded 2,000 credits
 * no matter what was typed here, because `quoteFor()` totals the split.
 *
 * Called at every site that writes an allowance. `voice` is the voice share of
 * the total; the rest is chat.
 */
async function syncCreditRows(planId: string, total: number, voice?: number | null) {
  const existing = await prisma.planEntitlement.findUnique({
    where: { planId_entitlementKey: { planId, entitlementKey: "config:credit_split" } },
  });
  const previousVoice = Number((existing?.value as any)?.voice ?? 0) || 0;
  const safeTotal = Math.max(0, Math.round(Number(total) || 0));
  // An unspecified voice share keeps whatever the plan had, as far as the new
  // total allows. Shrinking the allowance below the old voice share must not
  // leave a negative chat allowance.
  const safeVoice = Math.min(safeTotal, Math.max(0, Math.round(Number(voice ?? previousVoice) || 0)));

  for (const row of [
    { key: "config:credit_split", valueType: "CONFIG", value: { chat: safeTotal - safeVoice, voice: safeVoice } },
    { key: "limit:included_ai_units", valueType: "COUNTER", value: { count: safeTotal } },
  ]) {
    await prisma.planEntitlement.upsert({
      where: { planId_entitlementKey: { planId, entitlementKey: row.key } },
      create: { planId, entitlementKey: row.key, valueType: row.valueType as any, value: row.value as any },
      update: { valueType: row.valueType as any, value: row.value as any },
    });
  }
  return { chat: safeTotal - safeVoice, voice: safeVoice };
}

/** The voice share of a loaded plan's allowance, for read responses. */
function voiceShareOf(plan: { includedAiUnits: number; entitlements: Array<{ entitlementKey: string; value: any }> }) {
  const raw = plan.entitlements.find((e) => e.entitlementKey === "config:credit_split")?.value as any;
  const voice = Math.max(0, Number(raw?.voice ?? 0) || 0);
  return Math.min(plan.includedAiUnits, voice);
}

// ── Catalog: read ───────────────────────────────────────────────────────────

router.get("/admin/pricing/plans", authenticate, requirePlatformPermission(P.PRICING_READ), async (_req, res) => {
  const plans = await prisma.plan.findMany({
    include: {
      entitlements: true,
      volumeOptions: { orderBy: [{ channel: "asc" }, { sortOrder: "asc" }] },
      estimations: { where: { active: true }, orderBy: { effectiveFrom: "desc" }, take: 1 },
    },
    orderBy: [{ sortOrder: "asc" }, { key: "asc" }, { version: "desc" }],
  });

  // How many organizations sit on each version - the number that makes a
  // publish decision safe or reckless.
  const counts = await prisma.subscription.groupBy({
    by: ["planKey", "planVersion"],
    _count: { _all: true },
  });
  const countFor = (key: string, version: number) =>
    counts.find((c) => c.planKey === key && c.planVersion === version)?._count._all ?? 0;

  res.json({
    plans: plans.map((p) => ({
      id: p.id,
      key: p.key,
      version: p.version,
      name: p.name,
      nameHe: p.nameHe,
      descriptionEn: p.descriptionEn,
      descriptionHe: p.descriptionHe,
      status: p.status,
      kind: p.kind,
      tenantId: p.tenantId,
      basePrice: p.basePrice != null ? String(p.basePrice) : null,
      currency: p.currency,
      includedCredits: p.includedAiUnits,
      // The voice share of the allowance. Chat is the remainder, always - the
      // editor sets a total and a voice share, never two independent numbers.
      voiceCredits: voiceShareOf(p),
      billingInterval: p.billingInterval,
      sortOrder: p.sortOrder,
      recommended: p.recommended,
      salesOnly: p.salesOnly,
      supportLevel: p.supportLevel,
      chatVolumeEnabled: p.chatVolumeEnabled,
      voiceVolumeEnabled: p.voiceVolumeEnabled,
      autoPurchaseEligible: p.autoPurchaseEligible,
      creditPackagesEligible: p.creditPackagesEligible,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
      publishedAt: p.publishedAt,
      internalNote: p.internalNote,
      subscriberCount: countFor(p.key, p.version),
      entitlements: p.entitlements.map((e) => ({ key: e.entitlementKey, valueType: e.valueType, value: e.value })),
      volumeOptions: p.volumeOptions.map((o) => ({
        id: o.id, key: o.key, channel: o.channel, dailyVolume: o.dailyVolume,
        monthlyVolume: o.monthlyVolume, creditsPerUnit: String(o.creditsPerUnit),
        additionalCredits: o.additionalCredits, additionalPrice: String(o.additionalPrice),
        currency: o.currency, isDefault: o.isDefault, enabled: o.enabled, sortOrder: o.sortOrder,
      })),
      estimation: p.estimations[0]
        ? {
            chatCreditsPerEstimatedConversation: Number(p.estimations[0].chatCreditsPerEstimatedConversation),
            voiceCreditsPerEstimatedCall: Number(p.estimations[0].voiceCreditsPerEstimatedCall),
            businessDaysPerMonth: p.estimations[0].businessDaysPerMonth,
            version: p.estimations[0].version,
          }
        : null,
    })),
  });
});

/** The feature catalog, including which keys are catalogued but not built. */
router.get("/admin/pricing/features", authenticate, requirePlatformPermission(P.PRICING_READ), async (_req, res) => {
  res.json({
    features: FEATURE_CATALOG.map((f) => ({
      key: f.key,
      nameEn: f.nameEn,
      nameHe: f.nameHe,
      description: f.descriptionEn,
      category: f.category,
      entitlementType: f.entitlementType,
      defaultValue: f.defaultValue,
      enforcementLocations: f.enforcementLocations,
      customerVisible: f.customerVisible,
      // False means the capability is NOT built. It cannot be attached to a
      // plan and never renders on a pricing page.
      implemented: f.implemented,
      sortOrder: f.sortOrder,
    })),
  });
});

router.get("/admin/pricing/permissions", authenticate, requirePlatformPermission(P.PRICING_READ), async (_req, res) => {
  res.json({ permissions: PLATFORM_PERMISSION_CATALOG });
});

// ── Plan versions ───────────────────────────────────────────────────────────

/**
 * Create a new DRAFT version of a plan key, cloned from an existing version.
 *
 * This is the ONLY way to change a live plan's commercial terms. The draft is
 * invisible to customers until published.
 */
router.post("/admin/pricing/plans/:key/versions", authenticate, requirePlatformPermission(P.PLANS_MANAGE), async (req, res) => {
  const key = String(req.params.key);
  const source = await prisma.plan.findFirst({
    where: { key },
    orderBy: { version: "desc" },
    include: { entitlements: true, volumeOptions: true, estimations: { where: { active: true }, take: 1 } },
  });
  if (!source) return res.status(404).json({ error: "unknown_plan" });

  const version = source.version + 1;
  const draft = await prisma.plan.create({
    data: {
      key,
      version,
      name: req.body?.name ?? source.name,
      nameHe: req.body?.nameHe ?? source.nameHe,
      descriptionEn: req.body?.descriptionEn ?? source.descriptionEn,
      descriptionHe: req.body?.descriptionHe ?? source.descriptionHe,
      billingInterval: source.billingInterval,
      basePrice: req.body?.basePrice != null ? String(req.body.basePrice) : source.basePrice,
      currency: req.body?.currency ?? source.currency,
      includedAiUnits: req.body?.includedCredits ?? source.includedAiUnits,
      salesOnly: source.salesOnly,
      status: "DRAFT",
      kind: source.kind,
      tenantId: source.tenantId,
      sortOrder: source.sortOrder,
      recommended: false,
      supportLevel: req.body?.supportLevel ?? source.supportLevel,
      dataRetentionDays: source.dataRetentionDays,
      autoPurchaseEligible: source.autoPurchaseEligible,
      creditPackagesEligible: source.creditPackagesEligible,
      chatVolumeEnabled: req.body?.chatVolumeEnabled ?? source.chatVolumeEnabled,
      voiceVolumeEnabled: req.body?.voiceVolumeEnabled ?? source.voiceVolumeEnabled,
      internalNote: req.body?.internalNote ?? null,
    },
  });

  // Clone entitlements and volume options so the draft is editable in isolation.
  for (const e of source.entitlements) {
    await prisma.planEntitlement.create({
      data: { planId: draft.id, entitlementKey: e.entitlementKey, valueType: e.valueType, value: e.value as any },
    });
  }
  for (const o of source.volumeOptions) {
    await prisma.planVolumeOption.create({
      data: {
        planId: draft.id, key: o.key, channel: o.channel, dailyVolume: o.dailyVolume,
        businessDaysPerMonth: o.businessDaysPerMonth, monthlyVolume: o.monthlyVolume,
        creditsPerUnit: o.creditsPerUnit, additionalCredits: o.additionalCredits,
        additionalPrice: o.additionalPrice, currency: o.currency, isDefault: o.isDefault,
        sortOrder: o.sortOrder, enabled: o.enabled,
      },
    });
  }

  // A plan-scoped estimate belongs to the PLAN, not to one version of it. The
  // config is keyed by plan id, so without cloning it the new version silently
  // falls back to the global assumption and publishing quietly restates what
  // the pricing page says about this plan.
  const sourceEstimation = source.estimations[0];
  if (sourceEstimation) {
    await prisma.publicEstimationConfig.create({
      data: {
        scope: "PLAN",
        planId: draft.id,
        version: 1,
        active: true,
        chatCreditsPerEstimatedConversation: sourceEstimation.chatCreditsPerEstimatedConversation,
        voiceCreditsPerEstimatedCall: sourceEstimation.voiceCreditsPerEstimatedCall,
        businessDaysPerMonth: sourceEstimation.businessDaysPerMonth,
        effectiveFrom: sourceEstimation.effectiveFrom,
        internalNote: `Carried over from ${key} v${source.version}`,
        createdBy: req.user?.userId,
      },
    });
  }

  // The cloned split describes the SOURCE version's allowance. If this draft
  // was created with a different one, the split has to follow it or the draft
  // would quote the old number.
  await syncCreditRows(draft.id, draft.includedAiUnits, req.body?.voiceCredits ?? null);

  await audit(req, "pricing.plan_version_created", "plan", draft.id, { key, version, from: source.version });
  res.json({ ok: true, plan: { id: draft.id, key, version, status: draft.status } });
});

/** Edit a DRAFT. An ACTIVE version is immutable by design. */
router.patch("/admin/pricing/plans/:id", authenticate, requirePlatformPermission(P.PRICING_MANAGE), async (req, res) => {
  const plan = await prisma.plan.findUnique({ where: { id: String(req.params.id) } });
  if (!plan) return res.status(404).json({ error: "unknown_plan" });
  if (plan.status !== "DRAFT") {
    return res.status(409).json({
      error: "plan_version_immutable",
      // Point at the correct action rather than silently refusing.
      hint: "Create a new draft version instead of editing a published one.",
      status: plan.status,
    });
  }

  const b = req.body ?? {};
  const updated = await prisma.plan.update({
    where: { id: plan.id },
    data: {
      ...(b.name != null ? { name: String(b.name) } : {}),
      ...(b.nameHe != null ? { nameHe: String(b.nameHe) } : {}),
      ...(b.descriptionEn != null ? { descriptionEn: String(b.descriptionEn) } : {}),
      ...(b.descriptionHe != null ? { descriptionHe: String(b.descriptionHe) } : {}),
      ...(b.basePrice != null ? { basePrice: String(b.basePrice) } : {}),
      ...(b.currency != null ? { currency: String(b.currency) } : {}),
      ...(b.includedCredits != null ? { includedAiUnits: Number(b.includedCredits) } : {}),
      ...(b.sortOrder != null ? { sortOrder: Number(b.sortOrder) } : {}),
      ...(b.supportLevel != null ? { supportLevel: String(b.supportLevel) } : {}),
      ...(b.dataRetentionDays != null ? { dataRetentionDays: Number(b.dataRetentionDays) } : {}),
      ...(b.autoPurchaseEligible != null ? { autoPurchaseEligible: Boolean(b.autoPurchaseEligible) } : {}),
      ...(b.creditPackagesEligible != null ? { creditPackagesEligible: Boolean(b.creditPackagesEligible) } : {}),
      ...(b.chatVolumeEnabled != null ? { chatVolumeEnabled: Boolean(b.chatVolumeEnabled) } : {}),
      ...(b.voiceVolumeEnabled != null ? { voiceVolumeEnabled: Boolean(b.voiceVolumeEnabled) } : {}),
      ...(b.internalNote != null ? { internalNote: String(b.internalNote) } : {}),
      ...(b.effectiveFrom != null ? { effectiveFrom: new Date(b.effectiveFrom) } : {}),
    },
  });

  // The allowance a draft SELLS is the split, so changing the included credits
  // without rewriting it changed nothing a customer would ever receive.
  if (b.includedCredits != null || b.voiceCredits != null) {
    await syncCreditRows(plan.id, updated.includedAiUnits, b.voiceCredits != null ? Number(b.voiceCredits) : null);
  }

  await audit(req, "pricing.plan_updated", "plan", plan.id, { key: plan.key, version: plan.version, fields: Object.keys(b) });
  res.json({ ok: true, plan: { id: updated.id, key: updated.key, version: updated.version, status: updated.status } });
});

/**
 * Discard a DRAFT plan version.
 *
 * DRAFT only, and that is the whole safety argument. A published version is
 * immutable because organizations hold a commercial snapshot of it; deleting
 * one would remove the definition of what they agreed to pay for while they are
 * still paying it. A draft has never been sold and can be discarded freely.
 *
 * Entitlements and volume options cascade. Nothing else references a draft.
 */
router.delete("/admin/pricing/plans/:id", authenticate, requirePlatformPermission(P.PLANS_MANAGE), async (req, res) => {
  const plan = await prisma.plan.findUnique({ where: { id: String(req.params.id) } });
  if (!plan) return res.status(404).json({ error: "unknown_plan" });

  if (plan.status !== "DRAFT") {
    return res.status(409).json({
      error: "plan_version_immutable",
      hint: "Only a draft can be discarded. A published version defines what paying organizations agreed to.",
      status: plan.status,
    });
  }

  // Belt and braces. A draft should have no subscribers by construction -
  // subscriptions reference published versions - so if one does, something is
  // wrong and deleting is the wrong response to it.
  const subscribers = await prisma.subscription.count({
    where: { planKey: plan.key, planVersion: plan.version },
  });
  if (subscribers > 0) {
    return res.status(409).json({ error: "plan_in_use", subscribers });
  }

  await prisma.plan.delete({ where: { id: plan.id } });
  await audit(req, "pricing.plan_discarded", "plan", plan.id, { key: plan.key, version: plan.version });
  res.json({ ok: true, discarded: { key: plan.key, version: plan.version } });
});

/**
 * Create a plan that does not exist yet, of a chosen kind.
 *
 * The only previous way to get a new plan was POST /plans/:key/versions, which
 * copies an EXISTING key and inherits its kind - so a POC or trial plan could
 * not be created at all unless one already existed. Custom plans had their own
 * endpoint, hardcoded to CUSTOM and requiring a tenant.
 *
 * Always DRAFT. A plan that could be created already published would skip the
 * review the publish flow exists to provide.
 */
router.post("/admin/pricing/plans", authenticate, requirePlatformPermission(P.PLANS_MANAGE), async (req, res) => {
  const b = req.body ?? {};
  const key = String(b.key ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!key) return res.status(400).json({ error: "key_required" });

  // POC and TRIAL are time-boxed arrangements; PUBLIC is the sellable catalog.
  // CUSTOM is deliberately absent - it belongs to a tenant and has its own
  // endpoint that requires one.
  const ALLOWED = ["PUBLIC", "POC", "TRIAL"];
  const kind = String(b.kind ?? "PUBLIC").toUpperCase();
  if (!ALLOWED.includes(kind)) {
    return res.status(400).json({ error: "unsupported_kind", allowed: ALLOWED });
  }

  const existing = await prisma.plan.findFirst({ where: { key } });
  if (existing) {
    return res.status(409).json({
      error: "plan_key_exists",
      hint: "Create a new version of it instead of a second plan with the same key.",
    });
  }

  const plan = await prisma.plan.create({
    data: {
      key,
      version: 1,
      name: String(b.name ?? key),
      nameHe: b.nameHe ?? null,
      descriptionEn: b.descriptionEn ?? null,
      descriptionHe: b.descriptionHe ?? null,
      basePrice: b.basePrice != null ? String(b.basePrice) : null,
      currency: b.currency ?? "USD",
      includedAiUnits: Number(b.includedCredits ?? 0),
      status: "DRAFT",
      kind: kind as any,
      // A POC or trial is not sold on the pricing page.
      salesOnly: kind !== "PUBLIC",
      sortOrder: Number(b.sortOrder ?? 0),
      internalNote: b.internalNote ?? null,
    },
  });

  // Write the split up front so the plan never has an allowance the catalog
  // cannot see. A plan created with 0 credits gets a 0 split, not a missing one.
  await syncCreditRows(plan.id, plan.includedAiUnits, b.voiceCredits ?? 0);

  await audit(req, "pricing.plan_created", "plan", plan.id, { key, kind });
  res.status(201).json({ ok: true, plan: { id: plan.id, key: plan.key, version: plan.version, kind: plan.kind } });
});

/** Set feature entitlements and numeric limits on a DRAFT. */
router.put("/admin/pricing/plans/:id/entitlements", authenticate, requirePlatformPermission(P.PRICING_MANAGE), async (req, res) => {
  const plan = await prisma.plan.findUnique({ where: { id: String(req.params.id) } });
  if (!plan) return res.status(404).json({ error: "unknown_plan" });
  if (plan.status !== "DRAFT") return res.status(409).json({ error: "plan_version_immutable" });

  const entries: Array<{ key: string; valueType: string; value: unknown }> = req.body?.entitlements ?? [];
  // A capability the product has not built can never be attached to a plan, no
  // matter what the console sends.
  const rejected = entries.filter((e) => e.valueType === "BOOLEAN" && (e.value as any)?.bool && isUnsellable(e.key));
  if (rejected.length) {
    return res.status(422).json({ error: "feature_not_implemented", features: rejected.map((r) => r.key) });
  }

  for (const e of entries) {
    await prisma.planEntitlement.upsert({
      where: { planId_entitlementKey: { planId: plan.id, entitlementKey: e.key } },
      create: { planId: plan.id, entitlementKey: e.key, valueType: e.valueType as any, value: e.value as any },
      update: { valueType: e.valueType as any, value: e.value as any },
    });
  }
  await audit(req, "pricing.plan_entitlements_updated", "plan", plan.id, { key: plan.key, version: plan.version, count: entries.length });
  res.json({ ok: true, updated: entries.length });
});

/** Create or update a volume option on a DRAFT. */
router.put("/admin/pricing/plans/:id/volume-options", authenticate, requirePlatformPermission(P.PRICING_MANAGE), async (req, res) => {
  const plan = await prisma.plan.findUnique({ where: { id: String(req.params.id) } });
  if (!plan) return res.status(404).json({ error: "unknown_plan" });
  if (plan.status !== "DRAFT") return res.status(409).json({ error: "plan_version_immutable" });

  const options: any[] = req.body?.options ?? [];
  for (const o of options) {
    const businessDays = Number(o.businessDaysPerMonth ?? 25);
    await prisma.planVolumeOption.upsert({
      where: { planId_key: { planId: plan.id, key: String(o.key) } },
      create: {
        planId: plan.id, key: String(o.key), channel: o.channel,
        dailyVolume: Number(o.dailyVolume), businessDaysPerMonth: businessDays,
        monthlyVolume: Number(o.dailyVolume) * businessDays,
        creditsPerUnit: Number(o.creditsPerUnit).toFixed(4),
        additionalCredits: Number(o.additionalCredits ?? 0),
        additionalPrice: Number(o.additionalPrice ?? 0).toFixed(2),
        currency: o.currency ?? plan.currency,
        isDefault: Boolean(o.isDefault), sortOrder: Number(o.sortOrder ?? 0),
        enabled: o.enabled !== false, internalNote: o.internalNote ?? null,
      },
      update: {
        dailyVolume: Number(o.dailyVolume), businessDaysPerMonth: businessDays,
        monthlyVolume: Number(o.dailyVolume) * businessDays,
        creditsPerUnit: Number(o.creditsPerUnit).toFixed(4),
        additionalCredits: Number(o.additionalCredits ?? 0),
        additionalPrice: Number(o.additionalPrice ?? 0).toFixed(2),
        isDefault: Boolean(o.isDefault), sortOrder: Number(o.sortOrder ?? 0),
        enabled: o.enabled !== false, internalNote: o.internalNote ?? null,
      },
    });
  }
  await audit(req, "pricing.volume_options_updated", "plan", plan.id, { key: plan.key, version: plan.version, count: options.length });
  res.json({ ok: true, updated: options.length });
});

/**
 * What publishing this draft would actually do.
 *
 * Shows the diff against the currently ACTIVE version and, crucially, how many
 * organizations are on it and what happens to them (nothing - they keep their
 * snapshot until explicitly migrated).
 */
router.get("/admin/pricing/plans/:id/preview", authenticate, requirePlatformPermission(P.PRICING_READ), async (req, res) => {
  const draft = await prisma.plan.findUnique({
    where: { id: String(req.params.id) },
    include: { entitlements: true, volumeOptions: true },
  });
  if (!draft) return res.status(404).json({ error: "unknown_plan" });

  const current = await prisma.plan.findFirst({
    where: { key: draft.key, status: "ACTIVE", NOT: { id: draft.id } },
    include: { entitlements: true, volumeOptions: true },
  });

  const subscribers = current
    ? await prisma.subscription.count({ where: { planKey: current.key, planVersion: current.version } })
    : 0;

  const featureDiff: Array<{ key: string; from: boolean | null; to: boolean }> = [];
  for (const e of draft.entitlements.filter((x) => x.valueType === "BOOLEAN")) {
    const before = current?.entitlements.find((c) => c.entitlementKey === e.entitlementKey);
    const from = before ? Boolean((before.value as any)?.bool) : null;
    const to = Boolean((e.value as any)?.bool);
    if (from !== to) featureDiff.push({ key: e.entitlementKey, from, to });
  }

  const limitDiff: Array<{ key: string; from: number | null; to: number }> = [];
  for (const e of draft.entitlements.filter((x) => x.valueType === "COUNTER")) {
    const before = current?.entitlements.find((c) => c.entitlementKey === e.entitlementKey);
    const from = before ? Number((before.value as any)?.count) : null;
    const to = Number((e.value as any)?.count);
    if (from !== to) limitDiff.push({ key: e.entitlementKey, from, to });
  }

  res.json({
    draft: { id: draft.id, key: draft.key, version: draft.version, status: draft.status },
    currentVersion: current ? current.version : null,
    changes: {
      price: { from: current?.basePrice != null ? String(current.basePrice) : null, to: draft.basePrice != null ? String(draft.basePrice) : null },
      currency: { from: current?.currency ?? null, to: draft.currency },
      includedCredits: { from: current?.includedAiUnits ?? null, to: draft.includedAiUnits },
      features: featureDiff,
      limits: limitDiff,
      volumeOptions: {
        from: current?.volumeOptions.length ?? 0,
        to: draft.volumeOptions.length,
      },
    },
    impact: {
      organizationsOnPreviousVersion: subscribers,
      // The honest statement of what publishing does to them: nothing.
      grandfathering:
        "Existing subscriptions stay on their current version and keep their commercial snapshot. Publishing changes what NEW subscribers receive.",
      migrationRequired: subscribers > 0,
    },
  });
});

/**
 * Publish a draft: it becomes the ACTIVE version, the previous one is RETIRED.
 *
 * Retiring does NOT touch subscriptions - they keep pointing at the retired
 * version and keep their snapshot. That is what grandfathering means here.
 */
router.post("/admin/pricing/plans/:id/publish", authenticate, requirePlatformPermission(P.PRICING_PUBLISH), async (req, res) => {
  const draft = await prisma.plan.findUnique({ where: { id: String(req.params.id) } });
  if (!draft) return res.status(404).json({ error: "unknown_plan" });
  if (draft.status !== "DRAFT") return res.status(409).json({ error: "not_a_draft", status: draft.status });

  const previous = await prisma.plan.findFirst({ where: { key: draft.key, status: "ACTIVE", NOT: { id: draft.id } } });

  await prisma.$transaction(async (tx) => {
    if (previous) {
      await tx.plan.update({
        where: { id: previous.id },
        data: { status: "RETIRED", effectiveTo: new Date(), recommended: false },
      });
    }
    await tx.plan.update({
      where: { id: draft.id },
      data: {
        status: "ACTIVE",
        publishedAt: new Date(),
        publishedBy: req.user?.userId ?? "system",
        effectiveFrom: draft.effectiveFrom ?? new Date(),
        // The recommendation follows the plan, not the version. A draft is
        // created with the flag off, so republishing the recommended plan used
        // to drop the badge off the pricing page without anyone asking.
        ...(previous?.recommended ? { recommended: true } : {}),
      },
    });
  });

  await audit(req, "pricing.plan_published", "plan", draft.id, {
    key: draft.key, version: draft.version, retiredVersion: previous?.version ?? null,
  });
  res.json({ ok: true, published: { key: draft.key, version: draft.version }, retired: previous?.version ?? null });
});

/** Reorder the public catalog and set the recommended plan. */
router.post("/admin/pricing/plans/order", authenticate, requirePlatformPermission(P.PLANS_MANAGE), async (req, res) => {
  const body = req.body ?? {};
  const order: Array<{ key: string; sortOrder: number }> = body.order ?? [];
  for (const o of order) {
    await prisma.plan.updateMany({ where: { key: o.key }, data: { sortOrder: Number(o.sortOrder) } });
  }

  // Presence, not truthiness, decides whether the recommendation changes:
  // omitting the field leaves it alone, sending null CLEARS it. Reading a
  // missing field as null left no way to un-recommend a plan at all.
  let recommendedKey: string | null | undefined;
  if ("recommendedKey" in body) {
    recommendedKey = body.recommendedKey == null ? null : String(body.recommendedKey);

    if (recommendedKey !== null) {
      // Recommending a plan nobody can buy would badge a card the pricing page
      // never renders, so it is refused rather than silently ignored.
      const target = await prisma.plan.findFirst({
        where: { key: recommendedKey, status: "ACTIVE", kind: "PUBLIC" },
        select: { id: true },
      });
      if (!target) {
        return res.status(404).json({
          error: "unknown_recommendable_plan",
          hint: "Only a published public plan can be the recommended one.",
        });
      }
    }

    // Exactly one recommended plan: clear then set, so a stale flag cannot
    // leave two cards both claiming to be the recommendation.
    await prisma.plan.updateMany({ where: { kind: "PUBLIC" }, data: { recommended: false } });
    if (recommendedKey !== null) {
      await prisma.plan.updateMany({ where: { key: recommendedKey, status: "ACTIVE" }, data: { recommended: true } });
    }
  }

  await audit(req, "pricing.catalog_reordered", "plan", null, { order, recommendedKey: recommendedKey ?? null });
  res.json({ ok: true, recommendedKey: recommendedKey ?? null });
});

// ── Public estimation ───────────────────────────────────────────────────────

router.get("/admin/pricing/estimation", authenticate, requirePlatformPermission(P.PRICING_READ), async (_req, res) => {
  const configs = await prisma.publicEstimationConfig.findMany({
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    take: 50,
    include: { plan: { select: { key: true, version: true } }, volumeOption: { select: { key: true } } },
  });
  res.json({
    configs: configs.map((c) => ({
      id: c.id, scope: c.scope, version: c.version, active: c.active,
      planKey: c.plan?.key ?? null, volumeOptionKey: c.volumeOption?.key ?? null,
      chatCreditsPerEstimatedConversation: Number(c.chatCreditsPerEstimatedConversation),
      voiceCreditsPerEstimatedCall: Number(c.voiceCreditsPerEstimatedCall),
      businessDaysPerMonth: c.businessDaysPerMonth,
      effectiveFrom: c.effectiveFrom, internalNote: c.internalNote, publishedAt: c.publishedAt,
    })),
  });
});

/**
 * Preview a proposed ratio BEFORE publishing it.
 *
 * Shows the new monthly and daily estimates, the new displayed price per
 * conversation, and which plans it would affect - alongside the explicit
 * statement that existing subscriptions keep their snapshot.
 */
router.post("/admin/pricing/estimation/preview", authenticate, requirePlatformPermission(P.PRICING_READ), async (req, res) => {
  const chatRatio = Number(req.body?.chatCreditsPerEstimatedConversation);
  const voiceRatio = Number(req.body?.voiceCreditsPerEstimatedCall);
  const businessDays = Number(req.body?.businessDaysPerMonth ?? 25);
  if (!(chatRatio > 0) || !(voiceRatio > 0) || !(businessDays > 0)) {
    return res.status(400).json({ error: "ratios_must_be_positive" });
  }

  const scope = String(req.body?.scope ?? "GLOBAL");
  const planId = req.body?.planId ?? null;

  const affected = await prisma.plan.findMany({
    where: scope === "GLOBAL" ? { status: "ACTIVE" } : { id: planId },
    include: {
      entitlements: { where: { entitlementKey: "config:credit_split" } },
      volumeOptions: { orderBy: { sortOrder: "asc" } },
    },
  });

  const proposed = { chatCreditsPerEstimatedConversation: chatRatio, voiceCreditsPerEstimatedCall: voiceRatio, businessDaysPerMonth: businessDays, version: 0, configId: null, scope: "GLOBAL" as const };

  const plans = [];
  for (const p of affected) {
    const split = (p.entitlements[0]?.value as any) ?? { chat: p.includedAiUnits, voice: 0 };
    const current = await resolveEstimation({ planId: p.id });
    // The plan's default tiers, so the preview shows what the pricing page will
    // actually say. A plan that SELLS a volume is unmoved by a ratio change, and
    // the operator has to be able to see that rather than be shown a delta that
    // will never reach a customer.
    const defaultTier = (channel: "CHAT" | "VOICE", enabled: boolean) => {
      if (!enabled) return null;
      const offered = p.volumeOptions.filter((o) => o.channel === channel && o.enabled);
      return declaredVolumeOf(offered.find((o) => o.isDefault) ?? offered[0] ?? null);
    };
    const volumes = {
      chatVolume: defaultTier("CHAT", p.chatVolumeEnabled),
      voiceVolume: defaultTier("VOICE", p.voiceVolumeEnabled),
    };
    const credits = { chatCredits: Number(split.chat) || 0, voiceCredits: Number(split.voice) || 0 };
    const before = estimatePlanCapacity({ ...credits, ...volumes, ratios: current });
    const after = estimatePlanCapacity({ ...credits, ...volumes, ratios: proposed });
    const price = p.basePrice != null ? money(p.basePrice, p.currency) : money("0.00", p.currency);
    const perChatBefore = before.chat.estimatedMonthly > 0 ? price.minor / before.chat.estimatedMonthly / 100 : null;
    const perChatAfter = after.chat.estimatedMonthly > 0 ? price.minor / after.chat.estimatedMonthly / 100 : null;
    plans.push({
      key: p.key,
      version: p.version,
      kind: p.kind,
      before: { monthlyChats: Math.round(before.chat.estimatedMonthly), dailyChats: Math.round(before.chat.estimatedDaily * 10) / 10, monthlyCalls: Math.round(before.voice.estimatedMonthly), pricePerChat: perChatBefore?.toFixed(2) ?? null },
      after: { monthlyChats: Math.round(after.chat.estimatedMonthly), dailyChats: Math.round(after.chat.estimatedDaily * 10) / 10, monthlyCalls: Math.round(after.voice.estimatedMonthly), pricePerChat: perChatAfter?.toFixed(2) ?? null },
    });
  }

  // Every subscription carrying a snapshot is one this change cannot restate.
  const existingSubscriptions = await prisma.subscription.count({ where: { NOT: { snapshotAt: null } } });

  res.json({
    proposed: { chatCreditsPerEstimatedConversation: chatRatio, voiceCreditsPerEstimatedCall: voiceRatio, businessDaysPerMonth: businessDays },
    affectedPlans: plans,
    impact: {
      subscriptionsRetainingTheirSnapshot: existingSubscriptions,
      guarantee:
        "Publishing a new ratio changes what pricing pages SAY. It does not change consumed credits, ledger balances, invoices, historical subscriptions, or any active plan version.",
    },
  });
});

/**
 * Publish a new estimation version.
 *
 * Deactivates the previous config at the same scope and creates a new version.
 * Nothing else is written - not the ledger, not an invoice, not a subscription.
 */
router.post("/admin/pricing/estimation", authenticate, requirePlatformPermission(P.PRICING_PUBLISH), async (req, res) => {
  const chatRatio = Number(req.body?.chatCreditsPerEstimatedConversation);
  const voiceRatio = Number(req.body?.voiceCreditsPerEstimatedCall);
  const businessDays = Number(req.body?.businessDaysPerMonth ?? 25);
  if (!(chatRatio > 0) || !(voiceRatio > 0) || !(businessDays > 0)) {
    return res.status(400).json({ error: "ratios_must_be_positive" });
  }

  const scope = (req.body?.scope ?? "GLOBAL") as "GLOBAL" | "PLAN" | "VOLUME_OPTION";
  const planId = req.body?.planId ?? null;
  const volumeOptionId = req.body?.volumeOptionId ?? null;
  const effectiveFrom = req.body?.effectiveFrom ? new Date(req.body.effectiveFrom) : new Date();

  const previous = await prisma.publicEstimationConfig.findFirst({
    where: { scope, planId, volumeOptionId, active: true },
    orderBy: { version: "desc" },
  });

  const created = await prisma.$transaction(async (tx) => {
    if (previous) await tx.publicEstimationConfig.update({ where: { id: previous.id }, data: { active: false } });
    return tx.publicEstimationConfig.create({
      data: {
        scope, planId, volumeOptionId,
        version: (previous?.version ?? 0) + 1,
        chatCreditsPerEstimatedConversation: chatRatio.toFixed(4),
        voiceCreditsPerEstimatedCall: voiceRatio.toFixed(4),
        businessDaysPerMonth: businessDays,
        effectiveFrom,
        internalNote: req.body?.internalNote ?? null,
        createdBy: req.user?.userId,
        publishedAt: new Date(),
        publishedBy: req.user?.userId,
      },
    });
  });

  invalidateEstimationCache();
  await audit(req, "pricing.estimation_published", "estimation", created.id, {
    scope, planId, volumeOptionId, chatRatio, voiceRatio, businessDays, version: created.version,
    previousVersion: previous?.version ?? null,
  });
  res.json({ ok: true, config: { id: created.id, version: created.version, scope } });
});

// ── Credit packages ─────────────────────────────────────────────────────────

router.get("/admin/pricing/packages", authenticate, requirePlatformPermission(P.PRICING_READ), async (_req, res) => {
  const packages = await prisma.creditPackage.findMany({ orderBy: [{ sortOrder: "asc" }, { units: "asc" }] });
  res.json({
    packages: packages.map((p) => ({
      key: p.key, name: p.name, nameHe: p.nameHe, credits: p.units,
      price: String(p.price), currency: p.currency, status: p.status, active: p.active,
      customerVisible: p.customerVisible, eligiblePlanKeys: p.eligiblePlanKeys,
      activeFrom: p.activeFrom, activeTo: p.activeTo, expiryPolicy: p.expiryPolicy,
      expiryDays: p.expiryDays, maxPurchaseQuantity: p.maxPurchaseQuantity,
      discountLabel: p.discountLabel, sortOrder: p.sortOrder,
      scheduledPrice: p.scheduledPrice != null ? String(p.scheduledPrice) : null,
      scheduledPriceFrom: p.scheduledPriceFrom, internalNote: p.internalNote,
    })),
  });
});

router.put("/admin/pricing/packages/:key", authenticate, requirePlatformPermission(P.PRICING_MANAGE), async (req, res) => {
  const key = String(req.params.key);
  const b = req.body ?? {};
  const data = {
    name: String(b.name ?? key),
    nameHe: b.nameHe ?? null,
    units: Number(b.credits ?? 0),
    price: Number(b.price ?? 0).toFixed(2),
    currency: b.currency ?? "USD",
    status: b.status ?? "DRAFT",
    active: b.active !== false,
    customerVisible: b.customerVisible !== false,
    eligiblePlanKeys: b.eligiblePlanKeys ?? null,
    activeFrom: b.activeFrom ? new Date(b.activeFrom) : null,
    activeTo: b.activeTo ? new Date(b.activeTo) : null,
    expiryPolicy: b.expiryPolicy ?? "NEVER",
    expiryDays: b.expiryDays != null ? Number(b.expiryDays) : null,
    maxPurchaseQuantity: b.maxPurchaseQuantity != null ? Number(b.maxPurchaseQuantity) : null,
    discountLabel: b.discountLabel ?? null,
    sortOrder: Number(b.sortOrder ?? 0),
    // A scheduled price does NOT change the live price until its date arrives,
    // so scheduling is not a disguised immediate price change.
    scheduledPrice: b.scheduledPrice != null ? Number(b.scheduledPrice).toFixed(2) : null,
    scheduledPriceFrom: b.scheduledPriceFrom ? new Date(b.scheduledPriceFrom) : null,
    internalNote: b.internalNote ?? null,
  };
  const pkg = await prisma.creditPackage.upsert({ where: { key }, create: { key, ...data }, update: data });
  await audit(req, "pricing.package_updated", "credit_package", pkg.id, { key, price: data.price, credits: data.units, status: data.status });
  res.json({ ok: true, package: { key: pkg.key, status: pkg.status } });
});

/**
 * Remove a credit package from the catalog.
 *
 * Refuses in two cases, both of which would be silent damage:
 *
 *   A tenant's automatic top-up points at packages BY KEY. Deleting one leaves
 *   that policy aiming at nothing, and the failure surfaces later - when their
 *   credits run low and the top-up they configured does not happen.
 *
 *   A package that has been bought is the description of what somebody paid
 *   for. Purchases record it as `package:<key>` on the credit lot, so the row
 *   is what explains a real charge months later. That gets RETIRED, not
 *   deleted: retiring takes it off sale and keeps the explanation.
 *
 * Only a package nobody has bought and nothing points at is actually removed.
 */
router.delete("/admin/pricing/packages/:key", authenticate, requirePlatformPermission(P.PRICING_MANAGE), async (req, res) => {
  const key = String(req.params.key);
  const pkg = await prisma.creditPackage.findUnique({ where: { key } });
  if (!pkg) return res.status(404).json({ error: "unknown_package" });

  const [autoPolicies, purchased] = await Promise.all([
    prisma.autoPurchasePolicy.count({ where: { packageKey: key } }),
    prisma.aiUnitLot.count({ where: { source: { in: [`package:${key}`, `auto:${key}`] } } }),
  ]);

  if (autoPolicies > 0) {
    return res.status(409).json({
      error: "package_in_use",
      hint: "Organizations have automatic top-up pointing at this package. Retire it instead, or move them first.",
      autoPurchasePolicies: autoPolicies,
    });
  }

  if (purchased > 0) {
    return res.status(409).json({
      error: "package_already_purchased",
      hint: "This package explains real charges. Retire it instead - that removes it from sale and keeps the record.",
      purchases: purchased,
    });
  }

  await prisma.creditPackage.delete({ where: { key } });
  await audit(req, "pricing.package_deleted", "credit_package", pkg.id, { key });
  res.json({ ok: true, deleted: key });
});

// ── Currency ────────────────────────────────────────────────────────────────

router.get("/admin/pricing/currency", authenticate, requirePlatformPermission(P.PRICING_READ), async (_req, res) => {
  const cfg = await getCurrencyConfig();
  const latest = await prisma.fxRateSnapshot.findFirst({
    where: { baseCurrency: "USD", quoteCurrency: "ILS" },
    orderBy: { fetchedAt: "desc" },
  });
  res.json({
    config: cfg,
    fx: latest ? { rate: String(latest.rate), source: latest.source, rateDate: latest.rateDate, fetchedAt: latest.fetchedAt } : null,
  });
});

router.put("/admin/pricing/currency", authenticate, requirePlatformPermission(P.PRICING_MANAGE), async (req, res) => {
  const b = req.body ?? {};
  const existing = await prisma.pricingCurrencyConfig.findFirst({ where: { active: true } });
  const data = {
    baseCurrency: b.baseCurrency ?? "USD",
    displayCurrencies: b.displayCurrencies ?? ["USD", "ILS"],
    ilsRoundingIncrement: Number(b.ilsRoundingIncrement ?? 5),
    roundingMode: b.roundingMode ?? "UP",
    fxSource: b.fxSource ?? "boi",
    fxRefreshHours: Number(b.fxRefreshHours ?? 24),
    fallbackUsdIls: Number(b.fallbackUsdIls ?? 3.7).toFixed(6),
    chargeInDisplayCurrency: Boolean(b.chargeInDisplayCurrency),
    updatedBy: req.user?.userId,
  };
  const cfg = existing
    ? await prisma.pricingCurrencyConfig.update({ where: { id: existing.id }, data })
    : await prisma.pricingCurrencyConfig.create({ data: { ...data, active: true } });
  invalidateCurrencyCache();
  await audit(req, "pricing.currency_updated", "currency_config", cfg.id, data);
  res.json({ ok: true, config: cfg });
});

router.post("/admin/pricing/currency/refresh-fx", authenticate, requirePlatformPermission(P.PRICING_MANAGE), async (req, res) => {
  const fx = await refreshUsdIlsRate();
  await audit(req, "pricing.fx_refreshed", "fx_rate", null, { rate: fx?.rate, source: fx?.source, isFallback: fx?.isFallback });
  res.json({ ok: true, fx });
});

// ── Custom plans ────────────────────────────────────────────────────────────

/**
 * Build an organization-specific negotiated plan.
 *
 * A custom plan is a CUSTOM-kind PlanVersion scoped to one tenant. It never
 * mutates a public plan, it is versioned like any other, and it flows through
 * the same entitlement resolver with no special casing.
 */
router.post("/admin/pricing/custom-plans", authenticate, requirePlatformPermission(P.CUSTOM_PLANS_MANAGE), async (req, res) => {
  const b = req.body ?? {};
  const tenantId = String(b.tenantId ?? "");
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
  if (!tenant) return res.status(404).json({ error: "unknown_tenant" });

  const key = String(b.key ?? `custom_${tenantId.slice(-8)}`);
  const previous = await prisma.plan.findFirst({ where: { key }, orderBy: { version: "desc" } });
  const version = (previous?.version ?? 0) + 1;

  const features: string[] = Array.isArray(b.features) ? b.features : [];
  const unbuilt = features.filter((f) => isUnsellable(f));
  if (unbuilt.length) return res.status(422).json({ error: "feature_not_implemented", features: unbuilt });

  const plan = await prisma.plan.create({
    data: {
      key, version,
      name: String(b.name ?? `${tenant.name} plan`),
      nameHe: b.nameHe ?? null,
      descriptionEn: b.description ?? null,
      billingInterval: b.billingInterval ?? "MONTHLY",
      basePrice: b.monthlyPrice != null ? Number(b.monthlyPrice).toFixed(2) : null,
      currency: b.currency ?? "USD",
      // A negotiated plan may be described either as a total or as a per-channel
      // split. Whichever arrives, the total is what the plan stores.
      includedAiUnits: Number(b.includedCredits ?? Number(b.chatCredits ?? 0) + Number(b.voiceCredits ?? 0)),
      salesOnly: true,
      // Created as a DRAFT: a negotiated plan should be reviewed before it can
      // be assigned, exactly like a public one.
      status: "DRAFT",
      kind: "CUSTOM",
      tenantId,
      sortOrder: 500,
      supportLevel: b.supportLevel ?? "dedicated",
      autoPurchaseEligible: b.autoPurchaseEligible !== false,
      creditPackagesEligible: b.creditPackagesEligible !== false,
      chatVolumeEnabled: Boolean(b.chatVolumeEnabled),
      voiceVolumeEnabled: Boolean(b.voiceVolumeEnabled),
      contractStart: b.contractStart ? new Date(b.contractStart) : null,
      contractEnd: b.contractEnd ? new Date(b.contractEnd) : null,
      effectiveFrom: b.effectiveFrom ? new Date(b.effectiveFrom) : null,
      approvalState: "PENDING",
      internalNote: b.notes ?? null,
    },
  });

  const granted = new Set(features);
  for (const f of FEATURE_CATALOG) {
    if (f.entitlementType !== "BOOLEAN" || !f.implemented) continue;
    await prisma.planEntitlement.create({
      data: { planId: plan.id, entitlementKey: f.key, valueType: "BOOLEAN", value: { bool: granted.has(f.key) } },
    });
  }
  for (const [k, v] of Object.entries((b.limits ?? {}) as Record<string, number>)) {
    await prisma.planEntitlement.create({
      data: { planId: plan.id, entitlementKey: k, valueType: "COUNTER", value: { count: Number(v) } },
    });
  }
  // The split has to add up to the plan's own included credits, or the quote
  // would sell an allowance the plan does not say it has.
  await syncCreditRows(plan.id, plan.includedAiUnits, b.voiceCredits ?? 0);

  // A custom plan may carry its own public estimation assumption.
  if (b.estimation) {
    await prisma.publicEstimationConfig.create({
      data: {
        scope: "PLAN", planId: plan.id, version: 1,
        chatCreditsPerEstimatedConversation: Number(b.estimation.chatCreditsPerEstimatedConversation ?? 8).toFixed(4),
        voiceCreditsPerEstimatedCall: Number(b.estimation.voiceCreditsPerEstimatedCall ?? 20).toFixed(4),
        businessDaysPerMonth: Number(b.estimation.businessDaysPerMonth ?? 25),
        createdBy: req.user?.userId, publishedAt: new Date(), publishedBy: req.user?.userId,
      },
    });
  }

  await audit(req, "pricing.custom_plan_created", "plan", plan.id, { tenantId, key, version, price: b.monthlyPrice });
  res.json({ ok: true, plan: { id: plan.id, key, version, status: plan.status, tenantId } });
});

/** Approve and publish a custom plan so the organization can be moved onto it. */
router.post("/admin/pricing/custom-plans/:id/approve", authenticate, requirePlatformPermission(P.CUSTOM_PLANS_MANAGE), async (req, res) => {
  const plan = await prisma.plan.findUnique({ where: { id: String(req.params.id) } });
  if (!plan || plan.kind !== "CUSTOM") return res.status(404).json({ error: "unknown_custom_plan" });

  const previous = await prisma.plan.findFirst({ where: { key: plan.key, status: "ACTIVE", NOT: { id: plan.id } } });
  await prisma.$transaction(async (tx) => {
    if (previous) await tx.plan.update({ where: { id: previous.id }, data: { status: "RETIRED", effectiveTo: new Date() } });
    await tx.plan.update({
      where: { id: plan.id },
      data: {
        status: "ACTIVE", approvalState: "APPROVED", approvedBy: req.user?.userId, approvedAt: new Date(),
        publishedAt: new Date(), publishedBy: req.user?.userId, effectiveFrom: plan.effectiveFrom ?? new Date(),
      },
    });
  });
  await audit(req, "pricing.custom_plan_approved", "plan", plan.id, { tenantId: plan.tenantId, key: plan.key, version: plan.version });
  res.json({ ok: true });
});

// ── Preview the customer view ───────────────────────────────────────────────

/** Exactly what a customer of this organization would see on the pricing page. */
router.get("/admin/pricing/preview-customer", authenticate, requirePlatformPermission(P.PRICING_READ), async (req, res) => {
  const tenantId = req.query.tenantId ? String(req.query.tenantId) : null;
  const currency = req.query.currency ? String(req.query.currency).toUpperCase() : "USD";
  res.json({ plans: await listCatalogPlans({ tenantId, displayCurrency: currency }) });
});

export default router;

// ── Paid-tenant provisioning support (Sysadmin UI) ──────────────────────────
// Nested under /admin/pricing so it inherits the existing gateway location.

/**
 * Plans a Sysadmin may provision a paid tenant onto.
 *
 * ACTIVE and PUBLIC only. Draft, retired, sales-only, POC, TRIAL and any plan
 * scoped to an organization are excluded here as well as in the provisioning
 * service, so the UI cannot even offer something the backend would reject.
 */
router.get("/admin/pricing/provisioning/plans", authenticate, requirePlatformPermission(P.BILLING_PROVISION), async (_req, res) => {
  const plans = await prisma.plan.findMany({
    where: { status: "ACTIVE", kind: "PUBLIC", salesOnly: false, tenantId: null },
    orderBy: { sortOrder: "asc" },
    include: { volumeOptions: { where: { enabled: true }, orderBy: { dailyVolume: "asc" } } },
  });

  res.json({
    data: plans.map((p) => ({
      id: p.id,
      key: p.key,
      version: p.version,
      name: p.name,
      basePrice: String(p.basePrice),
      currency: p.currency,
      includedCredits: p.includedAiUnits,
      billingInterval: p.billingInterval,
      chatVolumeEnabled: p.chatVolumeEnabled,
      voiceVolumeEnabled: p.voiceVolumeEnabled,
      chatOptions: p.volumeOptions.filter((o) => o.channel === "CHAT").map(safeOption),
      voiceOptions: p.volumeOptions.filter((o) => o.channel === "VOICE").map(safeOption),
    })),
  });
});

function safeOption(o: { key: string; dailyVolume: number; additionalCredits: number; additionalPrice: unknown }) {
  return {
    key: o.key,
    dailyVolume: o.dailyVolume,
    additionalCredits: o.additionalCredits,
    additionalPrice: String(o.additionalPrice),
  };
}

/**
 * The authoritative commercial summary for a selection.
 *
 * The UI displays THIS and never computes a total of its own, so what an
 * operator sees is what provisioning will actually freeze into the snapshot.
 */
router.post("/admin/pricing/provisioning/quote", authenticate, requirePlatformPermission(P.BILLING_PROVISION), async (req, res) => {
  const { planVersionId, chatVolumeOptionKey, voiceVolumeOptionKey } = req.body ?? {};
  if (!planVersionId) return res.status(400).json({ error: "planVersionId required" });
  try {
    const plan = await resolveAndValidatePlan({
      planVersionId,
      chatVolumeOptionKey: chatVolumeOptionKey ?? null,
      voiceVolumeOptionKey: voiceVolumeOptionKey ?? null,
    });
    const q = await quotePricing({
      planKey: plan.key,
      planVersion: plan.version,
      chatVolumeOptionKey: chatVolumeOptionKey ?? null,
      voiceVolumeOptionKey: voiceVolumeOptionKey ?? null,
    });
    res.json({
      data: {
        planName: plan.name,
        basePrice: String(plan.basePrice),
        totalAmount: toDecimalString(q.monthlyPrice),
        currency: q.currency,
        includedCredits: q.includedCredits,
        estimatedChatsMonthly: q.estimate.chat.monthly,
        estimatedCallsMonthly: q.estimate.voice.monthly,
        billingInterval: plan.billingInterval,
        // Honest operational signal: cc/bill has no verified currency parameter,
        // so a non-ILS plan cannot actually be charged yet.
        chargeableToday: CHARGEABLE_CURRENCIES.includes(q.currency),
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err?.code ?? "quote_failed", message: err?.message });
  }
});
