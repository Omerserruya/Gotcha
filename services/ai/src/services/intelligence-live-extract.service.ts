/**
 * Live field extraction — Customer Intelligence V2, Phase 2.
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

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
}

/**
 * Extract sparse field values from the current transcript. Returns [] on any
 * failure (best-effort — never throws into the live path).
 */
export async function extractFieldsLive(params: {
  tenantId: string;
  conversationId: string;
  allowedFields: string[];
}): Promise<ExtractedField[]> {
  const { allowedFields } = params;
  if (!allowedFields.length) return [];

  const messages = await prisma.message.findMany({
    where: { conversationId: params.conversationId },
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
    "Respond ONLY with a JSON object — no prose, no code fences.",
    "Include a key ONLY if its value was EXPLICITLY stated or clearly implied in THIS conversation.",
    "OMIT any field not discussed. Never guess. An omitted field is better than a wrong one.",
    `Allowed keys (use ONLY these): ${allowedFields.join(", ")}`,
    'Shape: { "<key>": <value>, ... }. Values: strings, numbers, or booleans.',
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
  for (const [key, value] of Object.entries(parsed)) {
    if (!allow.has(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    out.push({ key, value });
  }
  return out;
}
