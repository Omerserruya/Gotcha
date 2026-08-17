import { z } from "zod";
import { generateResponse, callWithRetry, getDefaultModel, getMicroModel } from "../ai.service";

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
  /** Cheap, bounded extraction work routes to the micro tier. */
  tier?: "default" | "micro";
  maxTokens?: number;
  /** `metadata.type` on the usage record, so cost is attributable per stage. */
  feature: string;
  importId: string;
}

export async function structuredCall<T extends z.ZodTypeAny>(
  args: StructuredCallArgs<T>,
): Promise<z.infer<T> | null> {
  const model = args.tier === "micro" ? getMicroModel() : getDefaultModel();
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
      const res = await callWithRetry(() =>
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
          sessionId: `historical-import:${args.importId}`,
          metadata: { type: args.feature, importId: args.importId },
        }),
      );
      raw = res.content;
    } catch (err: any) {
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

    const result = args.schema.safeParse(parsedJson);
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
 * Models occasionally wrap JSON in a fence despite json_object mode. Cheaper to
 * tolerate than to spend a retry on.
 */
function stripCodeFence(s: string): string {
  const trimmed = (s ?? "").trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
}
