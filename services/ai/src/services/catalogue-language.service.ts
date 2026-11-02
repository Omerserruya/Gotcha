/**
 * The language a store writes its product titles in (2026-11-02).
 *
 * Product search matches TITLES. The search instructions assumed English
 * titles (Urban's catalogue), so a Hebrew catalogue (Tehila's) was searched for
 * "scarf" and came back empty. This samples a few titles, caches the answer
 * per tenant for a day, and is refreshed in the background: a turn never waits
 * on it, and until it is known the instruction stays neutral.
 */
import { getRedis } from "@chatcenter/shared";
import { executeAdapterTool } from "./connectors/integration-framework";

export type TitlesLanguage = "he" | "en";
const KEY = (tenantId: string) => `catalogue:titles-lang:${tenantId}`;
const TTL_S = 24 * 3600;
const HEBREW = /[֐-׿]/;

/** "he" when most sampled titles are written in Hebrew, else "en"; null for no titles. */
export function titlesLanguageOf(titles: string[]): TitlesLanguage | null {
  const named = titles.map((t) => String(t ?? "").trim()).filter(Boolean);
  if (!named.length) return null;
  const hebrew = named.filter((t) => HEBREW.test(t)).length;
  return hebrew * 2 > named.length ? "he" : "en";
}

/** The cached answer, or null. Starts a background refresh when it is missing. */
export async function cachedTitlesLanguage(tenantId: string, tool = "woocommerce.list_products"): Promise<TitlesLanguage | null> {
  let cached: string | null = null;
  try { cached = await getRedis().get(KEY(tenantId)); } catch { return null; }
  if (cached === "he" || cached === "en") return cached;
  void refreshTitlesLanguage(tenantId, tool).catch(() => {});
  return null;
}

export async function refreshTitlesLanguage(tenantId: string, tool = "woocommerce.list_products"): Promise<TitlesLanguage | null> {
  const got = await executeAdapterTool({ tenantId, toolFunctionName: tool, args: { per_page: 8 }, accessScope: "internal" }).catch(() => null);
  const rows: any[] = got?.ok ? (Array.isArray(got.result) ? got.result : Array.isArray((got.result as any)?.products) ? (got.result as any).products : []) : [];
  const lang = titlesLanguageOf(rows.map((p) => p?.name ?? p?.title));
  if (lang) await getRedis().set(KEY(tenantId), lang, "EX", TTL_S).catch(() => {});
  return lang;
}
