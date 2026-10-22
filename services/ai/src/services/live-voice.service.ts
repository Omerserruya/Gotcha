/**
 * Learn this business's voice from the writing it has already done HERE, with
 * no historical import involved.
 *
 * The import pipeline's brand-voice stage does this over an uploaded history.
 * Most tenants never import one, so for them the voice box on the workspace
 * screen could only ever be typed by hand. This runs the same count-first
 * analysis over live conversations, on demand.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE ONE THING THAT MAKES THIS DIFFERENT FROM THE IMPORT PATH
 *
 * An imported history is, by construction, writing by people at the business.
 * A LIVE conversation is not. On this deployment's own database, live outbound
 * messages break down like this:
 *
 *     AI Bot                      178
 *     Maya (an AI agent's name)     1
 *     a human agent's email         1
 *
 * So 179 of 180 outbound messages were written by the product, not by the
 * business. Feeding those back in as "how this business writes" would learn
 * the model's own register, store it in `BusinessProfile.observedVoice`, and
 * render it into the system prompt of every agent - which would then produce
 * more of the same. The customer would be shown that as their own voice,
 * learned from their own messages.
 *
 * That is the whole risk in this feature, and it is why the population is
 * chosen by an ALLOW-list rather than by excluding the senders we happen to
 * know about today.
 *
 * ── The discriminator, and why it is trustworthy in the direction that matters
 *
 * `Message.senderName` is the only field that records who wrote an outbound
 * message: there is no author id and no "sent by AI" flag. It is free text, so
 * a deny-list would be wrong the moment somebody adds a sender. But every path
 * that writes it is auditable, and they divide cleanly:
 *
 *   A PERSON typing        `req.user!.email`  - the inbox send, the contact
 *                          send, the Shopify live-chat agent send. Always an
 *                          email address, because it is taken from the signed-in
 *                          user.
 *   THE PRODUCT writing    "AI Bot" (the bot), "System" (auto-greeting,
 *                          scheduled), "Broadcast" (campaigns), or the AI
 *                          agent's own display name - "Maya", which is exactly
 *                          as human-looking as a person's name and is the
 *                          reason a name-based rule cannot work.
 *
 * So: an `@` means a signed-in human was the author. No machine path puts an
 * email in this field. The failure mode of this rule is EXCLUDING human
 * writing (an integration that one day posts under a plain name), which costs
 * a smaller corpus. The failure mode it prevents is INCLUDING machine writing,
 * which corrupts the voice silently and permanently. Those are not symmetric,
 * and the rule is pointed at the asymmetry.
 *
 * ── What is deliberately not done
 *
 * No fallback when there is too little human writing. The honest answer to
 * "learn my tone" from a business whose people have written four messages is
 * that there is nothing to learn from yet, with the two counts shown so they
 * can see why. Characterising someone from four messages, or quietly topping
 * the corpus up with the bot's own output, would both produce a confident
 * answer about a voice nobody has.
 * ════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@chatcenter/shared";
import { structuredCall } from "./historical-intelligence/llm";
import {
  analyzeBrandVoice,
  renderVoiceStats,
  type VoiceMessage,
} from "./historical-intelligence/brand-voice";
import {
  VoiceSchema,
  VOICE_SYSTEM_PROMPT,
  MIN_VOICE_MESSAGES,
  renderObservedVoice,
} from "./historical-intelligence/brand-voice.stage";
import { tenantPromptLanguage, languageDirective } from "./historical-intelligence/stage-utils";

export type LearnVoiceStatus =
  | "learned"
  | "too_little_writing"
  | "edited_by_hand"
  | "no_profile"
  | "model_unavailable";

export interface LearnVoiceResult {
  status: LearnVoiceStatus;
  /** Outbound messages a signed-in person wrote. The corpus. */
  humanWritten: number;
  /** Outbound messages the product wrote. Reported, never analysed. */
  machineWritten: number;
  required: number;
  guidance?: string;
  summary?: string;
  conversationsAnalysed?: number;
}

/** How many outbound messages to weigh, most recent first. */
const MAX_CORPUS = 2000;

/**
 * Count live outbound writing, split by author.
 *
 * `origin: "LIVE"` is stated explicitly. The shared client injects exactly
 * this filter into bulk Message queries anyway, but naming it SUPPRESSES that
 * injection (`mentionsOrigin`) and applies it by hand instead - the same
 * result, and it stays the same result if the default ever changes. This path
 * must never read imported records: they belong to the import stage, which
 * stores its evidence on the import row.
 */
