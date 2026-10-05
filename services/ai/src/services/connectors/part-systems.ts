/**
 * Which system serves each part of a business - ONE read, for the AI.
 *
 * Screen 14 lets a merchant say "for returns, use ReturnGo". That is only worth
 * anything if the AI resolves systems through the same answer, so this is the
 * read the decision path uses.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IT IS A FACADE OVER THE ELECTORS THAT ALREADY EXIST, NOT A NEW ONE
 *
 * Two parts already had an elector before this screen, each with storage the AI
 * ALREADY reads. Adding a second switch for either would be two sources for one
 * decision - the shape that produces a merchant's setting being ignored because
 * the code reads the other one:
 *
 *   crm      `config.useAsCrm` + `resolveCrmVendor`, with documented
 *            absent-means-default precedence (crm-adapter-resolver.ts:146-191).
 *   returns  `config.returnProvider` + `getReturnProvider`, whose own header
 *            says "explicit selection wins over inference" and which reports
 *            CAPABILITIES rather than connections - "ReturnGO is connected" is
 *            true and useless next to "ReturnGO cannot create a return".
 *
 * So electing those parts writes THE FIELD THEIR CONSUMER ALREADY READS, and
 * this module delegates rather than deciding. `config.roles` carries only the
 * parts that had no elector: `ecommerce` and `payments`.
 *
 * ★ THAT IS THE WHOLE DESIGN. A part's storage is wherever its consumer already
 * looks. Anything else is a screen that saves to a field nothing reads, which is
 * exactly the defect this work started from.
 *
 * ── An unmapped part is UNMAPPED ──
 *
 * It never falls through to "whatever integration happens to be connected".
 * Guessing is the behaviour the screen exists to replace, and a caller that gets
 * `slug: null` with a reason can say so; a caller handed a guess cannot tell it
 * from a choice. Same distinction as `available: false` versus an empty array,
 * one level deeper - at decision time rather than display time.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@chatcenter/shared";
import { BUSINESS_ROLES, type BusinessRole, roleAvailability } from "./business-roles";
import { resolveCrmVendor } from "./crm-adapter-resolver";
import { getReturnProvider } from "../return-provider.service";

/** The CRM resolver answers with a vendor; the catalogue and the screen use slugs. */
const CRM_VENDOR_TO_SLUG: Record<string, string> = { zoho: "zoho_crm" };

/** Parts whose election lives on `config.roles`, because nothing else elects them. */
export const ROLES_BACKED_PARTS: readonly BusinessRole[] = ["ecommerce", "payments"];

export type PartSource =
  /** The merchant chose this system for this part. */
  | "elected"
  /** No choice stored; an existing resolver inferred it from capabilities. */
  | "inferred"
  /** Nobody chose and nothing can be inferred. The caller must NOT guess. */
  | "unmapped"
  /** No integration in the catalogue can serve this part at all. */
  | "unavailable";

export interface PartSystem {
  part: BusinessRole;
  /** The integration slug serving this part, or null when there is none. */
  slug: string | null;
  source: PartSource;
  /** Why, in a sentence a screen or a prompt can use. */
  reason: string;
}

/** Elections stored on `config.roles`, read once per tenant. */
async function rolesBackedElection(tenantId: string, part: BusinessRole): Promise<string | null> {
  const rows = await prisma.tenantIntegration.findMany({
    where: { tenantId, status: "CONNECTED" },
    select: { config: true, integration: { select: { slug: true } } },
  });
  for (const row of rows) {
    const cfg = (row.config && typeof row.config === "object" ? row.config : {}) as Record<string, unknown>;
    const roles = Array.isArray(cfg.roles) ? (cfg.roles as unknown[]) : [];
    if (roles.includes(part)) return row.integration.slug;
  }
  return null;
}

/**
 * Status and config of every row a tenant has for these slugs, one query.
 *
 * Needed because the two delegated resolvers load ERROR rows on purpose (an
 * expired OAuth token recovers on first use, and excluding ERROR deadlocked
 * it), so their answer alone cannot say whether the system works right now.
 */
