import { z } from "zod";
import { prisma, withHistoricalRecords } from "@chatcenter/shared";
import { structuredCall } from "./llm";
import { analyzeBrandVoice, renderVoiceStats, type VoiceMessage } from "./brand-voice";
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

const VoiceSchema = z.object({
  /**
   * The prompt block. Instructions to a writer, not a description of a brand -
   * "open with היי and the customer's name" is usable; "warm and approachable"
   * is a horoscope.
   */
  guidance: z
    .string()
    .min(40)
    .max(1800)
    .describe("Direct instructions for writing as this business, as short dash-prefixed lines"),
  /** One line the reviewer can judge at a glance. */
  summary: z.string().min(10).max(300).describe("One sentence describing the voice"),
  /** The emoji an agent may actually use, drawn from the counted palette. */
  emojiPalette: z.array(z.string()).max(10).describe("Emoji this business genuinely uses"),
  /** A greeting written in their voice, for the agent to open with. */
  greetingExample: z.string().max(200).describe("One opening line in the business's own voice"),
  /** A sign-off in their voice. */
  closingExample: z.string().max(200).describe("One closing line in the business's own voice"),
});

const SYSTEM_PROMPT = `You are given MEASURED statistics about how one business writes to its customers: which emoji it uses and how often, how it opens and closes conversations, which phrases it repeats, and the length and rhythm of its messages. Every number was counted over the business's own sent messages.

Turn these numbers into instructions that another writer could follow to sound like this business.

RULES
- Use ONLY what the numbers show. If an emoji is not in the list, it is not in this brand's palette. If no closing line repeats, say that they usually do not sign off. Never add a trait because it is common for shops of this kind.
- Write the guidance as short dash-prefixed lines, each one actionable. "Open with היי followed by the customer's first name" is an instruction. "Friendly and warm" is not.
- Be specific about frequency. There is a real difference between emoji in 8% of messages and in 22%, and an agent told simply to "use emoji" will overdo it. State roughly how often, in the guidance.
- Match the length. If the median message is 3 words, say that replies are short and that long paragraphs would be out of character.
- Some counted lines are automated templates rather than a person writing (an away-message, an order confirmation). Say so when the numbers suggest it, and separate "how the automation sounds" from "how a person here sounds".
- If a phrase is a fragment of a longer canned message, quote the useful part rather than the fragment.
- greetingExample and closingExample must be written in the business's own language and style, reusing its actual words where the counts show them.

Reply with ONLY a JSON object: {"guidance":"- ...\\n- ...","summary":"...","emojiPalette":["..."],"greetingExample":"...","closingExample":"..."}`;

/** Below this there is not enough writing to characterise anyone. */
const MIN_MESSAGES = 50;

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
  const stats = analyzeBrandVoice(messages, 15);

  if (stats.messagesAnalyzed < MIN_MESSAGES) {
    await recordEvent(importId, "BRAND_VOICE", "SKIPPED", "too little writing to characterise", {
      messagesAnalyzed: stats.messagesAnalyzed,
      required: MIN_MESSAGES,
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
    system: SYSTEM_PROMPT + languageDirective(language),
    user: renderVoiceStats(stats),
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
  greetingExample: string;
  closingExample: string;
}): string {
  const lines = [voice.summary.trim(), "", voice.guidance.trim()];
  if (voice.emojiPalette.length) {
    lines.push(`- Emoji this business actually uses: ${voice.emojiPalette.join(" ")}. Use only these, and only as often as the guidance says.`);
  }
  if (voice.greetingExample.trim()) {
    lines.push(`- Example opening in their voice: "${voice.greetingExample.trim()}"`);
  }
  if (voice.closingExample.trim()) {
    lines.push(`- Example closing in their voice: "${voice.closingExample.trim()}"`);
  }
  return lines.join("\n").trim();
}