async function collectLiveWriting(tenantId: string): Promise<{
  human: VoiceMessage[];
  machineWritten: number;
}> {
  const base = {
    tenantId,
    origin: "LIVE" as const,
    direction: "OUTBOUND" as const,
    NOT: { body: "" },
    // A rehearsal is not the business talking to a customer. Sandbox rows carry
    // `isTest: false`, so the external-id prefix is the predicate that actually
    // catches them - filtering on `isTest` alone would let every setup
    // rehearsal into the corpus.
    conversation: {
      is: {
        isTest: false,
        NOT: { customerExternalId: { startsWith: "sandbox:" } },
      },
    },
  };

  // The machine count is TOTAL MINUS HUMAN rather than a negated sender
  // filter. Spreading `base` and adding a second `NOT` would have replaced the
  // `NOT: { body: "" }` already in it, and Prisma's NOT-with-a-list is easy to
  // read as the wrong one of "not both" and "neither". Subtraction has one
  // reading, and it also guarantees the two numbers sum to the total, which is
  // the property the screen's sentence depends on.
  const [total, human, humanCount] = await Promise.all([
    prisma.message.count({ where: base }),
    prisma.message.findMany({
      where: { ...base, senderName: { contains: "@" } },
      select: { body: true, conversationId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: MAX_CORPUS,
    }),
    prisma.message.count({ where: { ...base, senderName: { contains: "@" } } }),
  ]);

  return {
    human: human
      .filter((m) => m.conversationId)
      .map((m) => ({ body: m.body, conversationId: m.conversationId!, at: m.createdAt })),
    machineWritten: total - humanCount,
  };
}

/**
 * Learn and apply, or explain why not.
 *
 * REFUSES TO OVERWRITE A HAND-EDITED VOICE, and says so rather than returning
 * a success that changed nothing. The existing revert - saving an empty
 * guidance through `PUT /api/workspace/voice` - clears the edit stamp and
 * hands the box back to the learner, so there is a way through that the person
 * chooses deliberately. Overwriting on a click would throw away a correction
 * somebody made on purpose; doing nothing while reporting success would be a
 * button that lies.
 */
export async function learnVoiceFromLiveWriting(tenantId: string): Promise<LearnVoiceResult> {
  const profile = await prisma.businessProfile.findUnique({
    where: { tenantId },
    select: { id: true, observedVoiceEditedAt: true },
  });

  const { human, machineWritten } = await collectLiveWriting(tenantId);
  const counts = { humanWritten: human.length, machineWritten, required: MIN_VOICE_MESSAGES };

  if (!profile) return { status: "no_profile", ...counts };
  if (profile.observedVoiceEditedAt) return { status: "edited_by_hand", ...counts };

  // Checked on the raw corpus before the analyser runs, and again on what the
  // analyser actually counted: `analyzeBrandVoice` drops messages it cannot
  // read, so a corpus of 60 can become an analysed 12.
  if (human.length < MIN_VOICE_MESSAGES) return { status: "too_little_writing", ...counts };

  const stats = analyzeBrandVoice(human, 15);
  if (stats.messagesAnalyzed < MIN_VOICE_MESSAGES) {
    return { status: "too_little_writing", ...counts, humanWritten: stats.messagesAnalyzed };
  }

  const language = await tenantPromptLanguage(tenantId);
  const voice = await structuredCall({
    tenantId,
    schema: VoiceSchema,
    system: VOICE_SYSTEM_PROMPT + languageDirective(language),
    user: renderVoiceStats(stats),
    // Its own feature name, not the import stage's. These are two different
    // populations and the cost of each should be answerable separately.
    feature: "live_brand_voice",
    maxTokens: 2000,
  });

  if (!voice) return { status: "model_unavailable", ...counts };

  const guidance = renderObservedVoice(voice);

  // `observedVoiceEditedAt` is left null on purpose: this is a learned voice,
  // not an edit. The workspace GET reads exactly that to tell "learned" from
  // "edited", and stamping it here would make the next learn refuse itself.
  await prisma.businessProfile.update({
    where: { tenantId },
    data: { observedVoice: guidance },
  });

  return {
    status: "learned",
    ...counts,
    humanWritten: stats.messagesAnalyzed,
    guidance,
    summary: voice.summary,
    conversationsAnalysed: stats.conversationsAnalyzed,
  };
}
