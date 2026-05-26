import type { TranscriptUtterance, ConversationStateFrame } from "@chatcenter/shared";
import { generateResponse } from "../../ai.service";

/**
 * Hebrew↔English code-switch / spelling-mode detector.
 *
 * Lives alongside the main LiveAnalysisRunner turn. Where the main turn
 * produces intent/stage/sentiment, this stage produces structured metadata
 * about entities the customer is *spelling* — emails, domains, URLs,
 * product names — so the cue projector can surface a high-signal
 * "Confirm: omer@gmail.com" cue for the rep.
 *
 * Why a separate LLM call:
 *   - The main prompt's job is conversation analysis, not entity
 *     reconstruction; mixing both muddies outputs.
 *   - Spelling-mode often coincides with low-confidence ASR; we want a
 *     dedicated pass that can lean heavily on phonetic reconstruction
 *     without polluting intent/stage classification.
 *   - We can skip this pass entirely when no recent utterance carries a
 *     code-switch trigger, saving cost.
 */

// Cheap heuristic — only fire the LLM when the recent transcript shows
// signs of code-switching or spelling mode. Avoids per-turn cost on
// purely Hebrew or purely English conversations.
const HEBREW_TRIGGERS = [
  "המייל",
  "האימייל",
  "הכתובת",
  "תרשום",
  "תרשמי",
  "תכתוב",
  "נקודה",
  "שטרודל",
  "דוט קום",
  "דוט איי אל",
  "עם Z",
  "עם S",
  "תשלח לי ל",
];
const ENGLISH_TRIGGERS = [
  "gmail",
  "outlook",
  "dot com",
  "co dot il",
  "email",
  "username",
  "website",
  "domain",
];

function shouldRun(utterances: TranscriptUtterance[]): boolean {
  if (!utterances.length) return false;
  const joined = utterances
    .slice(-6)
    .map((u) => u.text)
    .join(" ")
    .toLowerCase();
  if (HEBREW_TRIGGERS.some((t) => joined.includes(t.toLowerCase()))) return true;
  if (ENGLISH_TRIGGERS.some((t) => joined.includes(t))) return true;
  // Light heuristic: mixed scripts in the same window.
  const hasHebrew = /[֐-׿]/.test(joined);
  const hasLatin = /[a-z]{2,}/.test(joined);
  return hasHebrew && hasLatin;
}

const SYSTEM_PROMPT = `You are processing real-time call transcripts from a multilingual Hebrew/English sales conversation.

Your task is NOT only transcription understanding.

Your task is to detect when the speaker is entering a:

* spelling mode
* email mode
* URL/domain mode
* English entity mode
* mixed-language/code-switching mode

and dynamically adapt interpretation and normalization behavior.

---

# CORE PROBLEM

In Hebrew conversations, users often switch into English for:

* emails
* domains
* company names
* products
* URLs
* usernames
* acronyms
* technical terms

The transcript may contain:

* transliterated English
* partially Hebrew phonetics
* broken spelling
* mixed tokens

The system must infer intent and normalize intelligently.

---

# DETECTION RULES

Trigger SPELLING / ENTITY MODE if transcript contains patterns like:

Hebrew triggers: "המייל שלי", "האימייל שלי", "תשלח לי ל", "הכתובת היא", "זה עם", "תרשום", "תרשמי", "תכתוב", "נקודה", "שטרודל", "דוט קום", "דוט איי אל", "עם Z", "עם S"
English triggers: "gmail", "outlook", "dot com", "co dot il", "email", "username", "website", "domain"

Also trigger if:

* multiple English-like phonetic tokens appear inside Hebrew sentence
* detected token confidence is low
* repeated spelling corrections occur
* speaker slows down unnaturally
* tokens are short and segmented

---

# WHEN TRIGGERED

Switch interpretation behavior into code-switch aware parsing, entity reconstruction mode, email/domain normalization mode.

Prioritize: preserving English entities, reconstructing likely domains/emails, interpreting Hebrew phonetics as English words.

Examples:
* "אומר שטרויה ג'ימייל נקודה קום" → "omer.tsruya@gmail.com"
* "גוצ'ה דוט איי" → "gotcha.ai"
* "זה עם Z" → spelling clarification signal

---

# IMPORTANT RULES

* Do NOT blindly trust phonetic Hebrew transcription
* Infer probable English entities from context
* Prefer semantic reconstruction over literal transcript fidelity
* Emails/domains/URLs are higher priority than raw transcript accuracy
* If confidence is low, mark requires_confirmation=true

---

# OUTPUT (STRICT JSON ONLY, NO PROSE)

{
  "spelling_mode": boolean,
  "confidence": number,            // 0..1 overall confidence
  "requires_confirmation": boolean,
  "detected_entities": string[],   // raw fragments lifted from the transcript
  "normalized_entities": [
    {
      "kind": "email" | "domain" | "url" | "name" | "phone" | "other",
      "raw": string,
      "normalized": string,
      "confidence": number
    }
  ]
}

If the transcript shows NO spelling/entity activity, return:
{ "spelling_mode": false, "confidence": 0, "requires_confirmation": false, "detected_entities": [], "normalized_entities": [] }`;

