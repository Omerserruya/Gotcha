/**
 * Gate 1 (before the model: reply at all?) and Gate 3 (before send: are the
 * claims backed?). Gate 2 lives with the tool runner (tools.ts).
 *
 * Gate 1 here is the AI-service half. The worker already decided owner-recent,
 * assigned / handed over, business hours (silent), the autonomy budget and a
 * request for a person before it called us; v2 re-checks only what the AI
 * service owns: the employee is ACTIVE, the tenant may spend AI, and the cost
 * budget allows a turn.
 */
import { checkAiAllowed } from "@chatcenter/shared";
import { ungroundedPrices, checkReplyStyle, type StyleViolationKind } from "../reply-style-check.service";
import { validateActionHonesty } from "../action-honesty.service";
import type { Claim, ClaimProblem, Gate3Verdict, ToolRunRecord } from "./contract";

export type Gate1 =
  | { reply: true }
  | { reply: false; escalation: { reason: string; priority: "low" | "medium" | "high"; summary: string } };

export async function gate1(opts: {
  tenantId: string;
  agentStatus: string;
  platformPaid: boolean;
  billingSummary: (a: any) => string;
  deps?: { checkAiAllowed?: typeof checkAiAllowed };
}): Promise<Gate1> {
  if (opts.agentStatus !== "ACTIVE") {
    return { reply: false, escalation: { reason: `agent_inactive:${opts.agentStatus}`, priority: "low", summary: `AI employee is ${opts.agentStatus} - conversation needs a human.` } };
  }
  if (!opts.platformPaid) {
    const allowed = await (opts.deps?.checkAiAllowed ?? checkAiAllowed)(opts.tenantId);
    if (!allowed.allowed && allowed.reason) {
      return { reply: false, escalation: { reason: `billing_blocked:${allowed.reason}`, priority: "medium", summary: opts.billingSummary(allowed) } };
    }
  }
  return { reply: true };
}

/** Style kinds that are a hard fail in v2 (everything else is advisory, logged only). */
export const HARD_STYLE: ReadonlySet<StyleViolationKind> = new Set<StyleViolationKind>([
  "gendered_address",
  "self_gender",
  "slash_form",
  "banned_phrase",
  "self_intro",
  "ungrounded_price",
] as StyleViolationKind[]);


/**
 * Products are verified by KEY, never by name (eval 2026-11-16: the model names
 * English catalogue titles in Hebrew, "טרנץ' כותנה דוחה מים", and name matching
 * failed 22 of 66 correct turns). A claim or a card citing PRODUCT_n must point
 * at a product this turn's tools returned; a claim with no key is not a fact to
 * verify on its own (its price is still checked against the grounding).
 */
export function unknownProductKeys(claims: Claim[], cards: string[], candidateCount: number): string[] {
  const keys = [
    ...claims.filter((c) => c.kind === "product").flatMap((c) => String(c.text ?? "").match(/PRODUCT_\d+/gi) ?? []),
    ...cards.flatMap((k) => String(k ?? "").match(/PRODUCT_\d+/gi) ?? []),
  ];
  return [...new Set(keys.map((k) => k.toUpperCase()))].filter((k) => {
    const n = Number(k.slice("PRODUCT_".length));
    return !(n >= 1 && n <= candidateCount);
  });
}

export interface Gate3Input {
  reply: string;
  claims: Claim[];
  cards: string[];
  /** Products this turn's tools returned (keys PRODUCT_1..N). */
  candidateCount: number;
  tools: ToolRunRecord[];
  /** Everything a price or product may come from: tool results, state, knowledge, the conversation. */
  grounding: string;
  locale: "he" | "en";
  incomingMessage: string;
  isFirstReply: boolean;
  employeeGender: "feminine" | "masculine" | null;
  employeeName: string | null;
  toolsOffered: string[];
  shopFloor: boolean;
  handedOff: boolean;
  approvalPending: boolean;
}

