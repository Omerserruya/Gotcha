import { z } from "zod";
import { prisma, withHistoricalRecords } from "@chatcenter/shared";
import { structuredCall } from "./llm";
import { analyzeBrandVoice, renderVoiceStats, pairAgentReplies, renderSituationEvidence, type VoiceMessage } from "./brand-voice";
import {
  recordEvent,
  tenantPromptLanguage,
  languageDirective,
  type StageResult,
} from "./stage-utils";

/**
 * Turn how the business already writes into something an agent can write with.
 *
 * The knowledge stages answer "what does this business know". This one answers
 * "how does it sound", which is the half a generated reply gets wrong first. A
 * correct answer in the wrong voice still reads as a machine, and a business
 * with thirty thousand sent messages has long since decided its voice - which
 * emoji it reaches for, whether it opens with "היי" or "שלום", whether it signs
 * off, how long a message runs.
 *
 * ── Count first, ask second ──
 *
 * `analyzeBrandVoice` counts every outbound message: exact, free, and auditable.
 * The model is then given ONLY those counts - never the raw messages - and asked
 * to turn them into instructions. It therefore cannot describe a trait that did
 * not occur, and every line of the result traces back to a number stored
 * alongside it in `HistoricalImport.brandVoice`.
 *
 * ── Where the result goes ──
 *
 * `BusinessProfile.observedVoice`, which the company-context block renders into
 * every agent's system prompt. Not the knowledge base: retrieval is
 * query-matched, and "how do we sound" is not a question a customer asks, so a
 * KB document would sit there and never surface. Voice has to apply to every
 * reply, which means the prompt.
 *
 * ── The one thing it will not do ──
 *
 * Overwrite a human edit. If someone has corrected the voice by hand,
 * `observedVoiceEditedAt` is set and a later import leaves it alone. Silently
 * reverting a customer's correction is the fastest way to make them stop
 * correcting things.
 */

/**
 * Cut an over-long model string at the last whole line, else sentence, that
 * fits, instead of failing the schema. Prod GOTCHA 2026-11-10: a guidance a
 * little over its cap failed the parse, and the retry did too, so the whole
 * voice (summary, rules, situations) was thrown away for a few extra lines.
 */
export function trimToBoundary(value: unknown, max: number): unknown {
  if (typeof value !== "string") return value;
  const t = value.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const floor = Math.floor(max * 0.5);
  const line = head.lastIndexOf("\n");
  if (line >= floor) return head.slice(0, line).trimEnd();
  const sentence = Math.max(...[". ", "! ", "? ", "׃ "].map((m) => head.lastIndexOf(m)));
  if (sentence >= floor) return head.slice(0, sentence + 1).trimEnd();
  const space = head.lastIndexOf(" ");
  return (space >= floor ? head.slice(0, space) : head).trimEnd();
}
const capped = (max: number) => z.preprocess((v) => trimToBoundary(v, max), z.string().max(max));

/**
 * The guidance cap, and what the prompt asks for (below it, so trimming is the
 * exception). Every cap here equals packages/shared VOICE_LIMITS, which the
 * voice editor derives its maximum from; voice-limits-contract.test.ts pins
 * them (not imported at runtime: dev ai runs a baked shared).
 */
export const GUIDANCE_MAX = 1800;
export const GUIDANCE_ASK = 1400;

export const VoiceSchema = z.object({
  /**
   * The prompt block. Instructions to a writer, not a description of a brand -
   * "open with היי and the customer's name" is usable; "warm and approachable"
   * is a horoscope.
   */
  guidance: z
    .preprocess((v) => trimToBoundary(v, GUIDANCE_MAX), z.string().min(40).max(GUIDANCE_MAX))
    .describe("Direct instructions for writing as this business, as short dash-prefixed lines"),
  /** One line the reviewer can judge at a glance. */
  summary: z.preprocess((v) => trimToBoundary(v, 300), z.string().min(10).max(300)).describe("One sentence describing the voice"),
  /** The emoji an agent may actually use, drawn from the counted palette. */
  emojiPalette: z.preprocess((v) => (Array.isArray(v) ? v.slice(0, 10).map((e) => (typeof e === "string" ? e.trim().slice(0, 16) : e)) : v), z.array(z.string().max(16)).max(10)).describe("Emoji this business genuinely uses"),
  // 200 was too small and it failed the whole call twice, losing the guidance
  // while the counted evidence was already stored. This business opens with a
  // multi-line template that runs past 200 characters on its own, and the stage
  // now feeds the model complete messages to quote precisely so it stops
  // producing fragments - which makes a long example the expected case, not an
  // error. Trimmed rather than rejected if it still overruns.
  /** A greeting written in their voice, for the agent to open with. */
  greetingExample: capped(600).describe("One opening line in the business's own voice"),
  /** A sign-off in their voice. */
  closingExample: capped(600).describe("One closing line in the business's own voice"),
  /**
   * How the agents handle each moment (P4), as rules. Empty where the evidence
   * shows nothing. Never a quoted message: the runtime prompt carries rules only.
   */
  situations: z
    .object({
      opening: capped(300).default(""),
      price: capped(300).default(""),
      out_of_stock: capped(300).default(""),
      shipping: capped(300).default(""),
      complaint: capped(300).default(""),
      closing: capped(300).default(""),
    })
    .partial()
    .default({})
    .describe("One rule per situation, from the agents' own replies; empty when there is no evidence"),
});

