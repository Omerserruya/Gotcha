import { prisma, normalizePhone } from "@chatcenter/shared";

/**
 * What the import learned about this customer, rendered for an agent prompt.
 *
 * This is the payoff for the whole customer-learning stage. Memory that is only
 * ever written is a database row; memory that reaches the prompt is the
 * difference between an AI that greets a returning customer as a stranger and
 * one that already knows size M did not fit them last time.
 *
 * ── Why it is labelled so carefully ──
 *
 * Everything in this block was inferred from old conversations by a model. It
 * is good context and it is not gospel, and the surrounding text says so in
 * words the model will actually honour: use it to be helpful, never state it
 * back as fact, never act on it without checking. Without that framing the most
 * likely failure is an agent opening with "I see your last delivery was late" to
 * somebody whose delivery was fine, which is worse than knowing nothing.
 *
 * Low-confidence observations are dropped rather than hedged. A prompt full of
 * "possibly" teaches the model to ignore the whole block.
 */

/** Facts below this are not worth the tokens or the risk of being wrong. */
const MIN_CONFIDENCE = new Set(["high", "medium"]);

/** Kept short on purpose: this competes for attention with the live conversation. */
const MAX_FACTS = 6;

interface StoredFact {
  text?: unknown;
  category?: unknown;
  confidence?: unknown;
}

export async function renderHistoricalMemoryBlock(args: {
  tenantId: string;
  customerExternalId: string | null | undefined;
}): Promise<string> {
  const { tenantId } = args;
  if (!args.customerExternalId) return "";

  // The memory row is keyed by the normalized number, while a conversation
  // carries whatever the channel handed us. Probing both is what stops
  // "972501234567" and "+972501234567" being two different people at the exact
  // moment it matters most.
  const raw = String(args.customerExternalId);
  const normalized = normalizePhone(raw);
  const keys = Array.from(new Set([raw, normalized].filter(Boolean)));

  let memory: { facts: unknown; summary: string | null } | null = null;
  try {
    memory = await prisma.customerHistoricalMemory.findFirst({
      where: { tenantId, customerExternalId: { in: keys } },
      select: { facts: true, summary: true },
    });
  } catch (err: any) {
    // Context is an enhancement. A failure here must never cost the customer a
    // reply.
    console.warn(`[historical-memory] lookup failed: ${err?.message}`);
    return "";
  }
  if (!memory) return "";

  const facts = Array.isArray(memory.facts) ? (memory.facts as StoredFact[]) : [];
  const usable = facts
    .filter((f) => typeof f.text === "string" && f.text.trim().length > 0)
    .filter((f) => MIN_CONFIDENCE.has(String(f.confidence ?? "low")))
    .slice(0, MAX_FACTS)
    .map((f) => `- ${String(f.text).trim()}`);

  if (usable.length === 0 && !memory.summary) return "";

  const lines: string[] = [];
  lines.push("## What we know about this customer from before");
  lines.push(
    "Learned from their earlier conversations with this business, before GOTCHA was connected.",
  );
  lines.push("");
  if (memory.summary) {
    lines.push(memory.summary.trim());
    lines.push("");
  }
  if (usable.length > 0) {
    lines.push(...usable);
    lines.push("");
  }
  lines.push(
    "Treat this as background, not as confirmed fact. Use it to be more helpful and to avoid asking things they have already told this business. Do NOT recite it back to them, do not assume it is still current, and confirm anything you are about to act on.",
  );

  return lines.join("\n");
}
