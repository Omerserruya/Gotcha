/**
 * Per-tenant CRMAdapter resolver.
 *
 * Replaces the global `getCrmConnector(name?)` registry pattern (which
 * fell through to a deliberately-failing stub) with explicit tenant-aware
 * resolution.
 *
 * Resolution order:
 *   1. Vendor override (e.g. when the side panel knows the user picked HubSpot).
 *   2. The tenant's primary CRM (Tenant.crmPrimaryVendor — when set; later steps).
 *   3. The first CONNECTED TenantIntegration with category=CRM.
 *   4. NoOpCRMAdapter — methods return { ok: false, reason: 'no_crm_configured' }.
 *
 * The legacy `getCrmConnector()` continues to work for callers that haven't
 * migrated; they coexist. The eventual goal is to delete it.
 */

import { prisma } from "@chatcenter/shared";
import type { CRMAdapter, CrmVendor } from "./crm-adapter.types";
import {
  HubSpotCRMAdapter,
  SalesforceCRMAdapter,
  ZohoCRMAdapter,
  ShopifyCRMAdapter,
  FireberryCRMAdapter,
  AirtableCRMAdapter,
  NoOpCRMAdapter,
} from "./crm-adapter.impl";

// IntegrationCatalog slug → CrmVendor. Note the existing catalog uses
// `zoho_crm` (matches the OAuth route at /oauth/zoho_crm/callback); HubSpot
// and Salesforce match their vendor name directly.
const SLUG_TO_VENDOR: Record<string, CrmVendor> = {
  hubspot: "hubspot",
  salesforce: "salesforce",
  zoho_crm: "zoho",
  fireberry: "fireberry",
  pipedrive: "pipedrive",
  monday: "monday",
  airtable: "airtable",
  custom_api: "custom_api",
  custom_db: "custom_db",
};
const CRM_VENDOR_SLUGS = Object.keys(SLUG_TO_VENDOR);

// Tiny per-tenant cache (TTL 30s) — avoids hitting the DB on every bot turn.
// Resolves the CrmVendor; the adapter itself is cheap to instantiate.
interface CachedResolution { vendor: CrmVendor | null; expiresAt: number; }
const RESOLUTION_CACHE = new Map<string, CachedResolution>();
const RESOLUTION_TTL_MS = 30_000;

/**
 * Test-only: clear the cache between integration tests.
 */
export function __resetCrmAdapterCache(): void { RESOLUTION_CACHE.clear(); }

/**
 * Invalidate the resolution cache. Call after a tenant changes which CRM is
 * their source of truth (e.g. flipping the Shopify "use as CRM" toggle) so
 * the next bot turn resolves the new vendor immediately instead of waiting
 * out the 30s TTL. Omit `tenantId` to clear everything.
 */
export function invalidateCrmAdapterCache(tenantId?: string): void {
  if (!tenantId) { RESOLUTION_CACHE.clear(); return; }
  RESOLUTION_CACHE.delete(tenantId);
}

/**
 * Resolve the CRMAdapter for a tenant. Vendor override skips DB lookup.
 */
export async function getCrmAdapter(tenantId: string, vendor?: CrmVendor): Promise<CRMAdapter> {
  if (!tenantId) throw new Error("getCrmAdapter: tenantId required");

  if (vendor) return instantiate(vendor, tenantId);

  const cached = RESOLUTION_CACHE.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return instantiate(cached.vendor, tenantId);
  }

  const resolved = await resolveFromDb(tenantId);
  RESOLUTION_CACHE.set(tenantId, { vendor: resolved, expiresAt: Date.now() + RESOLUTION_TTL_MS });
  return instantiate(resolved, tenantId);
}

/**
 * Synchronous variant for code paths that already have the vendor string
 * (e.g. webhook handlers that know which CRM emitted the event). Skips
 * DB + cache.
 */
export function getCrmAdapterForVendor(tenantId: string, vendor: CrmVendor): CRMAdapter {
  return instantiate(vendor, tenantId);
}

async function resolveFromDb(tenantId: string): Promise<CrmVendor | null> {
  try {
    // 1. Explicit tenant primary vendor — column is additive in a later wave;
    //    skip gracefully if absent.
    const t = await (prisma as any).tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!t) return null;

    // 1.5. Shopify-as-CRM opt-in. Shopify is an ECOMMERCE integration, but a
    //      tenant may elect it as their CRM source of truth by setting
    //      `config.useAsCrm = true` on the connected Shopify integration
    //      (Settings → toggle). When set, it WINS over any CRM-category
    //      integration — the tenant explicitly chose Shopify as the truth.
    //      When NOT set, behavior is unchanged for everyone else.
    const shop = await (prisma as any).tenantIntegration.findFirst({
      where: { tenantId, status: "CONNECTED", integration: { slug: "shopify" } },
      select: { config: true },
    });
    if (shop && (shop.config as any)?.useAsCrm === true) {
      return "shopify";
    }

    // 2. First CONNECTED TenantIntegration with a CRM slug.
    const ti = await (prisma as any).tenantIntegration.findFirst({
      where: {
        tenantId,
        status: "CONNECTED",
        integration: { slug: { in: CRM_VENDOR_SLUGS } },
      },
      orderBy: { createdAt: "asc" },
      include: { integration: true },
    });
    if (!ti) return null;
    const slug = String(ti.integration?.slug ?? "").toLowerCase();
    return SLUG_TO_VENDOR[slug] ?? null;
  } catch (err: any) {
    console.warn("[crm-adapter-resolver] resolveFromDb failed:", err?.message);
    return null;
  }
}

function instantiate(vendor: CrmVendor | null, tenantId: string): CRMAdapter {
  switch (vendor) {
    case "hubspot": return new HubSpotCRMAdapter(tenantId);
    case "salesforce": return new SalesforceCRMAdapter(tenantId);
    case "zoho": return new ZohoCRMAdapter(tenantId);
    case "shopify": return new ShopifyCRMAdapter(tenantId);
    case "fireberry": return new FireberryCRMAdapter(tenantId);
    case "airtable": return new AirtableCRMAdapter(tenantId);
    // For unimplemented vendors return NoOpCRMAdapter rather than throwing —
    // callers degrade gracefully (side panel shows "CRM not yet supported").
    case "pipedrive":
    case "monday":
    case "custom_api":
    case "custom_db":
    case null:
    default:
      return new NoOpCRMAdapter(tenantId);
  }
}
