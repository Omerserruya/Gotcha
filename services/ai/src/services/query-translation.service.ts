/**
 * Cross-language retrieval.
 *
 * The embedding model (text-embedding-3-small) is multilingual but loses a
 * lot across languages: on dev, "איך אפשר ליצור איתכם קשר?" scored 0.308
 * against the Hebrew overview and "How can I reach you?" 0.122. An Israeli
 * business's Knowledge is usually Hebrew while some customers write English.
 *
 * So when the question's script differs from the script most of the tenant's
 * Knowledge is written in, the question is translated (one micro-model call,
 * through generateResponse: logged, audited and metered like every model
 * call, feature "knowledge_query_translation") and BOTH are searched. Any
 * refusal (no credits), failure or timeout falls back to the plain search:
 * a reply never fails because of it.
 */
import { prisma } from "@chatcenter/shared";
import { generateResponse, getMicroModel } from "./ai.service";

export type Script = "hebrew" | "arabic" | "latin";
const SCRIPT_NAME: Record<Script, string> = { hebrew: "Hebrew", arabic: "Arabic", latin: "English" };

/** The script most of the letters are in; null when there are too few to tell. */
export function dominantScript(text: string): Script | null {
  const s = String(text ?? "");
  const counts: Record<Script, number> = {
    hebrew: (s.match(/[֐-׿]/g) ?? []).length,
    arabic: (s.match(/[؀-ۿ]/g) ?? []).length,
    latin: (s.match(/[A-Za-z]/g) ?? []).length,
  };
  const [best, n] = (Object.entries(counts) as Array<[Script, number]>).sort((a, b) => b[1] - a[1])[0]!;
  return n >= 3 ? best : null;
}

const KNOWLEDGE_SCRIPT_TTL_MS = 60 * 60_000;
const knowledgeScriptCache = new Map<string, { script: Script | null; at: number }>();

/** The script most of this tenant's Knowledge is written in (cached an hour). */
export async function knowledgeScript(tenantId: string, now = Date.now()): Promise<Script | null> {
  const hit = knowledgeScriptCache.get(tenantId);
  if (hit && now - hit.at < KNOWLEDGE_SCRIPT_TTL_MS) return hit.script;
  const docs = await prisma.knowledgeDocument.findMany({
    where: { tenantId, knowledgeBase: { isActive: true } },
    select: { title: true, content: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  }).catch(() => []);
  const sample = (docs as any[]).map((d) => `${d.title ?? ""} ${String(d.content ?? "").slice(0, 2000)}`).join(" ");
  const script = dominantScript(sample);
  knowledgeScriptCache.set(tenantId, { script, at: now });
  return script;
}

/** For tests. */
export function clearKnowledgeScriptCache(): void { knowledgeScriptCache.clear(); }

/**
 * It runs beside the embedding on the bot's turn, so it is short. 2500 was set
 * for gpt-5-nano, whose prod max was already 2439 ms (14 days to 2026-11-14).
 * gpt-5-mini answers the same short calls about twice as slowly (prod p50:
 * summary 5.5 s on mini, 2.8 s on nano), so with the micro tier on gpt-5-mini
 * 2500 would drop about half the translations and leave a Hebrew question
 * searching English Knowledge untranslated.
 */
export const TRANSLATION_TIMEOUT_MS = 5000;

/**
 * The question in the Knowledge's language, or null: no mismatch, nothing to
 * tell, or the call was refused / failed / timed out.
 */
export async function translatedQuery(tenantId: string, query: string): Promise<string | null> {
  const q = String(query ?? "").trim();
  const from = dominantScript(q);
  if (!q || !from) return null;
  let to: Script | null = null;
  try { to = await knowledgeScript(tenantId); } catch { return null; }
  if (!to || to === from) return null;
  try {
    const resp = await generateResponse({
      tenantId,
      model: getMicroModel(),
      // Output budget sized to the question (a translation is about as long).
      maxTokens: Math.min(300, Math.ceil(q.length * 2) + 20),
      temperature: 1,
      reasoningEffort: "minimal",
      signal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
      metadata: { type: "knowledge_query_translation" },
      messages: [
        { role: "system", content: `Translate the user's message into ${SCRIPT_NAME[to]}. Reply with the translation only, no quotes, no explanation.` },
        { role: "user", content: q.slice(0, 500) },
      ],
    });
    const out = String(resp?.content ?? "").trim();
    return out && out !== q ? out.slice(0, 500) : null;
  } catch (err: any) {
    // Out of credits, provider error, timeout: the plain search stands.
    console.warn(`[knowledge] query translation skipped: ${err?.name ?? ""} ${err?.message ?? err}`);
    return null;
  }
}

/**
 * A product search in Hebrew or Arabic on a store whose titles are English
 * (eval A05 on dev 2026-11-15: "גרביים" found nothing, "Crew Socks 3-Pack" is
 * the title, and the model said "לא מצאנו" instead of retrying in English as
 * the tool told it). The product word(s) in English, or null: already Latin,
 * or the call was refused / failed / timed out (the empty result stands).
 * One micro-model call, metered as "product_query_translation".
 */
export async function productQueryInEnglish(tenantId: string, query: string): Promise<string | null> {
  const q = String(query ?? "").trim();
  const from = dominantScript(q);
  if (!tenantId || !q || !from || from === "latin") return null;
  try {
    const resp = await generateResponse({
      tenantId,
      model: getMicroModel(),
      maxTokens: 40,
      temperature: 1,
      reasoningEffort: "minimal",
      signal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
      metadata: { type: "product_query_translation" },
      messages: [
        { role: "system", content: "Translate this shop search into the English word(s) a product title would use. Reply with one to three English words only, no quotes, no explanation." },
        { role: "user", content: q.slice(0, 200) },
      ],
    });
    const out = String(resp?.content ?? "").trim().replace(/^["'\s]+|["'.\s]+$/g, "");
    return out && /^[A-Za-z][A-Za-z0-9 '\-]{0,60}$/.test(out) ? out : null;
  } catch (err: any) {
    console.warn(`[woo-search] product query translation skipped: ${err?.name ?? ""} ${err?.message ?? err}`);
    return null;
  }
}