async function rowsBySlug(
  tenantId: string,
  slugs: string[],
): Promise<Map<string, { status: string; config: Record<string, unknown> }>> {
  const rows = await prisma.tenantIntegration.findMany({
    where: { tenantId, integration: { slug: { in: slugs } } },
    select: { status: true, config: true, integration: { select: { slug: true } } },
  });
  const out = new Map<string, { status: string; config: Record<string, unknown> }>();
  for (const r of rows) {
    const prev = out.get(r.integration.slug);
    // A CONNECTED row wins over any other row for the same slug, matching the
    // resolvers' own `orderBy status asc` preference.
    if (prev && prev.status === "CONNECTED") continue;
    out.set(r.integration.slug, {
      status: String(r.status),
      config: (r.config && typeof r.config === "object" ? r.config : {}) as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * ★ AN INFERENCE MAY ONLY LAND ON A WORKING SYSTEM.
 *
 * Returns showed `shopify, inferred` while Shopify sat in ERROR: the screen
 * named a system nobody chose AND that cannot act, as if it served the part.
 * A merchant's explicit choice is different - it stays, and the screen says
 * "chosen, not working". Only the guess is withdrawn.
 */
function unmappedInference(part: BusinessRole, slug: string, status: string | undefined): PartSystem {
  return {
    part,
    slug: null,
    source: "unmapped",
    reason: `Nothing has been chosen for ${part}. ${slug} would be inferred, but ${status ? `its connection status is ${status}` : "it is not connected"}, so it does not serve this part.`,
  };
}

/**
 * The system serving one part, as the AI should see it.
 *
 * Never throws: a resolution failure must degrade to `unmapped`, which a caller
 * handles, rather than taking down a reply.
 */
export async function getSystemForPart(tenantId: string, part: BusinessRole): Promise<PartSystem> {
  const availability = roleAvailability(part);
  if (!availability.available) {
    return { part, slug: null, source: "unavailable", reason: availability.detail };
  }

  try {
    if (part === "crm") {
      // Delegated entirely. The CRM resolver owns absent-means-default and is
      // what every existing caller already uses, so this must not second-guess it.
      const vendor = await resolveCrmVendor(tenantId);
      if (!vendor) {
        return { part, slug: null, source: "unmapped", reason: "No customer system of record is configured." };
      }
      const slug = CRM_VENDOR_TO_SLUG[vendor] ?? vendor;
      const row = (await rowsBySlug(tenantId, [slug])).get(slug);
      // `useAsCrm: true` is the merchant's switch (PUT /:slug/crm-source). The
      // resolver ALSO answers without it - first connected CRM, then Shopify by
      // default - and that answer is a resolver's pick, not a choice.
      if (row?.config.useAsCrm === true) {
        return { part, slug, source: "elected", reason: `${slug} is the elected customer system of record.` };
      }
      if (row?.status !== "CONNECTED") return unmappedInference(part, slug, row?.status);
      return { part, slug, source: "inferred", reason: `${slug} is used as the customer system of record by default; nobody chose it.` };
    }

    if (part === "returns") {
      // Delegated. `getReturnProvider` reports CAPABILITIES, and its distinction
      // between an explicit choice and a capability-first inference is exactly
      // the distinction this function exists to preserve.
      const caps = await getReturnProvider(tenantId);
      if (caps.provider === "none") {
        return { part, slug: null, source: "unmapped", reason: caps.reason };
      }
      // "Elected" means the merchant's switch, `config.returnProvider`, names
      // this provider. This used to be read off the resolver's PROSE (does the
      // reason contain "explicit"?), and the resolver never writes that word
      // for a working choice - it returns the provider's own reason - so a real
      // choice was always labelled "inferred". Read the switch itself.
      const rows = await rowsBySlug(tenantId, ["shopify", "returngo"]);
      const explicit = [...rows.values()]
        .map((r) => String(r.config.returnProvider ?? "").toLowerCase().trim())
        .find((v) => v === "shopify" || v === "returngo");
      if (explicit === caps.provider) {
        return { part, slug: caps.provider, source: "elected", reason: caps.reason };
      }
      const row = rows.get(caps.provider);
      if (row?.status !== "CONNECTED") return unmappedInference(part, caps.provider, row?.status);
      return { part, slug: caps.provider, source: "inferred", reason: caps.reason };
    }

    const elected = await rolesBackedElection(tenantId, part);
    return elected
      ? { part, slug: elected, source: "elected", reason: `${elected} was chosen for ${part}.` }
      : {
          part,
          slug: null,
          source: "unmapped",
          // Deliberately not "we will use whatever is connected". That guess is
          // the behaviour screen 14 exists to replace.
          reason: `No system has been chosen for ${part}.`,
        };
  } catch (err: any) {
    console.error(`[part-systems] could not resolve ${part} for ${tenantId}:`, err?.message ?? err);
    return { part, slug: null, source: "unmapped", reason: `Could not read the system for ${part}.` };
  }
}

/** Every part at once, for a prompt block or a settings screen. */
export async function getBusinessCoreMap(tenantId: string): Promise<PartSystem[]> {
  return Promise.all(BUSINESS_ROLES.map((part) => getSystemForPart(tenantId, part)));
}

/**
 * The mapping as the model should read it.
 *
 * ★ UNMAPPED PARTS ARE STATED, not omitted. A prompt that lists only the mapped
 * parts lets the model assume the rest are its choice, which is the guess this
 * whole mechanism removes. Saying "no system chosen" is what makes the model ask
 * or decline instead of picking.
 *
 * Returns an empty string when nothing is known at all, so a caller appends
 * nothing rather than an empty heading.
 */
export function renderBusinessCoreBlock(map: PartSystem[]): string {
  const meaningful = map.filter((m) => m.source !== "unavailable");
  if (meaningful.length === 0) return "";
  const lines = meaningful.map((m) =>
    m.slug
      ? `- ${m.part}: ${m.slug}${m.source === "inferred" ? " (inferred, not chosen by the business)" : ""}`
      : `- ${m.part}: no system chosen. Do not assume one; ask or say it is not set up.`,
  );
  return ["# Which system serves each part of this business", ...lines].join("\n");
}
