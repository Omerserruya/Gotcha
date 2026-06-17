/**
 * Live field extraction - Customer Intelligence V2, Phase 2.
 *
 * A LEAN, incremental extractor for OPEN text conversations: it reads the
 * transcript-so-far and pulls values for the tenant's allowed intelligence
 * fields, returning a sparse { key: value } map. Unlike the close summarizer it
 * does ONE focused job (field extraction) so it's cheap enough to run live.
 *
 * Output feeds `ingestConversationFacts(source="llm_live")`. Cost is controlled
 * by the caller (debounce + min-new-content gating in the subscriber).
 */

import { prisma } from "@chatcenter/shared";
import { generateResponse, getDefaultModel } from "./ai.service";
import type { ExtractedField } from "./intelligence-ingest.service";

const MAX_MESSAGES = 40;

/**
 * Rich extraction spec for one field. `description` + `examples` are fed to the
 * LLM to sharpen extraction; `negativeExamples` suppress common false positives.
 */
export interface ExtractionFieldSpec {
  key: string;
  label?: string | null;
  description?: string | null;
  type?: string | null;
  options?: string[];
  examples?: string[];
  negativeExamples?: string[];
}

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
}

function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.6;
  return Math.max(0, Math.min(1, n));
}

// Render a human-readable guide line per field so the model knows what each key
// means, what good values look like, and what to avoid.
function renderFieldGuide(fields: ExtractionFieldSpec[]): string {
  return fields.map((f) => {
    const bits: string[] = [`- ${f.key}`];
    if (f.label) bits.push(`(${f.label})`);
    if (f.type) bits.push(`[${String(f.type).toLowerCase()}]`);
    if (f.description) bits.push(`- ${f.description}`);
    if (f.options?.length) bits.push(`- one of: ${f.options.join(" | ")}`);
    if (f.examples?.length) bits.push(`- e.g. ${f.examples.map((e) => `"${e}"`).join(", ")}`);
    if (f.negativeExamples?.length) bits.push(`- NOT: ${f.negativeExamples.map((e) => `"${e}"`).join(", ")}`);
    return bits.join(" ");
  }).join("\n");
}

/**
 * Extract sparse field values from the current transcript. Returns [] on any
 * failure (best-effort - never throws into the live path). Each result carries a
 * verbatim `evidence` snippet and a `confidence` so downstream ingest can apply
 * provenance + the conflict/review policy.
 */
export async function extractFieldsLive(params: {
  tenantId: string;
  conversationId: string;
  /** Rich field specs. Back-compat: a plain string[] of keys is also accepted. */
  fields: Array<ExtractionFieldSpec | string>;
}): Promise<ExtractedField[]> {
  const specs: ExtractionFieldSpec[] = (params.fields ?? []).map((f) =>
    typeof f === "string" ? { key: f } : f,
  );
  if (!specs.length) return [];
  const allowedFields = specs.map((s) => s.key);

  const messages = await prisma.message.findMany({
    // tenantId is required by the TenantGuard (a conversationId-only query is
    // blocked as a potential cross-tenant read).
    where: { tenantId: params.tenantId, conversationId: params.conversationId },
    orderBy: { createdAt: "asc" },
    select: { direction: true, body: true, senderName: true },
    take: MAX_MESSAGES,
  });
  const transcript = messages
    .filter((m) => m.body && m.body.trim())
    .map((m) => `${m.direction === "INBOUND" ? "Customer" : (m.senderName || "Agent")}: ${m.body}`)
    .join("\n");
  if (!transcript.trim()) return [];

  const system = [
    "You extract structured CRM/intelligence field values from a customer conversation.",
    "Respond ONLY with a JSON object - no prose, no code fences.",
    "Include a key ONLY if its value was EXPLICITLY stated or clearly implied in THIS conversation.",
    "OMIT any field not discussed. Never guess. An omitted field is better than a wrong one.",
    "",
    "Fields to look for (use ONLY these keys; honor the examples and the NOT list):",
    renderFieldGuide(specs),
    "",
    "For each field you DO fill, return an object:",
    '  "<key>": { "value": <string|number|boolean>, "evidence": "<verbatim 1-12 word quote from the conversation that proves it>", "confidence": <0..1> }',
    "Rules: `evidence` MUST be an exact substring the customer (or agent) actually wrote - never paraphrase. ",
    "Set `confidence` by how explicit the statement was: explicit = 0.9+, clearly implied = 0.7, loose inference = 0.5 or OMIT.",
    'Shape: { "<key>": { "value": ..., "evidence": "...", "confidence": ... }, ... }.',
  ].join("\n");

  let content = "";
  try {
    const resp = await generateResponse({
      tenantId: params.tenantId,
      model: process.env.INTELLIGENCE_LIVE_MODEL || getDefaultModel(),
      temperature: 0,
      maxTokens: 400,
      responseFormat: { type: "json_object" },
      metadata: { type: "intelligence_live_extract", conversationId: params.conversationId },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Conversation:\n${transcript}\n\nReturn the JSON of discovered field values.` },
      ],
    });
    content = resp.content ?? "";
  } catch {
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripFences(content));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const allow = new Set(allowedFields);
  const out: ExtractedField[] = [];
  for (const [key, raw] of Object.entries(parsed)) {
    if (!allow.has(key)) continue;
    // Accept both the rich shape { value, evidence, confidence } and a bare
    // scalar (back-compat / model that ignored the object instruction).
    let value: unknown = raw;
    let evidence: string | null = null;
    let confidence: number | undefined;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as any)) {
      const o = raw as any;
      value = o.value;
      evidence = typeof o.evidence === "string" ? o.evidence.slice(0, 240) : null;
      confidence = o.confidence === undefined ? undefined : clampConfidence(o.confidence);
    }
    if (value === null || value === undefined || value === "") continue;
    out.push({ key, value, evidence, confidence });
  }
  return out;
}
