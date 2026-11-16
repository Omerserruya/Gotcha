/**
 * Catalogue search by meaning (2026-11-16, Omer: "improve store search in general").
 *
 * The store's own search matches words in titles. It misses what a person
 * means: "מתנה לאמא" (no title says gift), "משהו חם לחורף" (titles say
 * "Wool Coat"), a Hebrew ask on an English catalogue, a synonym, a typo. Each
 * of those got its own patch in the Woo adapter; this is the general answer.
 *
 * Each product becomes one short text (title, categories, tags, options,
 * the start of its description) and one embedding, cached per store and
 * re-embedded only when that text changes. A query is embedded once and
 * ranked by cosine similarity. The embedding model is multilingual, so a
 * Hebrew ask finds English titles with no translation call.
 *
 * Used as the FALLBACK when the store's own search (and its retries) found
 * nothing: it never reorders a search that worked. Results are marked
 * matched_in: "related", so the model offers them as close options and never
 * as the exact item asked for.
 *
 * Size: catalogues up to MAX_PRODUCTS (the adapter's whole-catalogue read).
 * Bigger catalogues skip this path rather than embed thousands of products
 * inside a customer's turn.
 */
import { createHash } from "crypto";
import { generateEmbeddings } from "./ai.service";

export const MAX_PRODUCTS = 300;
const TTL_MS = 6 * 60 * 60_000;
const BATCH = 100;
/** Absolute floor and distance from the best hit (text-embedding-3-small cosine). */
const MIN_SCORE = Number(process.env.CATALOG_SEMANTIC_MIN_SCORE || 0.3);
const BAND = Number(process.env.CATALOG_SEMANTIC_BAND || 0.08);

interface Entry { hash: string; vec: Float32Array }
interface StoreIndex { at: number; byId: Map<string, Entry> }

const stores = new Map<string, StoreIndex>();
const queries = new Map<string, Float32Array>();

const strip = (html: unknown, max: number): string =>
  String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, max);

const names = (l: unknown): string[] =>
  (Array.isArray(l) ? l : []).map((x: any) => (typeof x === "string" ? x : x?.name ?? x?.title ?? x?.value ?? "")).filter(Boolean);

/** One product as the text its embedding is made of. Woo and Shopify shapes both. */
export function productDoc(p: any): string {
  const title = p?.name ?? p?.title ?? "";
  const cats = names(p?.categories).concat(p?.product_type ? [p.product_type] : []);
  const tags = names(p?.tags).concat(typeof p?.tags === "string" ? p.tags.split(",") : []);
  const opts: string[] = [];
  for (const a of Array.isArray(p?.attributes) ? p.attributes : []) opts.push(`${a?.name ?? ""}: ${names(a?.options).join(", ")}`);
  for (const o of Array.isArray(p?.options) ? p.options : []) if (Array.isArray(o?.values)) opts.push(`${o?.name ?? ""}: ${names(o.values).join(", ")}`);
  const variantValues = new Set<string>();
  for (const v of Array.isArray(p?.variants) ? p.variants : []) for (const k of ["option1", "option2", "option3"]) if (v?.[k]) variantValues.add(String(v[k]));
  if (variantValues.size) opts.push([...variantValues].slice(0, 30).join(", "));
  const desc = strip(p?.short_description || p?.description || p?.body_html || p?.descriptionHtml, 300);
  return [title, cats.join(", "), tags.join(", "), opts.join("; "), desc].filter((x) => x && String(x).trim()).join(" | ").slice(0, 900);
}

const idOf = (p: any): string => String(p?.id ?? p?.admin_graphql_api_id ?? p?.handle ?? "");
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

type Embed = (tenantId: string, inputs: string[]) => Promise<number[][]>;
const defaultEmbed: Embed = (tenantId, inputs) => generateEmbeddings({ tenantId, inputs, feature: "catalog_semantic" });

/** Bring the store's index up to date with these products; embeds only new or changed ones. */
async function indexFor(tenantId: string, storeKey: string, products: any[], embed: Embed): Promise<StoreIndex> {
  let idx = stores.get(storeKey);
  if (!idx || Date.now() - idx.at > TTL_MS) { idx = { at: Date.now(), byId: new Map() }; stores.set(storeKey, idx); }
  const todo: Array<{ id: string; hash: string; doc: string }> = [];
  for (const p of products) {
    const id = idOf(p);
    if (!id) continue;
    const doc = productDoc(p);
    const hash = sha(doc);
    if (idx.byId.get(id)?.hash !== hash) todo.push({ id, hash, doc });
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    const vecs = await embed(tenantId, part.map((x) => x.doc));
    part.forEach((x, k) => { if (vecs[k]) idx!.byId.set(x.id, { hash: x.hash, vec: Float32Array.from(vecs[k]) }); });
  }
  if (todo.length) console.log(`[catalog-semantic] store=${storeKey.slice(0, 60)} embedded=${todo.length} indexed=${idx.byId.size}`);
  return idx;
}

async function queryVec(tenantId: string, q: string, embed: Embed): Promise<Float32Array | null> {
  const key = q.trim().toLowerCase();
  const hit = queries.get(key);
  if (hit) return hit;
  const [v] = await embed(tenantId, [q]);
  if (!v) return null;
  const f = Float32Array.from(v);
  if (queries.size > 2000) queries.clear();
  queries.set(key, f);
  return f;
}

export interface SemanticOpts {
  tenantId: string;
  /** One index per store: the store URL or shop domain. */
  storeKey: string;
  products: any[];
  query: string;
  limit?: number;
  /** Test seam. */
  embed?: Embed;
}

/**
 * The products closest in meaning to the query, best first, each with its
 * score. Empty when the catalogue is too big, the query is empty, or nothing
 * clears the floor. Never throws: a failure is an empty result.
 */
export async function semanticProductSearch(opts: SemanticOpts): Promise<Array<{ product: any; score: number }>> {
  const q = String(opts.query ?? "").trim();
  if (!q || !opts.products.length || opts.products.length > MAX_PRODUCTS) return [];
  const embed = opts.embed ?? defaultEmbed;
  try {
    const [idx, qv] = await Promise.all([indexFor(opts.tenantId, opts.storeKey, opts.products, embed), queryVec(opts.tenantId, q, embed)]);
    if (!qv) return [];
    const scored = opts.products
      .map((p) => ({ product: p, e: idx.byId.get(idOf(p)) }))
      .filter((x): x is { product: any; e: Entry } => !!x.e)
      .map((x) => ({ product: x.product, score: cosine(qv, x.e.vec) }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0]?.score ?? 0;
    if (top < MIN_SCORE) return [];
    return scored.filter((x) => x.score >= MIN_SCORE && x.score >= top - BAND).slice(0, Math.max(1, opts.limit ?? 5));
  } catch (err: any) {
    console.warn(`[catalog-semantic] failed, plain search result kept: ${err?.message ?? err}`);
    return [];
  }
}

/** Test seam: forget every cached index and query vector. */
export function _resetCatalogSemanticCache(): void { stores.clear(); queries.clear(); }
