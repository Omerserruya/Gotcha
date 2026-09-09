/**
 * The Shopify plan catalog.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a price list. Shopify owns the price, the currency, the billing
 * interval as charged, and the trial as granted. Under App Pricing those live
 * in the Partner Dashboard and cannot be version-controlled at all; under the
 * manual Billing API they are arguments we send once and Shopify then owns.
 * Either way, a number written here would be a second copy of a fact somebody
 * else is authoritative for, and the first time the two disagreed the merchant
 * would have been shown one price and charged another.
 *
 * So this file holds IDENTIFIERS and OUR OWN commercial metadata:
 *
 *   • which plan keys exist, and whether each is currently offered
 *   • which Shopify plan handle each key corresponds to
 *   • which GOTCHA entitlements a plan funds
 *   • whether a plan is public, or private to named stores
 *   • the ordering that makes "upgrade" and "downgrade" meaningful
 *
 * Everything monetary is read back from Shopify at verification time and
 * stored on `ProviderSubscription` as observed fact.
 *
 * WHY IT IS CONFIGURATION, NOT CODE
 * ---------------------------------
 * The final commercial shape is undecided: likely one connector subscription,
 * possibly three tiers, possibly a private arrangement for a specific store.
 * Hard-coding today's guess would mean a deploy for every commercial change,
 * and a code review for a decision that is not an engineering decision.
 *
 * The catalog is therefore read from `SHOPIFY_BILLING_PLAN_CATALOG` (JSON), and
 * the three keys below are PLACEHOLDERS - names reserved so the shape can be
 * tested, not a commitment that three plans will launch. With no configuration
 * at all the catalog is EMPTY, which is the correct fail-closed state: no plan
 * to sell means no plan selection, which means BILLING_PENDING rather than an
 * accidental charge against a plan nobody defined.
 *
 * SINGLE PLAN IS THE EXPECTED CASE
 * --------------------------------
 * `soleAvailablePlan()` exists so the whole flow works without a picker. If one
 * plan is available to a store, the merchant is sent straight to it. No caller
 * should assume a list longer than one, and none of the UI built on this does.
 */

/**
 * Deliberately imports NOTHING from `./config`.
 *
 * `config.ts` validates this catalog at boot, so a dependency in this direction
 * would close a cycle. Re-reading the one variable it needs is cheaper than the
 * cycle, and keeps the literal `process.env.SHOPIFY_BILLING_PLAN_HANDLES` where
 * `env-wiring.test.ts` can still see it.
 */
function legacyPlanHandles(): Record<string, string> {
  const raw = process.env.SHOPIFY_BILLING_PLAN_HANDLES;
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Reserved placeholder keys.
 *
 * Listed so tests, docs and the Partner Dashboard runbook can refer to
 * something stable before the commercial decision lands. Being listed here
 * does NOT make a plan available - availability requires configuration.
 */
export const PLACEHOLDER_PLAN_KEYS = [
  "SHOPIFY_CONNECTOR",
  "SHOPIFY_AI_COMMERCE",
  "SHOPIFY_SCALE",
] as const;

/**
 * The product a plan pays for.
 *
 * Distinct from the plan key because monthly and annual variants of one
 * commercial product are two Shopify plans but ONE thing the merchant is
 * buying. `ProviderSubscription` is unique per `productKey`, so this is what
 * stops a merchant holding the monthly and the annual plan simultaneously.
 */
export const SHOPIFY_CONNECTOR_PRODUCT = "shopify_connector";

export type ShopifyPlanVisibility = "public" | "private";
export type ShopifyPlanInterval = "monthly" | "annual" | "unknown";

export interface ShopifyPlanDefinition {
  /** Stable internal key. Appears in audit rows and support conversations. */
  key: string;
  /** What this plan funds. Two intervals of one product share it. */
  productKey: string;
  /**
   * The Shopify-side handle. Null means "declared but not wired up yet", which
   * keeps a plan visible in the catalog for review while being unsellable.
   */
  handle: string | null;
  visibility: ShopifyPlanVisibility;
  /** False takes a plan out of circulation without deleting its history. */
  enabled: boolean;
  /**
   * A HINT, for ordering and for labelling only.
   *
   * Never used to compute money or a renewal date - Shopify's observed
   * `currentPeriodEnd` is the only thing allowed to do that. A plan whose
   * configured interval disagreed with Shopify would be a config bug, and the
   * consequence is a wrong label rather than a wrong charge.
   */
  interval: ShopifyPlanInterval;
  /**
   * Upgrade/downgrade ordering. Higher outranks lower; equal ranks are a
   * lateral move (typically monthly <-> annual of the same product).
   */
  rank: number;
  /** GOTCHA entitlement keys this plan funds while it is ACTIVE or TRIALING. */
  entitlements: string[];
  /**
   * Shop domains this plan is offered to. Empty means "everyone".
   *
   * This is how a private plan and a store-specific commercial arrangement are
   * expressed. It is an OFFER filter, never an authorization: a merchant who
   * somehow approved a plan not offered to them still gets exactly the
   * entitlements that plan funds, because Shopify - not this list - decided
   * what they paid for.
   */
  restrictedToShops: string[];
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asString(x)).filter((x): x is string => !!x);
}

