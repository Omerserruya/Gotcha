/**
 * What GOTCHA remembers about a customer - exactly what the AI is given.
 *
 * Two stores carry a customer across conversations into the chat prompt:
 *   1. CustomerProfile.facts - fields extracted from earlier conversations
 *      (live + post-conversation), rendered as "Facts already known about this
 *      customer (do NOT re-ask)" by buildSessionFactsBlock.
 *   2. CustomerHistoricalMemory - learned from an imported chat history,
 *      rendered as "What we know about this customer from before".
 *
 * ★ ONE READ PER STORE, SHARED WITH THE PROMPT. The prompt renders from the
 * loaders below and GET /api/customer-memory returns them, so the screen
 * cannot show a fact the model does not receive, or miss one it does. A
 * separate query here would drift the first time someone tunes the prompt's
 * filter.
 *
 * Deliberately NOT included: the CRM block (a live lookup in an external
 * system, not something GOTCHA learned) and this conversation's own messages
 * (the transcript is already on screen).
 */
import { prisma } from "@chatcenter/shared";
import { resolveIdentity } from "./intelligence-ingest.service";
import { loadHistoricalMemoryForPrompt, type HistoricalMemoryForPrompt } from "./historical-intelligence/memory-block.service";

/** Same cap the prompt applies to each value. */
const FACT_VALUE_MAX = 120;

export interface ProfileFactForPrompt {
  key: string;
  /** The value as the prompt renders it (stringified, capped). */
  value: string;
  confidence: number | null;
  source: string | null;
  observedAt: string | null;
}

/**
 * The customer's profile facts as the prompt uses them: only non-empty
 * values, in stored order, each capped. `buildSessionFactsBlock` renders
 * `- key: value` from exactly this list.
 */
export async function loadProfileFactsForPrompt(tenantId: string, conversationId: string): Promise<ProfileFactForPrompt[]> {
  const identity = await resolveIdentity(tenantId, conversationId);
  if (!identity) return [];
  const profile = await (prisma as any).customerProfile
    .findUnique({
      where: { tenantId_identityKey: { tenantId, identityKey: identity.identityKey } },
      select: { facts: true },
    })
    .catch(() => null);
  const facts = (profile?.facts ?? {}) as Record<string, { value?: unknown; confidence?: unknown; source?: unknown; observedAt?: unknown }>;
  return Object.entries(facts)
    .filter(([, v]) => v && v.value != null && String(v.value).trim() !== "")
    .map(([key, v]) => ({
      key,
      value: String(v.value).slice(0, FACT_VALUE_MAX),
      confidence: typeof v.confidence === "number" ? v.confidence : null,
      source: typeof v.source === "string" ? v.source : null,
      observedAt: typeof v.observedAt === "string" ? v.observedAt : null,
    }));
}

export interface CustomerMemory {
  conversationId: string;
  facts: ProfileFactForPrompt[];
  historical: HistoricalMemoryForPrompt | null;
}

/** Null when the conversation is not this tenant's. */
export async function getCustomerMemory(tenantId: string, conversationId: string): Promise<CustomerMemory | null> {
  const conv = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId },
    select: { id: true, customerExternalId: true },
  });
  if (!conv) return null;
  const [facts, historical] = await Promise.all([
    loadProfileFactsForPrompt(tenantId, conversationId),
    loadHistoricalMemoryForPrompt({ tenantId, customerExternalId: conv.customerExternalId }),
  ]);
  return { conversationId, facts, historical };
}
