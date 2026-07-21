/**
 * Per-turn Discovery integration for the autonomous bot.
 *
 * Wires the authoritative Discovery State (packages/shared) into the AI turn:
 * reuse the EXISTING extractor (intelligence-live-extract) to propose facts,
 * persist them to the session, compute readiness deterministically, and return
 * a compact snapshot + the next-action decision the reply loop enforces.
 *
 * This is the hybrid seam: persistent authoritative state (shared) +
 * per-turn extraction/injection/orchestration (AI service). It does NOT talk
 * to the model itself beyond the extractor; the caller injects `snapshot` into
 * prompt BLOCK 5 and honors `decision`.
 */
import {
  getOrCreateActiveSession,
  applyExtractedFacts,
  markAnswered,
  computeReadiness,
  buildDiscoverySnapshot,
  getDiscoveryProfile,
  type ProposedFact,
  type DiscoveryProfile,
} from "@chatcenter/shared";
import { extractFieldsLive } from "./intelligence-live-extract.service";

export type DiscoveryDecision =
  | { kind: "collect" }                    // still missing required info - ask ONE
  | { kind: "execute"; tool: string }      // ready AND tool available - force the search
  | { kind: "blocked_no_tool"; tool: string }; // ready but tool not in surface - honest handoff

export interface DiscoveryTurnResult {
  active: boolean;
  goalKey?: string;
  snapshot?: string;
  decision?: DiscoveryDecision;
  writtenFacts?: string[];
}

/** Product-shopping signal: the store search tool is offered this turn, and the
 * conversation is a sales/product context (role or an already-collected
 * category fact). Kept conservative so non-shopping chats are unaffected. */
export function productDiscoveryApplies(opts: {
  role: string | null | undefined;
  availableToolNames: string[];
}): boolean {
  const salesish = ["sales", "sdr", "customer_success"].includes(String(opts.role || "").toLowerCase());
  const hasProductTool = opts.availableToolNames.some(
    (t) => t === "shopify.search_products" || t === "search_products" || t.endsWith(".search_products"),
  );
  // Applies when this is a sales-type employee. Whether the store tool is
  // available only changes execute vs honest-blocker, not whether we track.
  return salesish || hasProductTool;
}

/** Is the product-search tool actually in this turn's offered surface? */
export function productToolAvailable(availableToolNames: string[]): { available: boolean; tool: string } {
  const tool = availableToolNames.find(
    (t) => t === "shopify.search_products" || t === "search_products" || t.endsWith(".search_products"),
  );
  return { available: !!tool, tool: tool || "shopify.search_products" };
}

/** Map extractor output → typed ProposedFacts (all customer_explicit; the
 * extractor only emits what was stated/implied, with evidence + confidence). */
function toProposedFacts(
  extracted: Array<{ key: string; value: unknown; confidence?: number | null }>,
  sourceMessageId?: string | null,
): ProposedFact[] {
  return extracted.map((e) => ({
    key: e.key,
    value: e.value,
    source: "customer_explicit",
    confidence: e.confidence ?? undefined,
    sourceMessageId: sourceMessageId ?? null,
  }));
}

/**
 * Run the discovery pass for this turn. Safe/no-op when not applicable or on
 * any error (returns {active:false}); never throws into the bot turn.
 */
export async function runProductDiscoveryTurn(opts: {
  tenantId: string;
  conversationId: string;
  aiAgentId: string;
  role: string | null | undefined;
  availableToolNames: string[];
  incomingMessageId?: string | null;
}): Promise<DiscoveryTurnResult> {
  try {
    if (!productDiscoveryApplies({ role: opts.role, availableToolNames: opts.availableToolNames })) {
      return { active: false };
    }
    const profile = getDiscoveryProfile("product_recommendation") as DiscoveryProfile;
    const session = await getOrCreateActiveSession({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      goalKey: profile.goalKey,
      aiAgentId: opts.aiAgentId,
    });

    // Reuse the existing extractor - NO new framework. Feed it the profile's
    // fact specs (key + description + enum hints).
    const specs = profile.facts.map((f) => ({
      key: f.key,
      description: f.description,
      ...(f.enumValues ? { examples: f.enumValues } : {}),
    }));
    const extracted = await extractFieldsLive({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      fields: specs as any,
    }).catch(() => []);

    const proposed = toProposedFacts(extracted as any, opts.incomingMessageId);
    const { written } = await applyExtractedFacts({ session, profile, facts: proposed });
    if (written.length) await markAnswered({ session, answeredKeys: written, answeredMessageId: opts.incomingMessageId });

    const readiness = await computeReadiness(session, profile);
    const snapshot = await buildDiscoverySnapshot(session, profile);

    let decision: DiscoveryDecision;
    if (!readiness.ready) {
      decision = { kind: "collect" };
    } else {
      const { available, tool } = productToolAvailable(opts.availableToolNames);
      decision = available ? { kind: "execute", tool } : { kind: "blocked_no_tool", tool };
    }
    return { active: true, goalKey: profile.goalKey, snapshot, decision, writtenFacts: written };
  } catch (err: any) {
    console.warn("[discovery] turn failed (non-fatal):", err?.message);
    return { active: false };
  }
}