function normalizeShop(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.myshopify\.com$/i, "");
}

function asInterval(v: unknown): ShopifyPlanInterval {
  const raw = String(v ?? "").toLowerCase().trim();
  if (raw === "monthly" || raw === "month" || raw === "every_30_days") return "monthly";
  if (raw === "annual" || raw === "yearly" || raw === "annually") return "annual";
  return "unknown";
}

/**
 * Parse one catalog entry, or null if it is not usable.
 *
 * Returns null rather than throwing so ONE malformed entry cannot take the
 * whole catalog - and therefore the whole billing path - down. The boot-time
 * assertion is where malformed configuration is made loud; here, a bad entry
 * is simply not offered, which is the fail-closed direction.
 */
function parseEntry(raw: unknown): ShopifyPlanDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const key = asString(o.key);
  if (!key) return null;

  const visibility: ShopifyPlanVisibility = o.visibility === "private" ? "private" : "public";
  const restrictedToShops = asStringArray(o.restrictedToShops).map(normalizeShop);

  return {
    key,
    productKey: asString(o.productKey) ?? SHOPIFY_CONNECTOR_PRODUCT,
    handle: asString(o.handle),
    visibility,
    // Absent `enabled` means enabled. An operator who lists a plan means to
    // offer it; the explicit `false` is how one is retired.
    enabled: o.enabled === undefined ? true : o.enabled === true,
    interval: asInterval(o.interval),
    rank: typeof o.rank === "number" && Number.isFinite(o.rank) ? o.rank : 0,
    entitlements: asStringArray(o.entitlements),
    restrictedToShops,
  };
}

/**
 * The configured catalog.
 *
 * `SHOPIFY_BILLING_PLAN_CATALOG` is the full form. `SHOPIFY_BILLING_PLAN_HANDLES`
 * (productKey -> handle) is still honoured as the minimal form, so a deployment
 * that only needs one connector plan can configure one flat map and never learn
 * this file exists.
 */
export function shopifyPlanCatalog(): ShopifyPlanDefinition[] {
  const rawCatalog = process.env.SHOPIFY_BILLING_PLAN_CATALOG;
  if (rawCatalog && rawCatalog.trim()) {
    try {
      const parsed = JSON.parse(rawCatalog);
      const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.plans) ? (parsed as any).plans : null;
      if (list) {
        const out: ShopifyPlanDefinition[] = [];
        const seen = new Set<string>();
        for (const entry of list) {
          const plan = parseEntry(entry);
          // First definition of a key wins. A duplicate is a config mistake and
          // silently taking the last one would make the effective plan depend
          // on array order, which is invisible in review.
          if (plan && !seen.has(plan.key)) {
            seen.add(plan.key);
            out.push(plan);
          }
        }
        return out;
      }
    } catch {
      // Same reasoning as config.ts: the boot assertion is where this becomes
      // an error. Returning empty here keeps a malformed catalog non-charging.
      return [];
    }
  }

  // Minimal form. One plan per configured handle, public, no entitlement
  // mapping - which means it funds nothing until somebody says what it funds.
  // That is deliberate: a plan that silently granted everything would make the
  // entitlement mapping optional, and it is the entire point.
  const handles = legacyPlanHandles();
  return Object.entries(handles).map(([productKey, handle], i) => ({
    key: productKey.toUpperCase(),
    productKey,
    handle,
    visibility: "public" as const,
    enabled: true,
    interval: "unknown" as const,
    rank: i,
    entitlements: [],
    restrictedToShops: [],
  }));
}

/** Every plan that could be sold to somebody, ignoring who is asking. */
export function sellablePlans(): ShopifyPlanDefinition[] {
  return shopifyPlanCatalog().filter((p) => p.enabled && !!p.handle);
}

/**
 * The plans one store may actually be offered.
 *
 * A private plan is offered only to the stores that name it. A public plan is
 * offered to everyone. Disabled plans and plans with no handle are offered to
 * nobody, because there is nothing to send the merchant to.
 */
export function plansAvailableToShop(shopDomain: string | null | undefined): ShopifyPlanDefinition[] {
  const shop = shopDomain ? normalizeShop(shopDomain) : null;
  return sellablePlans().filter((p) => {
    if (p.restrictedToShops.length > 0) {
      return !!shop && p.restrictedToShops.includes(shop);
    }
    return p.visibility === "public";
  });
}

