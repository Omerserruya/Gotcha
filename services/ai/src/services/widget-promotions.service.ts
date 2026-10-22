/**
 * The website widget's promotions (W9 phase d, 2026-10-14).
 *
 * Only the WooCommerce coupons the merchant chose in the widget's settings
 * are ever shown, and only while they are live: each request reads them from
 * the store (cached a few minutes) and drops a coupon that is not published,
 * has expired or is used up. Nothing shows without a choice.
 *
 * The same list is the one exception to "no coupons in customer
 * conversations": the AI employee may mention exactly these codes.
 */
import crypto from "crypto";
import { getRedis } from "@chatcenter/shared";
import { executeAdapterTool } from "./connectors/integration-framework";

export const PROMOTIONS_CACHE_SECONDS = 300;

export interface WidgetPromotion {
  id: string;
  code: string;
  amount: string;
  discountType: string;
  expiresAt: string | null;
  minimumAmount: string | null;
  /** The coupon grants free shipping (its amount may be 0). */
  freeShipping: boolean;
}

export interface StoreCoupon extends WidgetPromotion {
  status: string;
  usageCount: number;
  usageLimit: number | null;
  /**
   * A coupon that belongs to someone, never a public deal (2026-10-14: a
   * customer's ₪549 store credit, "credit575", was listed as publishable):
   * restricted to emails, or a single-use code (usage_limit 1: one
   * redemption in total, a credit or a personal code). A once-per-customer
   * limit (usage_limit_per_user) is NOT personal: everyone may use it once.
   */
  personal: boolean;
  /** Would show on the widget right now: published, not expired, not used up, not personal. */
  live: boolean;
}

function toCoupon(c: any, now: number): StoreCoupon | null {
  if (!c || c.id == null || typeof c.code !== "string") return null;
  const expires = typeof c.date_expires_gmt === "string" && c.date_expires_gmt ? `${c.date_expires_gmt}Z` : null;
  const expired = !!expires && Date.parse(expires) < now;
  const usageCount = Number(c.usage_count ?? 0) || 0;
  const usageLimit = c.usage_limit == null ? null : Number(c.usage_limit);
  const usedUp = usageLimit != null && usageCount >= usageLimit;
  const status = String(c.status ?? "publish");
  const restricted = Array.isArray(c.email_restrictions) ? c.email_restrictions.length > 0 : c.email_restricted === true;
  const personal = restricted || usageLimit === 1;
  return {
    id: String(c.id),
    code: c.code,
    amount: String(c.amount ?? ""),
    discountType: String(c.discount_type ?? ""),
    expiresAt: expires ? new Date(expires).toISOString() : null,
    minimumAmount: c.minimum_amount && Number(c.minimum_amount) > 0 ? String(c.minimum_amount) : null,
    freeShipping: c.free_shipping === true,
    status,
    usageCount,
    usageLimit,
    personal,
    live: status === "publish" && !expired && !usedUp && !personal,
  };
}

const publicOf = (c: StoreCoupon): WidgetPromotion => ({
  id: c.id, code: c.code, amount: c.amount, discountType: c.discountType, expiresAt: c.expiresAt, minimumAmount: c.minimumAmount, freeShipping: c.freeShipping,
});

/** The chosen coupons that are live right now, in the merchant's order. Empty on any failure. */
export async function listActivePromotions(tenantId: string, couponIds: string[], now = Date.now()): Promise<WidgetPromotion[]> {
  const ids = couponIds.filter((v) => /^\d{1,12}$/.test(v));
  if (!ids.length) return [];
  const key = `wpromo:v1:${tenantId}:${crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 32)}`;
  const redis = getRedis();
  // The store's own fields are cached, and judged on every read: a coupon
  // that expired since it was cached is dropped.
  let raw: any[] | null = null;
  const hit = await redis.get(key).catch(() => null);
  if (hit) {
    try { const v = JSON.parse(hit); raw = Array.isArray(v) ? v : null; } catch { raw = null; }
  }
  if (!raw) {
    const got = await executeAdapterTool({ tenantId, toolFunctionName: "woocommerce.list_coupons", args: { ids, per_page: ids.length }, accessScope: "internal" });
    if (!got.ok || !Array.isArray(got.result)) return [];
    raw = (got.result as any[]).map((c) => ({
      id: c?.id, code: c?.code, amount: c?.amount, discount_type: c?.discount_type, date_expires_gmt: c?.date_expires_gmt,
      minimum_amount: c?.minimum_amount, status: c?.status, usage_count: c?.usage_count, usage_limit: c?.usage_limit,
      free_shipping: c?.free_shipping === true,
      // Whether it is restricted, never to whom: the addresses are not cached.
      email_restricted: Array.isArray(c?.email_restrictions) && c.email_restrictions.length > 0,
    }));
    await redis.set(key, JSON.stringify(raw), "EX", PROMOTIONS_CACHE_SECONDS).catch(() => undefined);
  }
  const byId = new Map(raw.map((c) => toCoupon(c, now)).filter((c): c is StoreCoupon => !!c).map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id)).filter((c): c is StoreCoupon => !!c && c.live).map(publicOf);
}

/** The store's coupons, for the settings picker (one page of up to 100). Null when the store cannot be read. */
export async function storeCoupons(tenantId: string, page = 1, now = Date.now()): Promise<StoreCoupon[] | null> {
  const got = await executeAdapterTool({ tenantId, toolFunctionName: "woocommerce.list_coupons", args: { per_page: 100, page }, accessScope: "internal" });
  if (!got.ok || !Array.isArray(got.result)) return null;
  return (got.result as any[]).map((c) => toCoupon(c, now)).filter((c): c is StoreCoupon => !!c);
}

/**
 * The ids among `couponIds` that are personal (see StoreCoupon.personal), or
 * null when the store cannot be read: a coupon cannot be chosen for the
 * widget without knowing it is not someone's.
 */
export async function personalCouponIds(tenantId: string, couponIds: string[], now = Date.now()): Promise<string[] | null> {
  const ids = couponIds.filter((v) => /^\d{1,12}$/.test(v));
  if (!ids.length) return [];
  const got = await executeAdapterTool({ tenantId, toolFunctionName: "woocommerce.list_coupons", args: { ids, per_page: ids.length }, accessScope: "internal" });
  if (!got.ok || !Array.isArray(got.result)) return null;
  return (got.result as any[]).map((c) => toCoupon(c, now)).filter((c): c is StoreCoupon => !!c && c.personal).map((c) => c.id);
}
