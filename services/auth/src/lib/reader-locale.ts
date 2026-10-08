/**
 * Twin of services/ai/src/lib/reader-locale.ts; keep the two in step.
 *
 * The language of text this service writes for a person (labels, names,
 * statuses), in this order:
 *   1. an explicit `locale` (query, then body);
 *   2. an Accept-Language that is ONE deliberate tag ("he", "en", "he-IL"):
 *      what the v2 app sends for the page's language (frontend 1850b9f; in v2
 *      the language in the URL wins over the user's saved one);
 *   3. the user's interface language, then the workspace's; else English.
 * A browser's own list ("en-US,en;q=0.9") says nothing about the page and is
 * ignored: it made Hebrew screens English.
 */
import type { Request } from "express";
import { resolveEffectiveLocale } from "@chatcenter/shared";

export async function readerLocale(req: Request): Promise<"he" | "en"> {
  const asked = [(req.query as any)?.locale, (req.body as any)?.locale].map((v) => String(v ?? "").toLowerCase());
  for (const a of asked) if (a === "he" || a === "en") return a;
  const header = deliberateLanguage(req.headers?.["accept-language"]);
  if (header) return header;
  const user = (req as any).user ?? {};
  const tenantId = (req as any).tenantId || user.tenantId;
  if (!tenantId) return "en";
  try {
    const r = await resolveEffectiveLocale({ tenantId, userId: user.userId ?? null });
    return String(r.effective).toLowerCase().startsWith("he") ? "he" : "en";
  } catch {
    return "en";
  }
}

/** "he" / "en" when the header is one tag of that language, else null. */
export function deliberateLanguage(h: unknown): "he" | "en" | null {
  const v = String(h ?? "").trim().toLowerCase();
  // Anchored: a list ("en-US,en;q=0.9") or anything longer never matches.
  const m = /^(he|en)(-[a-z]{2,4})?$/.exec(v);
  return m ? (m[1] as "he" | "en") : null;
}

/**
 * The language a question is written in: Hebrew letters against Latin ones,
 * the majority wins ("כמה מהם מ-WhatsApp?" is Hebrew). Null when it has no
 * clear language (a number, a tie, an emoji): the caller falls back to the
 * interface language. A Home chat turn is written in its question's language,
 * steps, cards and suggestions included (Omer, 2026-10-08).
 */
export function questionLanguage(text: unknown): "he" | "en" | null {
  const s = String(text ?? "");
  const he = (s.match(/[א-ת]/g) ?? []).length;
  const en = (s.match(/[A-Za-z]/g) ?? []).length;
  if (he === en) return null;
  return he > en ? "he" : "en";
}
