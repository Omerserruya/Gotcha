/**
 * A time cap on the turn's side judgement calls (knowledge-resolve, the wizard
 * binding, the discovery extraction), dev 2026-10-27 urban-e27: one of them
 * now and then takes 11 to 15s while its siblings take 3 to 5s, and the reply
 * waits for it. Each already has a fail-soft value; past the cap that value is
 * used and the late answer is dropped. The turn is never aborted.
 *
 * AI_JUDGEMENT_CAP_MS sets the cap; unset, 6000 where NODE_ENV is development
 * and no cap anywhere else. "0" or "off" turns it off.
 */
export function judgementCapMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = String(env.AI_JUDGEMENT_CAP_MS ?? "").trim();
  if (v === "0" || v === "off") return null;
  if (/^\d+$/.test(v)) return Number(v);
  return env.NODE_ENV === "development" ? 6000 : null;
}

/** The call's own result, or `fallback` when it has not answered within the cap. */
export async function capped<T>(work: Promise<T>, fallback: T, label: string, conversationId: string, ms: number | null = judgementCapMs()): Promise<T> {
  if (!ms) return work;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[judgement-cap] ${label} took over ${ms}ms: its fail-soft value is used conv=${conversationId}`);
      resolve(fallback);
    }, ms);
  });
  // The late answer is dropped; an error after the cap must not surface.
  work.catch(() => undefined);
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The discovery extraction's own cap, higher: past it the turn loses the facts
 * this message gave (urban-e28: "היא אוהבת צעיפים" never became a category,
 * capped at 6s on two turns running). AI_EXTRACTION_CAP_MS; unset, 9000 where
 * the side cap is on, none where it is off.
 */
export function extractionCapMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const v = String(env.AI_EXTRACTION_CAP_MS ?? "").trim();
  if (v === "0" || v === "off") return null;
  if (/^\d+$/.test(v)) return Number(v);
  return judgementCapMs(env) == null ? null : 9000;
}
