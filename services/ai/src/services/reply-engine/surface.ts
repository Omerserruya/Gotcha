/**
 * The v2 tool surface: EVERY tool the employee is allowed, always. No stage,
 * funnel or intent ever hides one (Omer 2026-11-16: a stage that hid a needed
 * tool was a recurring bug). What is NOT offered is only what the policy gate
 * would DENY at dispatch, so offered == dispatchable. Sorted by name and
 * deterministic, so it sits in the cached prefix.
 */
import { buildAgentToolsForAIAgent, evaluatePolicies } from "@chatcenter/shared";
import { customToolDefinitions } from "../ai-bot.service";
import { buildAdapterToolSurface } from "../tool-surface-adapters";
import { WOO_COMPLEMENTARY_TOOL } from "../woo-chat-turn.service";
import { mcpToolDefinitions } from "../mcp-servers.service";

/** OpenAI's function-count ceiling. A tenant near it gets its tools merged per system, never hidden by stage. */
export const MAX_TOOLS = 128;
const DESC_MAX = 700;

export const RESPOND_TOOL = {
  type: "function",
  function: {
    name: "respond",
    description: "Finish the turn: the reply the customer receives, what changed, and what backs each claim. Call it exactly once, last.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reply: { type: "string", description: "The message to the customer, in their language." },
        state_update: {
          type: "object",
          additionalProperties: false,
          properties: {
            stage: { type: ["string", "null"], description: "browsing | choosing | ordering | support | complaint | handover | closed, or another short word" },
            intent: { type: ["string", "null"], description: "What the customer wants now, one short line" },
            facts: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] }, description: "Facts the customer stated or a tool confirmed (name, size, budget, order number...). null removes one." },
            pending: {
              type: "array",
              description: "Everything still open after this reply (replaces the list).",
              items: {
                type: "object",
                additionalProperties: false,
                properties: { kind: { type: "string", enum: ["promise", "pending", "approval"] }, text: { type: "string" }, tool: { type: ["string", "null"] } },
                required: ["kind", "text", "tool"],
              },
            },
          },
          required: ["stage", "intent", "facts", "pending"],
        },
        claims: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["price", "product", "action", "fact"] },
              text: { type: "string", description: "For a product: its key, e.g. PRODUCT_2 (never a translated name). Otherwise a few words, e.g. the price as written." },
              source: { type: "string", description: "tool call id or tool name, or knowledge, or state" },
            },
            required: ["kind", "text", "source"],
          },
        },
        handoff: { type: ["string", "null"], description: "ONLY for an explicit ask for a person, a strong complaint, a damaged item or a late order: a short reason. It silences you for the rest of the chat. Otherwise null." },
        team_question: { type: ["string", "null"], description: "A question the team must answer later (a discount, instalments, a detail you could not find). You keep the conversation. Otherwise null." },
        cards: { type: "array", items: { type: "string" }, description: "PRODUCT_n keys to show as cards (card channels only)." },
      },
      required: ["reply", "state_update", "claims", "handoff", "team_question", "cards"],
    },
  },
} as const;

export const READ_SKILL_TOOL = {
  type: "function",
  function: {
    name: "read_skill",
    description: "Open the full playbook of a skill from the Skills list.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
} as const;

export const SEARCH_KNOWLEDGE_TOOL = {
  type: "function",
  function: {
    name: "search_knowledge",
    description: "Search the business's own documents (policies, shipping, returns, FAQ, services) for something the Knowledge section does not cover.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
} as const;

export const ENGINE_TOOL_NAMES = new Set(["respond", "read_skill", "search_knowledge"]);

/**
 * Tools v2 does natively through `respond`, so offering them only costs a model
 * round (eval 2026-11-16: send_product_card / carousel and escalate_to_human each
 * added a round on ~40% of turns). Cards are respond.cards, a handoff is
 * respond.handoff.
 */
export const NATIVE_IN_RESPOND = new Set(["send_product_card", "send_product_carousel", "escalate_to_human"]);

const fnName = (t: any): string => String(t?.function?.name ?? t?.name ?? "");

function shorten(t: any): any {
  const d = String(t?.function?.description ?? "");
  if (d.length <= DESC_MAX) return t;
  return { ...t, function: { ...t.function, description: d.slice(0, DESC_MAX - 1).trimEnd() + "…" } };
}

export interface SurfaceInput {
  tenantId: string;
  aiAgentId: string;
  hasContact: boolean;
  calendarBookable: boolean;
  hasBooking: boolean;
  productCards: boolean;
  wooComplementary: boolean;
}

export interface Surface {
  tools: any[];
  names: string[];
  dropped: { policy: string[]; cap: string[] };
}

export async function buildSurface(i: SurfaceInput & { readSkill?: boolean }, deps: { evaluate?: typeof evaluatePolicies } = {}): Promise<Surface> {
  const evaluate = deps.evaluate ?? evaluatePolicies;
  const [base, custom, adapters, mcp] = await Promise.all([
    buildAgentToolsForAIAgent(i.tenantId, i.aiAgentId, {
      identityLinking: i.hasContact,
      escalation: true,
      scheduleMeeting: i.calendarBookable,
      checkAvailability: i.calendarBookable,
      rescheduleMeeting: i.hasBooking,
      cancelMeeting: i.hasBooking,
      shopifyProducts: i.productCards,
      allowedMode: "AUTO",
    }).catch((e: any) => { console.warn("[reply-engine] base tools failed:", e?.message); return [] as any[]; }),
    customToolDefinitions(i.tenantId, i.aiAgentId).catch(() => [] as any[]),
    buildAdapterToolSurface(i.tenantId, i.aiAgentId).catch(() => [] as any[]),
    mcpToolDefinitions(i.tenantId, i.aiAgentId).catch(() => [] as any[]),
  ]);
  const all: any[] = [...base, ...custom, ...adapters, ...mcp];
  if (i.wooComplementary) all.push(WOO_COMPLEMENTARY_TOOL as any);

  // One per name.
  const byName = new Map<string, any>();
  for (const t of all) {
    const n = fnName(t);
    if (n && !ENGINE_TOOL_NAMES.has(n) && !NATIVE_IN_RESPOND.has(n) && !byName.has(n)) byName.set(n, t);
  }

  // Offered == dispatchable: drop exactly what the gate denies for THIS employee.
  const dropped: Surface["dropped"] = { policy: [], cap: [] };
  const names = [...byName.keys()];
  const verdicts = await Promise.all(
    names.map((n) => evaluate({ tenantId: i.tenantId, toolName: n, aiAgentId: i.aiAgentId }).catch(() => ({ decision: "DENY" } as any))),
  );
  names.forEach((n, k) => {
    if (verdicts[k]?.decision === "DENY") { dropped.policy.push(n); byName.delete(n); }
  });

  let tools = [...byName.values()].map(shorten).sort((a, b) => fnName(a).localeCompare(fnName(b)));
  const room = MAX_TOOLS - ENGINE_TOOL_NAMES.size;
  if (tools.length > room) {
    dropped.cap = tools.slice(room).map(fnName);
    console.error(`[reply-engine] tenant=${i.tenantId} has ${tools.length} tools, over the ${room} cap: merge this system's tools (dropped ${dropped.cap.join(", ")})`);
    tools = tools.slice(0, room);
  }
  tools = [...tools, ...(i.readSkill === false ? [] : [READ_SKILL_TOOL]), RESPOND_TOOL, SEARCH_KNOWLEDGE_TOOL];
  return { tools, names: tools.map(fnName), dropped };
}
