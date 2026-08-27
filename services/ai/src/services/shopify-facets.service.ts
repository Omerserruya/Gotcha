/**
 * What can this store actually be asked about?
 *
 * The product-recommendation flow used to carry a hardcoded list of things to
 * ask a shopper: riding style, flex, board length, boot size. Read against the
 * live Urban Supply catalogue, NONE of those exist - Shopify records no such
 * fields on any of its 15 products. The store's real dimensions are product
 * type, vendor, a handful of tags, and one option called Color. So the bot was
 * interviewing customers about attributes it could never filter on, and then
 * searching on none of them.
 *
 * This derives the dimensions from the catalogue itself, so a snowboard store,
 * a cosmetics store and a bakery each get questions they can answer and filters
 * that actually narrow. Nothing here is vertical-specific.
 *
 * Everything is READ. Nothing is inferred that Shopify does not state.
 */

import { prisma } from "@chatcenter/shared";
import type { DiscoveryProfile, FactSpec } from "@chatcenter/shared";
import { executeAdapterTool } from "./connectors/index";

/** One filterable dimension, with the values the store really uses. */
export interface CatalogOption {
  /** Shopify's own option name, verbatim: "Color", "Size", "Denominations". */
  name: string;
  /** Distinct values across the catalogue, capped. */
  values: string[];
  /** Which product types carry this option - "Denominations" is a gift card
   *  thing and must not be offered to someone buying a snowboard. */
  productTypes: string[];
}

export interface CatalogTypeFacet {
  type: string;
  count: number;
  /** Range across BUYABLE variants only. A price nobody can pay is not a price
   *  a budget question should be calibrated against. */
  priceMin: number | null;
  priceMax: number | null;
}

export interface CatalogFacets {
  productTypes: CatalogTypeFacet[];
  vendors: string[];
  tags: string[];
  options: CatalogOption[];
  currency?: string;
  /** Products actually scanned. Small stores are complete; large ones sampled. */
  scanned: number;
  fetchedAt: string;
}

/** How long a derived catalogue shape is trusted. Catalogues change slowly,
 *  and a stale COLOUR list is a far smaller problem than a read per turn. */
const TTL_MS = 12 * 60 * 60 * 1000;

/** Caps. A prompt block is not a place to paste 400 tag names. */
const MAX_OPTION_VALUES = 20;
const MAX_TAGS = 25;
const MAX_VENDORS = 15;
const SCAN_LIMIT = 250;

/**
 * Option names that carry no information.
 *
 * Shopify gives every product without real options a single option called
 * "Title" whose only value is "Default Title". Surfacing it produces the
 * question "what Title would you like?", which is worse than asking nothing.
 */
const NOISE_OPTIONS = new Set(["title"]);
const NOISE_VALUES = new Set(["default title"]);

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fold a raw product list into the store's shape.
 *
 * Exported and pure so the aggregation is testable without a store.
 */
