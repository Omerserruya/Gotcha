/**
 * Per-tenant CRMAdapter resolver.
 *
 * Replaces the global `getCrmConnector(name?)` registry pattern (which
 * fell through to a deliberately-failing stub) with explicit tenant-aware
 * resolution.
 *
 * Resolution order:
 *   1. Vendor override (e.g. when the side panel knows the user picked HubSpot).
 *   2. The tenant's primary CRM (Tenant.crmPrimaryVendor - when set; later steps).
 *   3. The first CONNECTED TenantIntegration with category=CRM.
 *   4. NoOpCRMAdapter - methods return { ok: false, reason: 'no_crm_configured' }.
 *
 * The legacy `getCrmConnector()` continues to work for callers that haven't
 * migrated; they coexist. The eventual goal is to delete it.
 */

import { prisma } from "@chatcenter/shared";
import type { CRMAdapter, CrmVendor } from "./crm-adapter.types";
import { DEFAULT_CAPABILITIES } from "./crm-adapter.types";
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
/**
 * The slugs step 2 will actually resolve a tenant's CRM from.
 *
 * NOT every key of SLUG_TO_VENDOR. Four of those vendors have no adapter -
 * `instantiate()` returns NoOpCRMAdapter for pipedrive, monday, custom_api and
 * custom_db - so matching them here could only ever DISPLACE a provider that
 * works.
 *
 * That is not theoretical. `monday` is a PROJECT_MANAGEMENT integration in the
 * catalog, connected for project work and nothing to do with customer records.
 * Because step 2 matches on SLUG rather than category, a Shopify merchant who
 * also connected Monday had Monday resolved as their CRM - ahead of the
 * Shopify fallback in step 3. Every identity lookup and every timeline write
 * then went to the NoOp adapter and returned `no_crm_configured`. The bot
 * stopped knowing who it was talking to, and because a stub answers rather than
 * throws, nothing anywhere reported an error.
 *
 * Derived from the capability table rather than hand-listed, so implementing
 * one of these adapters is enough to make it resolvable - there is no second
 * list to remember.
 */
const CRM_VENDOR_SLUGS = Object.keys(SLUG_TO_VENDOR).filter(
  (slug) => !DEFAULT_CAPABILITIES[SLUG_TO_VENDOR[slug]]?.is_stub,
);

// Tiny per-tenant cache (TTL 30s) - avoids hitting the DB on every bot turn.
// Resolves the CrmVendor; the adapter itself is cheap to instantiate.
interface CachedResolution { vendor: CrmVendor | null; expiresAt: number; }
const RESOLUTION_CACHE = new Map<string, CachedResolution>();
const RESOLUTION_TTL_MS = 30_000;

/** Test-only: which slugs step 2 will resolve from, after the stub filter. */
export function __resolvableCrmSlugs(): string[] { return [...CRM_VENDOR_SLUGS]; }

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

  return instantiate(await resolveVendorCached(tenantId), tenantId);
}

/** Resolve (and cache) which CRM vendor backs a tenant, or null if none. */
async function resolveVendorCached(tenantId: string): Promise<CrmVendor | null> {
  const cached = RESOLUTION_CACHE.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.vendor;
  const resolved = await resolveFromDb(tenantId);
  RESOLUTION_CACHE.set(tenantId, { vendor: resolved, expiresAt: Date.now() + RESOLUTION_TTL_MS });
  return resolved;
}

/**
 * The tenant's resolved CRM vendor, or null if no CRM is connected. Read-only
 * accessor over the SAME resolution `getCrmAdapter` uses (the NoOp adapter reports a
 * placeholder vendor, so `getCrmAdapter().vendor` cannot answer "is a CRM connected?").
 */
export async function resolveCrmVendor(tenantId: string): Promise<CrmVendor | null> {
  if (!tenantId) return null;
  return resolveVendorCached(tenantId);
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
    // 1. Explicit tenant primary vendor - column is additive in a later wave;
    //    skip gracefully if absent.
    const t = await (prisma as any).tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!t) return null;

    // 1.5. Shopify-as-CRM. Shopify is an ECOMMERCE integration, but for a
    //      store it IS the customer source of truth. Semantics:
    //        - `config.useAsCrm === true`  → Shopify WINS over any dedicated
    //          CRM integration (the tenant explicitly chose it).
    //        - `config.useAsCrm === false` → never used as CRM (explicit opt-out).
    //        - flag ABSENT → Shopify is the DEFAULT CRM whenever no dedicated
    //          CRM-category integration is connected (step 3 below). This is
    //          deliberate: the opt-in-only model meant losing the flag (or
    //          never setting it) silently killed identity-link + timeline
    //          writeback while Shopify sat there connected as the obvious
    //          source of truth.
    //      ERROR status included for the same recoverable-expired-token
    //      reason as step 2.
    const shop = await (prisma as any).tenantIntegration.findFirst({
      where: { tenantId, status: { in: ["CONNECTED", "ERROR"] }, integration: { slug: "shopify" } },
      orderBy: { status: "asc" },
      select: { config: true },
    });
    const shopifyOptOut = (shop?.config as any)?.useAsCrm === false;
    if (shop && (shop.config as any)?.useAsCrm === true) {
      return "shopify";
    }

    // 2. First CONNECTED (or recoverable ERROR) TenantIntegration with a CRM
    //    slug. ERROR is included so an OAuth CRM whose access token merely
    //    expired still resolves to its real adapter - otherwise it returns the
    //    NoOp stub, `integration_create_lead` never surfaces, the adapter is
    //    never used, and the expired token is never refreshed (a deadlock). On
    //    first use the framework refreshes the token and recovers status to
    //    CONNECTED. `orderBy status asc` prefers a CONNECTED row over an ERROR
    //    one when a tenant has multiple CRMs. DISCONNECTED stays excluded.
    const ti = await (prisma as any).tenantIntegration.findFirst({
      where: {
        tenantId,
        status: { in: ["CONNECTED", "ERROR"] },
        integration: { slug: { in: CRM_VENDOR_SLUGS } },
      },
      orderBy: [{ status: "asc" }, { createdAt: "asc" }],
      include: { integration: true },
    });
    if (ti) {
      const slug = String(ti.integration?.slug ?? "").toLowerCase();
      const vendor = SLUG_TO_VENDOR[slug] ?? null;
      if (vendor) return vendor;
    }

    // 3. No dedicated CRM connected: a connected Shopify is the CRM source of
    //    truth by default (unless explicitly opted out with useAsCrm=false).
    if (shop && !shopifyOptOut) return "shopify";

    return null;
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
    // For unimplemented vendors return NoOpCRMAdapter rather than throwing -
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
