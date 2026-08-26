import { prisma, withHistoricalRecords } from "@chatcenter/shared";

export interface StageResult {
  ok: boolean;
  detail?: Record<string, unknown>;
}

/**
 * Append-only audit for one step of one import.
 *
 * Counts and safe metadata only. The subject of this pipeline is a business's
 * entire customer correspondence, and an observability trail that quoted it
 * would put private messages into log aggregation, Sentry breadcrumbs and
 * anywhere else logs are shipped. Every question in the runbook - did sync
 * start, how many chunks, how many customers matched, where did it fail - is
 * answerable from numbers.
 */
export async function recordEvent(
  importId: string,
  step: string,
  outcome: "SUCCESS" | "FAILED" | "SKIPPED" | "PARTIAL",
  message?: string | null,
  detail?: Record<string, unknown>,
  durationMs?: number,
): Promise<void> {
  try {
    await prisma.historicalImportEvent.create({
      data: {
        importId,
        step,
        outcome,
        message: message ?? null,
        detail: (detail ?? undefined) as any,
        durationMs: durationMs ?? null,
      },
    });
  } catch (err: any) {
    console.warn(`[historical-intelligence] event write failed: ${err?.message}`);
  }
}

/**
 * One customer's imported conversation, oldest first, bounded.
 *
 * The bound is the point. A single WhatsApp thread can hold years of messages,
 * and a customer with 2,700 of them would blow any context window and cost more
 * than the insight is worth. Taking the OLDEST first is deliberate: the durable
 * facts this pipeline is looking for - what they bought, what went wrong, what
 * they always ask - are established across the relationship, while the last
 * fifty messages are disproportionately about whatever happened most recently,
 * which is exactly the transient state that must NOT become permanent truth.
 */
export async function loadConversationTranscript(args: {
  tenantId: string;
  conversationId: string;
  limit?: number;
}): Promise<Array<{ direction: "INBOUND" | "OUTBOUND"; body: string; at: Date }>> {
  const rows = await withHistoricalRecords(() =>
    prisma.message.findMany({
      where: {
        tenantId: args.tenantId,
        conversationId: args.conversationId,
        // System dividers and empty media placeholders carry no meaning for a
        // reader and would waste a slot in the bounded window.
        NOT: { body: "" },
      },
      select: { direction: true, body: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: args.limit ?? 400,
    }),
  );
  return rows.map((r) => ({
    direction: r.direction as "INBOUND" | "OUTBOUND",
    body: r.body,
    at: r.createdAt,
  }));
}

/**
 * Render a transcript for a prompt, with a hard character budget.
 *
 * Truncation happens per message rather than by cutting the transcript short,
 * so the shape of the relationship survives even when individual messages do
 * not. A model that sees the whole arc with clipped lines understands the
 * customer better than one that sees the first tenth of it verbatim.
 */
export function renderTranscript(
  messages: Array<{ direction: "INBOUND" | "OUTBOUND"; body: string; at: Date }>,
  maxChars = 12000,
): string {
  const PER_MESSAGE = 400;
  const lines: string[] = [];
  let used = 0;
  for (const m of messages) {
    const who = m.direction === "INBOUND" ? "Customer" : "Business";
    const day = m.at.toISOString().slice(0, 10);
    const text = m.body.length > PER_MESSAGE ? `${m.body.slice(0, PER_MESSAGE)}...` : m.body;
    const line = `[${day}] ${who}: ${text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** Fixed-size batches, so a stage can iterate thousands of rows predictably. */
export function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Bounded-concurrency map. Used everywhere a stage fans out over customers or
 * clusters: unbounded `Promise.all` over a thousand LLM calls would hit the
 * provider rate limit on the first import and look like an outage.
 */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err: any) {
        console.warn(`[historical-intelligence] item ${index} failed: ${err?.message}`);
        results[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The language every GENERATED artifact of the import is written in -
 * questions, answers, topics, customer facts and summaries.
 *
 * Tenant.defaultLocale is the org's system language and the schema comment
 * already promises it governs AI-generated content; the import stages were
 * the one place that ignored it, so a Hebrew business got its own FAQ handed
 * back in English. Verbatim quotes are exempt - they stay in whatever
 * language the conversation actually happened in.
 *
 * The map is deliberately forgiving: real rows hold "he" but also "English"
 * (free-typed), so both codes and names resolve. Unknown values fall back to
 * English rather than passing garbage into a prompt.
 */
const PROMPT_LANGUAGE_NAMES: Record<string, string> = {
  he: "Hebrew",
  hebrew: "Hebrew",
  "עברית": "Hebrew",
  en: "English",
  english: "English",
  ar: "Arabic",
  arabic: "Arabic",
  ru: "Russian",
  russian: "Russian",
  fr: "French",
  es: "Spanish",
};

export async function tenantPromptLanguage(tenantId: string): Promise<string> {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { defaultLocale: true },
  });
  return resolvePromptLanguage(t?.defaultLocale);
}

export function resolvePromptLanguage(defaultLocale: string | null | undefined): string {
  const raw = (defaultLocale || "en").trim().toLowerCase();
  return PROMPT_LANGUAGE_NAMES[raw] ?? "English";
}

/** Appended to a stage's system prompt. One sentence, so it cannot be missed. */
export function languageDirective(language: string): string {
  return (
    `\n\nOUTPUT LANGUAGE\n` +
    `Write generated PROSE in ${language} - questions, answers, topics, reasoning, summaries.\n` +
    // Two exceptions, and the second one cost a full pipeline run to find.
    //
    // "Write every generated field in ${language}" is true of prose and false
    // of a field whose value must match a fixed list. The model dutifully
    // translated the `category` enum into Hebrew, every value failed
    // validation, and 185 of 199 items were coerced to OTHER - destroying the
    // grouping that makes the review queue usable. It stayed hidden for two
    // runs because an invalid enum used to fail the whole call and the retry
    // silently corrected it; the enum was never the problem, this sentence was.
    `Two exceptions:\n` +
    `- Verbatim quote fields: copy them exactly as written in the conversation, whatever language that is.\n` +
    `- Fields with a fixed list of allowed values (enums such as category and scope): reply with the EXACT value from the list, in English, spelled exactly as given. Never translate these, never rephrase them.`
  );
}