export function deriveFacets(products: any[], currency?: string): CatalogFacets {
  const typeAgg = new Map<string, { count: number; prices: number[] }>();
  const vendors = new Map<string, number>();
  const tags = new Map<string, number>();
  const options = new Map<string, { values: Map<string, number>; types: Set<string> }>();

  for (const p of Array.isArray(products) ? products : []) {
    const variants: any[] = Array.isArray(p?.variants) ? p.variants : [];
    const buyable = variants.filter((v) => v?.available !== false);
    const prices = buyable.map((v) => num(v?.price)).filter((n): n is number => n !== null);

    const type = String(p?.product_type || "").trim();
    const typeKey = type || "(unspecified)";
    if (!typeAgg.has(typeKey)) typeAgg.set(typeKey, { count: 0, prices: [] });
    const agg = typeAgg.get(typeKey)!;
    agg.count += 1;
    agg.prices.push(...prices);

    const vendor = String(p?.vendor || "").trim();
    if (vendor) vendors.set(vendor, (vendors.get(vendor) ?? 0) + 1);

    for (const raw of Array.isArray(p?.tags) ? p.tags : String(p?.tags || "").split(",")) {
      const tag = String(raw || "").trim();
      if (tag) tags.set(tag, (tags.get(tag) ?? 0) + 1);
    }

    // Option VALUES come off the variants, because that is where a value is
    // attached to a product that really has it. The product-level option list
    // names the axis; the variants say what is on it.
    for (const opt of Array.isArray(p?.options) ? p.options : []) {
      const name = String(opt?.name || "").trim();
      if (!name || NOISE_OPTIONS.has(name.toLowerCase())) continue;
      if (!options.has(name)) options.set(name, { values: new Map(), types: new Set() });
      const entry = options.get(name)!;
      if (type) entry.types.add(type);
      for (const v of variants) {
        for (const key of ["option1", "option2", "option3"] as const) {
          const val = String(v?.[key] || "").trim();
          if (!val || NOISE_VALUES.has(val.toLowerCase())) continue;
          // Only count a value against THIS option when the product's option
          // order says so - option1 belongs to options[0], and so on.
          const idx = (p.options as any[]).findIndex((o: any) => String(o?.name || "").trim() === name);
          if (idx !== ["option1", "option2", "option3"].indexOf(key)) continue;
          entry.values.set(val, (entry.values.get(val) ?? 0) + 1);
        }
      }
    }
  }

  const byCountDesc = (a: [string, number], b: [string, number]) => b[1] - a[1];

  return {
    productTypes: [...typeAgg.entries()]
      .map(([type, a]) => ({
        type,
        count: a.count,
        priceMin: a.prices.length ? Math.min(...a.prices) : null,
        priceMax: a.prices.length ? Math.max(...a.prices) : null,
      }))
      .sort((a, b) => b.count - a.count),
    vendors: [...vendors.entries()].sort(byCountDesc).slice(0, MAX_VENDORS).map(([v]) => v),
    tags: [...tags.entries()].sort(byCountDesc).slice(0, MAX_TAGS).map(([t]) => t),
    options: [...options.entries()]
      // An option with nothing on it filters nothing.
      .filter(([, e]) => e.values.size > 0)
      .map(([name, e]) => ({
        name,
        values: [...e.values.entries()].sort(byCountDesc).slice(0, MAX_OPTION_VALUES).map(([v]) => v),
        productTypes: [...e.types],
      })),
    ...(currency ? { currency } : {}),
    scanned: Array.isArray(products) ? products.length : 0,
    fetchedAt: new Date().toISOString(),
  };
}

function isFresh(cached: any): cached is CatalogFacets {
  if (!cached || typeof cached !== "object" || !cached.fetchedAt) return false;
  const at = Date.parse(cached.fetchedAt);
  return Number.isFinite(at) && Date.now() - at < TTL_MS;
}

/**
 * The store's filterable shape, cached on the integration config.
 *
 * Returns null rather than throwing when Shopify is unreachable or not
 * connected: a bot that cannot describe the catalogue must still be able to
 * hold a conversation.
 */
export async function getCatalogFacets(tenantId: string): Promise<CatalogFacets | null> {
  try {
    const row = await (prisma as any).tenantIntegration.findFirst({
      where: { tenantId, integration: { slug: "shopify" } },
      select: { id: true, config: true },
    });
    if (!row) return null;

    const config = (row.config ?? {}) as Record<string, any>;
    if (isFresh(config.catalogFacets)) return config.catalogFacets as CatalogFacets;

    const res = await executeAdapterTool({
      tenantId,
      toolFunctionName: "shopify.search_products",
      // The whole active catalogue, unfiltered: this is describing the store,
      // not answering a shopper. in_stock_only stays OFF so a type that is
      // temporarily sold out does not vanish from the store's own description.
      args: { query: "", limit: SCAN_LIMIT, in_stock_only: false },
      accessScope: "internal",
    });
    if (!res.ok) {
      console.warn(`[facets] catalogue scan denied: ${res.reason}`);
      return isFresh(config.catalogFacets) ? (config.catalogFacets as CatalogFacets) : null;
    }

    const facets = deriveFacets(
      Array.isArray(res.result) ? res.result : [],
      typeof config.shopCurrency === "string" ? config.shopCurrency : undefined,
    );
    await (prisma as any).tenantIntegration.update({
      where: { id: row.id },
      data: { config: { ...config, catalogFacets: facets } },
    });
    console.log(
      `[facets] ${tenantId}: ${facets.scanned} products, ${facets.productTypes.length} types, ${facets.options.length} options`,
    );
    return facets;
  } catch (err: any) {
    console.warn("[facets] derive failed (non-fatal):", err?.message);
    return null;
  }
}

/**
 * The store's shape, written for the model.
 *
 * Deliberately blunt about the boundary: these are the ONLY dimensions that
 * narrow a search here, so a question about anything else cannot be acted on.
 * That is the instruction that stops an interview about board flex in a store
 * that has never recorded one.
 */