export const VOICE_SYSTEM_PROMPT = `You are given MEASURED statistics about how one business writes to its customers: which emoji it uses and how often, how it opens and closes conversations, which phrases it repeats, and the length and rhythm of its messages. Every number was counted over the business's own sent messages.

Turn these numbers into instructions that another writer could follow to sound like this business.

RULES
- Use ONLY what the numbers show. If an emoji is not in the list, it is not in this brand's palette. If no closing line repeats, say that they usually do not sign off. Never add a trait because it is common for shops of this kind.
- Keep the guidance under ${GUIDANCE_ASK} characters: at most 12 dash-prefixed lines, the most important first. Each situation rule and the summary under 300 characters.
- Write the guidance as short dash-prefixed lines, each one actionable. "Open with היי followed by the customer's first name" is an instruction. "Friendly and warm" is not.
- Be specific about frequency. There is a real difference between emoji in 8% of messages and in 22%, and an agent told simply to "use emoji" will overdo it. State roughly how often, in the guidance.
- Match the length. If the median message is 3 words, say that replies are short and that long paragraphs would be out of character.
- Some counted lines are automated templates rather than a person writing (an away-message, an order confirmation). Say so when the numbers suggest it, and separate "how the automation sounds" from "how a person here sounds".
- If a phrase is a fragment of a longer canned message, quote the useful part rather than the fragment.
- greetingExample and closingExample must be written in the business's own language and style, reusing its actual words where the counts show them.
- situations: when the input has a section of customer -> agent pairs, write ONE rule per situation (opening, price, out_of_stock, shipping, complaint, closing) describing what these agents DO in it: what they say first, how long, which words, whether they ask anything. A rule, never a quoted message (two or three of their words are fine). Leave a situation empty when it has no evidence.
- Register is the brand's: warmth, endearments, emoji, slang, length, whatever the agents actually do. The grammatical gender of address is not: the business addresses customers neutrally, so describe endearments and warmth without turning them into gendered verbs.

Reply with ONLY a JSON object: {"guidance":"- ...\\n- ...","summary":"...","emojiPalette":["..."],"greetingExample":"...","closingExample":"...","situations":{"opening":"...","price":"...","out_of_stock":"...","shipping":"...","complaint":"...","closing":"..."}}`;

/** Below this there is not enough writing to characterise anyone. */
export const MIN_VOICE_MESSAGES = 50;

