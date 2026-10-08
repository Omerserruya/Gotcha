/**
 * The language of text this service writes for a person (labels, names,
 * statuses): an explicit `locale` (query, then body) wins; otherwise the
 * user's interface language, then the workspace's; else English.
 *
 * Never Accept-Language: the v2 app calls from its server, whose header says
 * nothing about the screen, so Hebrew screens got English text.
 */
import type { Request } from "express";
import { resolveEffectiveLocale } from "@chatcenter/shared";

export async function readerLocale(req: Request): Promise<"he" | "en"> {
  const asked = [(req.query as any)?.locale, (req.body as any)?.locale].map((v) => String(v ?? "").toLowerCase());
  for (const a of asked) if (a === "he" || a === "en") return a;
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