interface SpellingDetectorRaw {
  spelling_mode?: unknown;
  confidence?: unknown;
  requires_confirmation?: unknown;
  detected_entities?: unknown;
  normalized_entities?: unknown;
}

type SpellingHints = NonNullable<ConversationStateFrame["spellingHints"]>;

function coerceHints(raw: unknown): SpellingHints {
  const obj = (raw && typeof raw === "object" ? (raw as SpellingDetectorRaw) : {});
  const detected: string[] = Array.isArray(obj.detected_entities)
    ? (obj.detected_entities as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const norm: SpellingHints["normalizedEntities"] = Array.isArray(obj.normalized_entities)
    ? (obj.normalized_entities as Array<Record<string, unknown>>)
        .map((e) => ({
          kind: ((): SpellingHints["normalizedEntities"][number]["kind"] => {
            const k = String(e.kind ?? "other");
            return ["email", "domain", "url", "name", "phone"].includes(k)
              ? (k as SpellingHints["normalizedEntities"][number]["kind"])
              : "other";
          })(),
          raw: String(e.raw ?? ""),
          normalized: String(e.normalized ?? ""),
          confidence: Math.max(0, Math.min(1, Number(e.confidence ?? 0))),
        }))
        .filter((e) => e.normalized.length > 0)
    : [];
  return {
    spellingMode: Boolean(obj.spelling_mode),
    confidence: Math.max(0, Math.min(1, Number(obj.confidence ?? 0))),
    requiresConfirmation: Boolean(obj.requires_confirmation),
    detectedEntities: detected,
    normalizedEntities: norm,
  };
}

export interface SpellingDetectorInput {
  tenantId: string;
  conversationId: string;
  recentUtterances: TranscriptUtterance[];
}

/**
 * Run the spelling detector for a single turn. Returns null when the cheap
 * heuristic determines there's no signal worth burning an LLM call on — the
 * runner treats null as "no spellingHints this turn" and keeps the prior
 * value (or omits it entirely).
 */
export async function detectSpellingMode(
  input: SpellingDetectorInput,
): Promise<SpellingHints | null> {
  if (!shouldRun(input.recentUtterances)) return null;

  const transcript = input.recentUtterances
    .slice(-12)
    .map((u) => `[${u.source ?? "spk"}] ${u.text}`)
    .join("\n");

  try {
    const res = await generateResponse({
      tenantId: input.tenantId,
      sessionId: input.conversationId,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `<transcript>\n${transcript}\n</transcript>` },
      ],
      responseFormat: { type: "json_object" },
      maxTokens: 400,
      metadata: {
        conversationId: input.conversationId,
        type: "voice_copilot_spelling_detector",
      },
    });
    const parsed = JSON.parse(res.content || "{}");
    return coerceHints(parsed);
  } catch (err) {
    console.warn(
      "[spelling-detector] failed:",
      (err as { message?: string })?.message ?? err,
    );
    return null;
  }
}