export function gate3(i: Gate3Input): Gate3Verdict {
  const problems: ClaimProblem[] = [];
  const reply = String(i.reply ?? "").trim();
  if (!reply) return { ok: false, problems: [{ kind: "style", codes: ["empty"] }] };

  const prices = ungroundedPrices(reply, i.grounding);
  if (prices.length) problems.push({ kind: "ungrounded_price", prices });

  const log = i.tools.map((t) => ({
    tool: t.tool,
    decision: t.decision === "allow" ? "executed" : t.decision === "approval" ? "awaiting_approval" : t.decision,
    sideEffect: t.decision === "approval" ? "awaiting_approval" : t.decision === "deny" ? "denied" : undefined,
  }));
  if (i.handedOff) log.push({ tool: "escalate_to_human", decision: "executed", sideEffect: "escalate" });
  const honesty = validateActionHonesty(reply, log as any, { hasBackgroundJob: i.approvalPending });
  if (!honesty.ok) problems.push({ kind: "unsupported_action", claims: honesty.unsupported.map((u: any) => String(u?.match ?? u?.kind ?? u)) });

  const unknown = unknownProductKeys(i.claims, i.cards, i.candidateCount);
  if (unknown.length) problems.push({ kind: "unknown_product", names: unknown });

  const style = checkReplyStyle(reply, {
    locale: i.locale,
    isFirstReply: i.isFirstReply,
    incomingMessage: i.incomingMessage,
    employeeGender: i.employeeGender,
    employeeName: i.employeeName,
    productFactsAvailable: i.tools.some((t) => /product|search|variation|inventory/i.test(t.tool)),
    shopFloor: i.shopFloor,
    toolsOffered: i.toolsOffered,
    handedOff: i.handedOff,
    customerClosing: false,
    toolsCalled: i.tools.map((t) => t.tool),
    groundingText: i.grounding,
  })
    .map((v) => v.kind)
    // Prices are the claims check above, with the same grounding.
    .filter((k) => HARD_STYLE.has(k) && k !== "ungrounded_price");
  if (style.length) problems.push({ kind: "style", codes: [...new Set(style)] });

  return { ok: problems.length === 0, problems };
}

/** The ONE targeted correction note for the rewrite round. */
export function correctionNote(problems: ClaimProblem[], locale: "he" | "en"): string {
  const lines = ["Your reply cannot be sent as is. Rewrite it once, fixing exactly this, and call respond again:"];
  for (const p of problems) {
    if (p.kind === "ungrounded_price") lines.push(`- These prices are not in any tool result or the knowledge: ${p.prices.join(", ")}. Remove them or state only prices a tool returned.`);
    if (p.kind === "unsupported_action") lines.push(`- You said something was done that no tool did this turn (${p.claims.join("; ")}). Say only what really happened; offer a person if needed.`);
    if (p.kind === "unknown_product") lines.push(`- These product keys are not in this turn's results: ${p.names.join("; ")}. Use only the PRODUCT_n keys a tool returned this turn.`);
    if (p.kind === "style") {
      const c = new Set(p.codes);
      if (c.has("gendered_address") || c.has("slash_form")) lines.push(locale === "he" ? "- Address the customer neutrally (לך / אפשר + infinitive), no gendered verbs and no slash forms." : "- Address the customer neutrally.");
      if (c.has("self_gender")) lines.push("- Speak of yourself in your configured gender, or neutrally.");
      if (c.has("banned_phrase") || c.has("self_intro")) lines.push("- Drop stock phrases and self-introductions; answer directly.");
      if (c.has("dash")) lines.push("- No em or en dashes; use a comma or a full stop.");
      if (c.has("empty")) lines.push("- The reply was empty: write the message to the customer.");
    }
  }
  return lines.join("\n");
}

/** The safe fixed reply when the rewrite fails too: honest, short, hands the case on. */
export function safeFallback(locale: "he" | "en"): string {
  return locale === "he"
    ? "רגע, בודקים את זה עם הצוות ונחזור אליך כאן בהקדם."
    : "One moment, I'm checking this with the team and we'll get back to you here shortly.";
}

/**
 * The fallback for a product turn whose reply failed twice: the products this
 * turn's tools returned, with their store prices, never a handoff (a product
 * question is ours to answer; eval 2026-11-16 handed 30 of them to a person).
 */
export function groundedProductFallback(
  candidates: Array<{ title: string; price?: number | null; currency?: string | null; inventoryState?: string; priceOnSite?: boolean }>,
  locale: "he" | "en",
  cards: boolean,
): string | null {
  const shown = candidates.filter((c) => c?.title && c.inventoryState !== "out_of_stock").slice(0, 3);
  if (!shown.length) return null;
  if (cards) return locale === "he" ? "הנה מה שיש לנו שמתאים, אפשר לבחור מהכרטיסים." : "Here is what we have that fits, you can pick from the cards.";
  const cur = (c: string | null | undefined) => (c === "ILS" || !c ? "₪" : `${c} `);
  const line = (c: (typeof shown)[number]) => (c.price != null && !c.priceOnSite ? `${c.title}, ${cur(c.currency)}${c.price}` : c.title);
  return (locale === "he" ? "הנה מה שיש לנו שמתאים:\n" : "Here is what we have that fits:\n") + shown.map((c) => `• ${line(c)}`).join("\n");
}