export function renderFacetsForPrompt(facets: CatalogFacets | null, locale: "he" | "en" = "en"): string | null {
  if (!facets || facets.productTypes.length === 0) return null;
  const cur = facets.currency ? `${facets.currency} ` : "";
  const lines: string[] = ["# This store's catalogue", ""];

  lines.push("Categories (with the real price range of what is buyable):");
  for (const t of facets.productTypes) {
    const range =
      t.priceMin === null
        ? "no buyable price"
        : t.priceMin === t.priceMax
          ? `${cur}${t.priceMin}`
          : `${cur}${t.priceMin} - ${cur}${t.priceMax}`;
    lines.push(`- ${t.type} (${t.count} products, ${range})`);
  }

  if (facets.options.length) {
    lines.push("", "Options a product can be filtered by:");
    for (const o of facets.options) {
      const scope = o.productTypes.length ? ` [${o.productTypes.join(", ")}]` : "";
      lines.push(`- ${o.name}${scope}: ${o.values.join(", ")}`);
    }
  }
  if (facets.tags.length) lines.push("", `Tags: ${facets.tags.join(", ")}`);
  if (facets.vendors.length) lines.push("", `Brands: ${facets.vendors.join(", ")}`);

  lines.push(
    "",
    "RULES:",
    "- These are the ONLY things this catalogue can be narrowed by. Never interview the customer about an attribute that is not listed above - you would be collecting an answer you cannot search on.",
    "- Quote budget brackets from the ranges above. Offering \"under 200\" for a category that starts at 600 wastes the customer's answer.",
    "- Pass what you learn as real arguments (price_max, product_type, vendor, tag, option_name/option_value), not as prose about what you intend to search for.",
  );
  if (locale === "he") {
    lines.push("- Ask in the customer's language; the values above are the store's own strings and must be passed to the tool verbatim.");
  }
  return lines.join("\n");
}


/* ───── Turning a store's shape into an interview ───── */

/** Does the store record anything under this name? */
function storeHasDimension(facets: CatalogFacets, key: string): boolean {
  const k = key.toLowerCase().replace(/_/g, " ");
  return facets.options.some((o) => {
    const n = o.name.toLowerCase();
    return n === k || n.replace(/_/g, " ") === k;
  });
}

/**
 * The profile, rewritten for the store in front of it.
 *
 * `PRODUCT_RECOMMENDATION_PROFILE` was written for a snowboard shop and makes
 * riding style a REQUIRED fact. Against the live catalogue that is a question
 * the store cannot act on: Shopify records no such field on any product, so the
 * answer is collected, blocks the search until it arrives, and then filters
 * nothing. A shopper is interrogated to stand still.
 *
 * Two edits, both conservative:
 *
 *  - a required fact the store has no dimension for is DEMOTED to optional,
 *    not deleted. It stops gating the search and stops being asked for, but if
 *    the customer volunteers "I'm a beginner" it is still recorded and can
 *    inform which of the real results to lead with. Deleting it would throw
 *    away something a human salesperson would obviously use.
 *  - every real option becomes a fact, so a store whose products differ by
 *    Colour gets asked about colour without anyone writing that down here.
 *
 * `product_category` and `budget` are never demoted: a category is what the
 * query searches and price is filterable in every store there is.
 */
const ALWAYS_REQUIRED = new Set(["product_category", "budget"]);

export function profileForStore(
  profile: DiscoveryProfile,
  facets: CatalogFacets | null,
): DiscoveryProfile {
  if (!facets) return profile;

  const facts: FactSpec[] = profile.facts.map((f) => {
    if (!f.required || ALWAYS_REQUIRED.has(f.key)) return f;
    if (storeHasDimension(facets, f.key)) return f;
    return { ...f, required: false };
  });

  const known = new Set(facts.map((f) => f.key.toLowerCase()));
  for (const opt of facets.options) {
    const key = opt.name.toLowerCase().replace(/\s+/g, "_");
    if (known.has(key)) continue;
    facts.push({
      key,
      type: "enum",
      // Optional on purpose. A shopper who does not care about colour should
      // not be held at a colour question before seeing a single product.
      required: false,
      enumValues: opt.values,
      description: `${opt.name} (this store's own option${opt.productTypes.length ? `, on: ${opt.productTypes.join(", ")}` : ""}).`,
    } as FactSpec);
  }

  return { ...profile, facts };
}
