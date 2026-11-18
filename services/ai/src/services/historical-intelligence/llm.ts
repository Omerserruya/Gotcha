import { z } from "zod";
import { generateResponse, callWithRetry, getDefaultModel, getMicroModel, platformPaidScope } from "../ai.service";
import { isAiAccessDenied } from "./stage-utils";

/**
 * Schema-validated LLM output for the historical pipeline.
 *
 * Everything this pipeline asks a model for is structured data that other code
 * consumes: facts to store, question/answer pairs to cluster, a topic label to
 * count. Free prose would have to be parsed, and a parser that guesses is how a
 * model's bad day becomes a corrupted knowledge base.
 *
 * `response_format: json_object` plus a zod parse is the strongest guarantee
 * available through the shared client, which does not expose json_schema. The
 * parse is the real gate: a response that does not match is retried once with
 * the validation error fed back, then given up on. Giving up is deliberate -
 * one customer whose analysis failed is a gap; a pipeline that loops on a
 * malformed response is an unbounded bill.
 */
export interface StructuredCallArgs<T extends z.ZodTypeAny> {
  tenantId: string;
  schema: T;
  system: string;
  user: string;
  /**
   * Cheap, bounded extraction work routes to the micro tier. "import": the knowledge stages (extraction,
   * dedupe, curation and the passes after them) run on the strongest model (2026-11-18, Omer).
   */
  tier?: "default" | "micro" | "import";
  maxTokens?: number;
  /** `metadata.type` on the usage record, so cost is attributable per stage. */
  feature: string;
  /**
   * The import these calls belong to, when there is one.
   *
   * OPTIONAL because the same count-first voice analysis now also runs outside
   * an import, over live conversations, where no `HistoricalImport` row exists
   * to key on. The import path is unchanged and still passes it.
   */
  importId?: string;
}

/** The import tier's model: HISTORICAL_IMPORT_MODEL, else gpt-6.2-sol (2026-11-18; verified on dev: JSON in the asked shape). */
export function getImportModel(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.HISTORICAL_IMPORT_MODEL ?? "").trim() || "gpt-6.2-sol";
}
/** HISTORICAL_IMPORT_PLATFORM_PAID=true|1: the import's calls are the platform's, not the tenant's (default off). */
export function importPlatformPaid(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.HISTORICAL_IMPORT_PLATFORM_PAID ?? "").trim());
}

export async function structuredCall<T extends z.ZodTypeAny>(
  args: StructuredCallArgs<T>,
): Promise<z.infer<T> | null> {
  const model = args.tier === "micro" ? getMicroModel() : args.tier === "import" ? getImportModel() : getDefaultModel();
  const messages = [
    { role: "system" as const, content: args.system },
    { role: "user" as const, content: args.user },
  ];

  let lastError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptMessages =
      attempt === 0
        ? messages
        : [
            ...messages,
            {
              role: "user" as const,
              content:
                `Your previous reply did not match the required shape: ${lastError}\n` +
                `Reply again with ONLY valid JSON matching the schema described above.`,
            },
          ];

    let raw: string;
    try {
      const call = () => callWithRetry(() =>
        generateResponse({
          tenantId: args.tenantId,
          model,
          messages: attemptMessages,
          temperature: 0,
          maxTokens: args.maxTokens ?? 2000,
          responseFormat: { type: "json_object" },
          // Grouping every call of one import under one session id lets OpenAI's
          // prefix cache do its job across thousands of per-customer calls that
          // share an identical system prompt.
          sessionId: args.importId
            ? `historical-import:${args.importId}`
            : // No import to group under. Keyed by tenant and feature so the
              // prefix cache still works across repeat runs, and so an
              // import-less call can never collide with an import's session.
              `${args.feature}:${args.tenantId}`,
          metadata: { type: args.feature, ...(args.importId ? { importId: args.importId } : {}) },
        }),
      );
      // Platform-paid when the flag says so: the "_import" feature suffix keeps every row out of the tenant's
      // budgets and usage figures, and a billing refusal can no longer stop the import.
      const res = importPlatformPaid() && args.importId ? await platformPaidScope.run({ reason: "historical_import" }, call) : await call();
      raw = res.content;
    } catch (err: any) {
      // Inside an import a billing refusal stops the import (index.ts): every
      // later call would be refused the same way. Elsewhere it stays "no result".
      if (args.importId && isAiAccessDenied(err)) throw err;
      // The provider failed after its own retries. The stage above decides
      // whether that is fatal; here it is simply "no result".
      console.warn(`[historical-intelligence] ${args.feature} llm call failed: ${err?.message}`);
      return null;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFence(raw));
    } catch {
      lastError = "the reply was not parseable JSON";
      continue;
    }

    const result = args.schema.safeParse(noDashesDeep(parsedJson));
    if (result.success) return result.data;
    lastError = result.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }

  console.warn(
    `[historical-intelligence] ${args.feature} produced no schema-valid output: ${lastError}`,
  );
  return null;
}

/**
 * No em dash or en dash in what the import writes (Omer's rule; the Smoovee rerun on luna had 9 item answers and 6
 * merged answers with one). A dash between two digits ("9 to 17") becomes a hyphen, any other one a comma. Verbatim
 * quotes stay as the chat or the document has them: a key that starts with "quoted" or "quote", "passage", and a document title ("document").
 */
const DASH_RANGE = /(\d)\s*[\u2013\u2014]\s*(\d)/g;
const DASH_ANY = /\s*[\u2013\u2014]\s*/g;
export function noDashes(s: string): string {
  return String(s ?? "").replace(DASH_RANGE, "$1-$2").replace(DASH_ANY, ", ").replace(/,\s*,/g, ",").replace(/^,\s*/, "");
}
const VERBATIM_KEY = /^(?:quoted|quote|passage|document)/i;
export function noDashesDeep(v: unknown, key = ""): unknown {
  if (VERBATIM_KEY.test(key)) return v;
  if (typeof v === "string") return noDashes(v);
  if (Array.isArray(v)) return v.map((x) => noDashesDeep(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, noDashesDeep(x, k)]));
  return v;
}

/**
 * Models occasionally wrap JSON in a fence despite json_object mode. Cheaper to
 * tolerate than to spend a retry on.
 */
function stripCodeFence(s: string): string {
  const trimmed = (s ?? "").trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}