export async function runBrandVoiceStage(args: {
  tenantId: string;
  importId: string;
}): Promise<StageResult> {
  const { tenantId, importId } = args;
  const startedAt = Date.now();

  // The same population the knowledge stages read: conversations linked to a
  // customer of THIS business. An imported history also contains threads where
  // the owner was somebody else's customer, and while the owner's own messages
  // there are still their writing, the register is different and it is not the
  // voice we are trying to reproduce.
  const customers = await prisma.historicalCustomer.findMany({
    where: { importId, tenantId, conversationId: { not: null } },
    select: { conversationId: true },
  });
  const conversationIds = customers.map((c) => c.conversationId!).filter(Boolean);

  if (conversationIds.length === 0) {
    await recordEvent(importId, "BRAND_VOICE", "SKIPPED", "no conversations to read", {});
    return { ok: true, detail: { skipped: "no conversations" } };
  }

  const outbound = await withHistoricalRecords(() =>
    prisma.message.findMany({
      where: {
        tenantId,
        conversationId: { in: conversationIds },
        // Outbound only. This is the same direction rule the knowledge
        // extractor enforces: everything inbound is somebody else's voice.
        direction: "OUTBOUND",
        NOT: { body: "" },
      },
      select: { body: true, conversationId: true, createdAt: true },
    }),
  );

  const messages: VoiceMessage[] = outbound.map((m) => ({
    body: m.body,
    conversationId: m.conversationId!,
    at: m.createdAt,
  }));
  // The customer message before each reply: the per-situation evidence (P4).
  const inbound = await withHistoricalRecords(() =>
    prisma.message.findMany({
      where: { tenantId, conversationId: { in: conversationIds }, direction: "INBOUND", NOT: { body: "" } },
      select: { body: true, conversationId: true, createdAt: true },
    }),
  );
  const pairs = pairAgentReplies([
    ...messages.map((m) => ({ ...m, direction: "OUTBOUND" as const })),
    ...inbound.map((m) => ({ body: m.body, conversationId: m.conversationId!, at: m.createdAt, direction: "INBOUND" as const })),
  ]);
  const stats = analyzeBrandVoice(messages, 15);

  if (stats.messagesAnalyzed < MIN_VOICE_MESSAGES) {
    await recordEvent(importId, "BRAND_VOICE", "SKIPPED", "too little writing to characterise", {
      messagesAnalyzed: stats.messagesAnalyzed,
      required: MIN_VOICE_MESSAGES,
    });
    return { ok: true, detail: { skipped: "too few messages", messagesAnalyzed: stats.messagesAnalyzed } };
  }

  // The counted evidence is stored whether or not the model succeeds. It is the
  // durable artifact; the guidance is a rendering of it.
  await prisma.historicalImport.update({
    where: { id: importId },
    data: { brandVoice: stats as unknown as object },
  });

  const language = await tenantPromptLanguage(tenantId);
  const voice = await structuredCall({
    tenantId,
    importId,
    schema: VoiceSchema,
    system: VOICE_SYSTEM_PROMPT + languageDirective(language),
    user: `${renderVoiceStats(stats)}\n\n${renderSituationEvidence(pairs)}`,
    feature: "historical_brand_voice",
    maxTokens: 2000,
  });

  if (!voice) {
    await recordEvent(importId, "BRAND_VOICE", "PARTIAL", "counted the evidence but could not render guidance", {
      messagesAnalyzed: stats.messagesAnalyzed,
    });
    return { ok: true, detail: { stats: true, guidance: false } };
  }

  await prisma.historicalImport.update({
    where: { id: importId },
    data: { brandVoice: { ...stats, ...voice } as unknown as object },
  });

  const applied = await applyObservedVoice(tenantId, voice);

  await recordEvent(
    importId,
    "BRAND_VOICE",
    "SUCCESS",
    null,
    {
      messagesAnalyzed: stats.messagesAnalyzed,
      conversationsAnalyzed: stats.conversationsAnalyzed,
      emojiPalette: stats.emojis.length,
      appliedToProfile: applied,
    },
    Date.now() - startedAt,
  );

  return { ok: true, detail: { messagesAnalyzed: stats.messagesAnalyzed, appliedToProfile: applied } };
}

/**
 * Write the voice where every agent will read it, unless a person has edited it.
 *
 * Returns false when the profile is missing or a human edit is being preserved,
 * so the event row records which of the two happened.
 */
async function applyObservedVoice(
  tenantId: string,
  voice: z.infer<typeof VoiceSchema>,
): Promise<boolean> {
  const profile = await prisma.businessProfile.findUnique({
    where: { tenantId },
    select: { id: true, observedVoiceEditedAt: true },
  });
  if (!profile) return false;
  if (profile.observedVoiceEditedAt) return false;

  await prisma.businessProfile.update({
    where: { tenantId },
    data: { observedVoice: renderObservedVoice(voice) },
  });
  return true;
}

/**
 * The stored prompt text.
 *
 * Assembled here rather than taken as one blob from the model so the shape is
 * fixed and the examples are always labelled as examples. A model handed a free
 * text field eventually returns a paragraph about brand values, and that would
 * land in every system prompt this tenant runs.
 */
export function renderObservedVoice(voice: {
  guidance: string;
  summary: string;
  emojiPalette: string[];
  greetingExample?: string;
  closingExample?: string;
  situations?: Partial<Record<"opening" | "price" | "out_of_stock" | "shipping" | "complaint" | "closing", string>>;
}): string {
  // Rules only (2026-10-25, Omer): the example opening and closing were real
  // lines quoted into every prompt, and the agent opened every chat with them.
  // They stay in the schema as the learner's own working, never rendered.
  const lines = [voice.summary.trim(), "", voice.guidance.trim()];
  if (voice.emojiPalette.length) {
    lines.push(`- Emoji this business actually uses: ${voice.emojiPalette.join(" ")}. Use only these, and only as often as the guidance says.`);
  }
  const LABEL: Record<string, string> = {
    opening: "Opening a conversation", price: "A price question", out_of_stock: "Out of stock",
    shipping: "Shipping and delivery", complaint: "A complaint", closing: "The close",
  };
  const situations = Object.entries(voice.situations ?? {}).filter(([, v]) => typeof v === "string" && v.trim());
  if (situations.length) {
    lines.push("", "How this business handles each moment (its agents' practice, as rules):");
    for (const [k, v] of situations) lines.push(`- ${LABEL[k] ?? k}: ${String(v).trim()}`);
  }
  return lines.join("\n");
}