/**
 * The one plan to send this store to, or null when that is ambiguous.
 *
 * Null means either nothing is available (nothing to sell) or several are
 * (a choice we are not entitled to make on the merchant's behalf). Both cases
 * fall back to Shopify's own plan-selection page, which is the surface that is
 * allowed to present a choice.
 */
export function soleAvailablePlan(shopDomain: string | null | undefined): ShopifyPlanDefinition | null {
  const available = plansAvailableToShop(shopDomain);
  return available.length === 1 ? available[0] : null;
}

export function findPlanByKey(key: string | null | undefined): ShopifyPlanDefinition | null {
  if (!key) return null;
  return shopifyPlanCatalog().find((p) => p.key === key) ?? null;
}

/**
 * Resolve the plan a Shopify subscription corresponds to.
 *
 * Matches on handle first because that is what Shopify tells us, and falls back
 * to the plan NAME only when no handle matched. Shopify's `name` on an
 * `AppSubscription` is merchant-facing text that can be edited in the Partner
 * Dashboard, so it is a hint of last resort rather than an identifier.
 */
export function findPlanForSubscription(input: {
  handle?: string | null;
  name?: string | null;
}): ShopifyPlanDefinition | null {
  const catalog = shopifyPlanCatalog();
  const handle = input.handle?.trim();
  if (handle) {
    const byHandle = catalog.find((p) => p.handle && p.handle === handle);
    if (byHandle) return byHandle;
  }
  const name = input.name?.trim();
  if (name) {
    const byName = catalog.find((p) => p.key === name || p.handle === name);
    if (byName) return byName;
  }
  return null;
}

export type PlanChangeDirection = "upgrade" | "downgrade" | "lateral" | "unknown";

/**
 * Which direction a plan change went.
 *
 * Recorded rather than acted on. Shopify has already applied the change and
 * handled any proration by the time we see it; classifying it is for the audit
 * trail, for support, and for deciding whether entitlements widen or narrow.
 */
export function classifyPlanChange(
  from: string | null | undefined,
  to: string | null | undefined,
): PlanChangeDirection {
  const a = findPlanByKey(from);
  const b = findPlanByKey(to);
  if (!a || !b) return "unknown";
  if (a.key === b.key) return "lateral";
  if (b.rank > a.rank) return "upgrade";
  if (b.rank < a.rank) return "downgrade";
  return "lateral";
}

/**
 * The entitlements a plan funds.
 *
 * An unknown plan funds NOTHING. A merchant on a plan we cannot identify has
 * genuinely paid Shopify for something, but we do not know what, and inventing
 * a grant would hand out capability on the strength of a guess. The verified
 * subscription is still recorded, so this surfaces as a plan needing mapping
 * rather than as a silent denial.
 */
export function planEntitlements(planKey: string | null | undefined): string[] {
  return findPlanByKey(planKey)?.entitlements ?? [];
}

/** Config problems worth refusing to boot over. Empty means usable. */
export function validatePlanCatalog(): string[] {
  const raw = process.env.SHOPIFY_BILLING_PLAN_CATALOG;
  if (!raw || !raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ["SHOPIFY_BILLING_PLAN_CATALOG is not valid JSON."];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.plans)
      ? (parsed as any).plans
      : null;
  if (!list) {
    return ['SHOPIFY_BILLING_PLAN_CATALOG must be a JSON array, or an object with a "plans" array.'];
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  const handles = new Map<string, string>();

  for (const [i, entry] of list.entries()) {
    const plan = parseEntry(entry);
    if (!plan) {
      problems.push(`SHOPIFY_BILLING_PLAN_CATALOG[${i}] is not a usable plan (a string "key" is required).`);
      continue;
    }
    if (seen.has(plan.key)) {
      problems.push(`SHOPIFY_BILLING_PLAN_CATALOG contains duplicate plan key "${plan.key}".`);
    }
    seen.add(plan.key);

    // Two keys pointing at one Shopify handle would make the observed
    // subscription ambiguous: verification could not tell which plan - and so
    // which entitlements - the merchant actually bought.
    if (plan.handle) {
      const prior = handles.get(plan.handle);
      if (prior) {
        problems.push(
          `SHOPIFY_BILLING_PLAN_CATALOG maps handle "${plan.handle}" to both "${prior}" and "${plan.key}". ` +
            `A handle must identify exactly one plan.`,
        );
      }
      handles.set(plan.handle, plan.key);
    }

    if (plan.visibility === "private" && plan.restrictedToShops.length === 0) {
      problems.push(
        `SHOPIFY_BILLING_PLAN_CATALOG plan "${plan.key}" is private but lists no shops, so it can never be offered.`,
      );
    }
  }

  return problems;
}
