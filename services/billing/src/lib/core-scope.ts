/**
 * Every GOTCHA Core billing response says whose billing it is (split billing
 * 2026-10-28): `scope: "gotcha_core"`, `billedBy: "gotcha"`. Shopify's review
 * (1.2.1, ref 132211) could not tell our plans from Shopify billing; the
 * Shopify Connector's own responses say `shopify_connector` / `shopify`.
 *
 * Only a plain JSON object gains the two keys. An array, a string or null is
 * sent as it was, and a body that already names a scope is left alone: no
 * existing field ever changes.
 */
import type { Request, Response, NextFunction } from "express";

/** The Core billing paths (mounted by prefix: every billing router shares /api). */
export const CORE_BILLING_PATHS = [
  "/api/billing/plans",
  "/api/billing/subscription",
  "/api/billing/pricing",
  "/api/billing/payment-methods",
  "/api/billing/profile",
  "/api/billing/invoices",
  "/api/billing/credits",
  "/api/billing/credit-summary",
  "/api/billing/auto-purchase",
  "/api/usage/allowance",
  // Not /api/checkout: the Core checkout (iCount card page) flow is left as it is.
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function withCoreScope<T>(body: T): T {
  if (!isPlainObject(body) || "scope" in body || "billedBy" in body) return body;
  return { ...body, scope: "gotcha_core", billedBy: "gotcha" } as T;
}

export function coreScope(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = ((body?: unknown) => json(withCoreScope(body))) as Response["json"];
  next();
}
