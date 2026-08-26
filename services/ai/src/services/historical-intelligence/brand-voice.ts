/**
 * How this business actually writes.
 *
 * The knowledge stages answer "what does this business know". This one answers
 * "how does it sound", which is the half a generated reply gets wrong first. A
 * correct answer in the wrong voice still reads as a robot, and every business
 * that has ever written 30,000 messages has already decided its voice - which
 * emoji it reaches for, whether it opens with "היי" or "שלום", whether it signs
 * off, how long a message runs, whether it uses the customer's name.
 *
 * ── Why the counting is deterministic ──
 *
 * A model asked "what is this brand's voice" over a sample of messages will
 * produce a confident paragraph that is mostly the model's prior about how
 * friendly shops write. The actual distribution is countable: emoji frequency,
 * opening lines, closing lines, repeated phrases, message length. Counting
 * every outbound message is cheaper than sampling a few hundred into a prompt,
 * it is exact, and it is auditable - every claim in the resulting brand-voice
 * document traces to a number. The model is used once, at the end, to turn
 * those counts into usable guidance, and it is given the counts rather than the
 * raw messages so it cannot invent a trait that never occurred.
 *
 * ── Outbound only ──
 *
 * Only messages the business SENT. This is the same direction rule the
 * knowledge extractor enforces, for the same reason: an imported history is
 * full of text this business received, and that is somebody else's voice.
 */

/**
 * The platform's stand-in for content that is not text.
 *
 * A WhatsApp image arrives with no body, and the adapter stores
 * `[image message]` so the thread still reads in order. Those strings are ours,
 * not the business's - counting them put "[media_placeholder message]" at the
 * top of this shop's signature phrases at 41% and made it their most common
 * closing line. Anything that is ONLY a placeholder is dropped; a caption
 * alongside one is kept, because the caption is real writing.
 */
const PLACEHOLDER_ONLY = /^\s*\[(?:[a-z_]+ message|Location:[^\]]*)\]\s*$/i;

export function isPlaceholder(body: string): boolean {
  return PLACEHOLDER_ONLY.test(body || "");
}

/** An emoji, including ZWJ sequences, skin-tone modifiers and keycaps. */
const EMOJI_RE =
  /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️|‍\p{Extended_Pictographic})*/gu;

/**
 * Words too common to characterise anyone. Hebrew first, since that is what
 * these histories are in; the English set covers mixed-language shops.
 */
const STOPWORDS = new Set([
  "של", "את", "לא", "כן", "אני", "זה", "עם", "על", "יש", "אם", "או", "גם", "כל",
  "מה", "לי", "לך", "הוא", "היא", "אנחנו", "אתם", "הם", "היה", "היי", "אבל",
  "רק", "אז", "כי", "עד", "אחרי", "לפני", "בין", "כמו", "הזה", "הזאת", "שלנו",
  "שלך", "שלי", "בבקשה", "תודה", "אפשר", "צריך", "יכול", "ניתן", "בכל", "אין",
  "the", "a", "an", "and", "or", "is", "are", "to", "of", "in", "for", "on",
  "you", "we", "it", "that", "this", "with", "your", "our", "be", "can", "will",
  "i", "at", "as", "by", "from", "have", "has", "not", "but", "if", "so",
]);

export interface VoiceMessage {
  body: string;
  /** Position in its conversation, so openers and closers can be identified. */
  conversationId: string;
  at: Date;
}

export interface Counted {
  value: string;
  count: number;
  /** Share of the population this was counted over, 0-1. */
  share: number;
}

export interface BrandVoiceStats {
  messagesAnalyzed: number;
  conversationsAnalyzed: number;

  /** The emoji palette, most-used first. */
  emojis: Counted[];
  /** Share of outbound messages containing at least one emoji. */
  emojiMessageShare: number;
  /** Mean emoji per message, counted over messages that have any. */
  emojiPerEmojiMessage: number;

  /** How a conversation is opened: first business message, normalized head. */
  openers: Counted[];
  /** How it is closed: last business message, normalized head. */
  closers: Counted[];

  /** Repeated multi-word phrases that are not stopword filler. */
  signaturePhrases: Counted[];
  /** Single words this business reaches for far more than filler. */
  signatureWords: Counted[];

  /** Length, in words, of an outbound message. */
  medianWords: number;
  meanWords: number;
  /** Share of messages that are a single line under five words. */
  shortReplyShare: number;

  questionShare: number;
  exclamationShare: number;
  /** Share of messages containing a "?"-free directive - "tell me", "send me". */
  politeRequestShare: number;
}

/**
 * Count everything countable about how this business writes.
 *
 * Pure, synchronous and allocation-bounded: it walks the messages once per
 * metric family and keeps only the top slice of each distribution, so a
 * 37,000-message history costs a few megabytes rather than a copy of itself.
 */
export function analyzeBrandVoice(messages: VoiceMessage[], topN = 12): BrandVoiceStats {
  const total = messages.length;
  const empty: BrandVoiceStats = {
    messagesAnalyzed: 0,
    conversationsAnalyzed: 0,
    emojis: [],
    emojiMessageShare: 0,
    emojiPerEmojiMessage: 0,
    openers: [],
    closers: [],
    signaturePhrases: [],
    signatureWords: [],
    medianWords: 0,
    meanWords: 0,
    shortReplyShare: 0,
    questionShare: 0,
    exclamationShare: 0,
    politeRequestShare: 0,
  };
  if (total === 0) return empty;

  // ── Per-message pass ──
  const emojiCounts = new Map<string, number>();
  const wordCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  const lengths: number[] = [];
  let messagesWithEmoji = 0;
  let emojiTotal = 0;
  let questions = 0;
  let exclamations = 0;
  let politeRequests = 0;
  let shortReplies = 0;
  let scanned = 0;

  for (const m of messages) {
    const body = (m.body || "").trim();
    if (!body || isPlaceholder(body)) continue;

    const found = body.match(EMOJI_RE);
    if (found && found.length) {
      messagesWithEmoji += 1;
      emojiTotal += found.length;
      for (const e of found) bump(emojiCounts, e);
    }

    if (body.includes("?") || body.includes("؟")) questions += 1;
    if (body.includes("!")) exclamations += 1;
    if (/\b(תשלח|תשלחי|שלח|שלחי|תכתוב|תכתבי|צרף|צרפי|send me|let me know)\b/.test(body)) {
      politeRequests += 1;
    }

    const words = tokenize(body);
    lengths.push(words.length);
    if (words.length > 0 && words.length < 5 && !body.includes("\n")) shortReplies += 1;

    for (const w of words) {
      if (w.length < 2 || STOPWORDS.has(w)) continue;
      bump(wordCounts, w);
    }
    // Up to 6 words. Short grams alone cannot express a canned paragraph: a
    // 60-word auto-reply shatters into a dozen 3-grams of near-identical count
    // that no containment rule can merge, because they OVERLAP rather than
    // nest ("שיצרת קשר עם" and "קשר עם מינרז" contain each other not at all).
    // Counting the longer window lets the full phrase appear and swallow its
    // own fragments in collapseNested.
    for (let n = 2; n <= 6; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        // A phrase made only of filler is filler.
        if (gram.every((w) => STOPWORDS.has(w))) continue;
        bump(phraseCounts, gram.join(" "));
      }
    }

    // A six-word window over tens of thousands of messages is millions of
    // distinct grams, nearly all seen once. Sweeping the singletons keeps the
    // map proportional to what is actually repeated. Safe because a phrase
    // that survives the sweep only ever gains count afterwards, and one that
    // does not was never going to clear the min-count floor.
    scanned += 1;
    if (scanned % 2000 === 0 && phraseCounts.size > 400_000) {
      for (const [k, v] of phraseCounts) if (v < 2) phraseCounts.delete(k);
    }
  }

  // ── Openers and closers ──
  //
  // Grouped by conversation rather than taken from a flat list: the first
  // message of the whole export is one greeting, the first message of each
  // conversation is the greeting habit.
  const byConversation = new Map<string, VoiceMessage[]>();
  for (const m of messages) {
    if (!(m.body || "").trim() || isPlaceholder(m.body)) continue;
    const arr = byConversation.get(m.conversationId);
    if (arr) arr.push(m);
    else byConversation.set(m.conversationId, [m]);
  }
  const openerCounts = new Map<string, number>();
  const closerCounts = new Map<string, number>();
  for (const [, msgs] of byConversation) {
    msgs.sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = normalizeHead(msgs[0].body);
    if (first) bump(openerCounts, first);
    if (msgs.length > 1) {
      const last = normalizeHead(msgs[msgs.length - 1].body);
      if (last) bump(closerCounts, last);
    }
  }

  const counted = messages.filter((m) => (m.body || "").trim() && !isPlaceholder(m.body)).length || 1;
  const conversations = byConversation.size || 1;

  return {
    messagesAnalyzed: counted,
    conversationsAnalyzed: byConversation.size,
    emojis: top(emojiCounts, topN, counted),
    emojiMessageShare: round(messagesWithEmoji / counted),
    emojiPerEmojiMessage: messagesWithEmoji ? round(emojiTotal / messagesWithEmoji) : 0,
    // A greeting used once is not a habit; requiring two keeps prices and
    // stray one-line replies out of the list of "how they open".
    openers: top(openerCounts, topN, conversations, 2),
    closers: top(closerCounts, topN, conversations, 2),
    // Over-collect, then collapse, so removing fragments does not leave gaps.
    signaturePhrases: collapseNested(top(phraseCounts, topN * 12, counted, 3)).slice(0, topN),
    signatureWords: top(wordCounts, topN, counted, 3),
    medianWords: median(lengths),
    meanWords: round(lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1)),
    shortReplyShare: round(shortReplies / counted),
    questionShare: round(questions / counted),
    exclamationShare: round(exclamations / counted),
    politeRequestShare: round(politeRequests / counted),
  };
}

// ── helpers ──

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>, n: number, population: number, minCount = 1): Counted[] {
  return [...map.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([value, count]) => ({ value, count, share: round(count / (population || 1)) }));
}

/**
 * Reassemble n-grams back into the phrases they were cut from.
 *
 * A canned paragraph counted as 6-grams comes back as a dozen entries of
 * near-identical count that no containment rule can merge, because consecutive
 * windows of the same length OVERLAP rather than nest: "תודה שיצרת קשר עם מינרז
 * איך" and "שיצרת קשר עם מינרז איך אפשר" contain each other not at all. On the
 * first run that filled eleven of the fifteen signature-phrase slots with one
 * auto-reply and pushed the actual signature phrases off the list.
 *
 * Two passes. First, chain: where one gram's tail equals another's head and
 * they occur about as often, they are the same phrase seen through a sliding
 * window, so splice them. Repeat until nothing merges, and the full sentence
 * reappears. Then swallow: drop what is now contained in a longer phrase of
 * similar count, which removes the fragments the chaining did not consume.
 *
 * The count of a merged phrase is the MINIMUM of its parts - it cannot have
 * occurred more often than its rarest piece.
 */
const MAX_PHRASE_WORDS = 30;

function collapseNested(grams: Counted[]): Counted[] {
  interface Phrase { words: string[]; count: number; share: number }
  let items: Phrase[] = grams.map((g) => ({ words: g.value.split(" "), count: g.count, share: g.share }));

  // ── chain overlapping windows ──
  for (let guard = 0; guard < 400; guard++) {
    let mergedAny = false;
    outer: for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const a = items[i];
        const b = items[j];
        // Only windows onto the same phrase occur about as often. A genuinely
        // separate phrase that happens to share words does not.
        if (Math.min(a.count, b.count) < Math.max(a.count, b.count) * 0.75) continue;
        const k = Math.min(a.words.length, b.words.length) - 1;
        if (k < 1) continue;
        if (a.words.length + b.words.length - k > MAX_PHRASE_WORDS) continue;
        if (a.words.slice(a.words.length - k).join(" ") !== b.words.slice(0, k).join(" ")) continue;

        const merged: Phrase = {
          words: [...a.words, ...b.words.slice(k)],
          count: Math.min(a.count, b.count),
          share: Math.min(a.share, b.share),
        };
        const [lo, hi] = i < j ? [i, j] : [j, i];
        items.splice(hi, 1);
        items.splice(lo, 1);
        items.push(merged);
        mergedAny = true;
        break outer;
      }
    }
    if (!mergedAny) break;
  }

  // ── swallow leftover fragments ──
  const kept: Phrase[] = [];
  for (const g of [...items].sort((a, b) => b.words.length - a.words.length)) {
    const text = g.words.join(" ");
    const swallowed = kept.some(
      (k) => k.words.join(" ").includes(text) && g.count <= k.count * 1.25,
    );
    if (!swallowed) kept.push(g);
  }

  return kept
    .sort((a, b) => b.count - a.count)
    .map((p) => ({ value: p.words.join(" "), count: p.count, share: p.share }));
}

/** Links are addresses, not voice. "https www instagram com" is not a phrase. */
const URL_RE = /https?:\/\/\S+|\bwww\.\S+/gi;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(URL_RE, " ")
    .replace(EMOJI_RE, " ")
    .replace(/[^\p{L}\p{N}'׳"״\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The recognisable head of a message: enough words to identify the habit,
 * few enough that "היי מהממת 🩷" and "היי מהממת 🩷 מה שלומך" count as the same
 * greeting rather than as two.
 */
function normalizeHead(body: string, words = 4): string {
  const head = (body || "")
    .replace(URL_RE, " ")
    // A template addressed to the customer by name is ONE habit, not forty.
    // "ג'ני, תודה על הזמנתך" and "לאה, תודה על הזמנתך" are the same order
    // confirmation, and counting them apart hides how standard it is - which
    // is exactly the thing worth knowing about how this business writes.
    .replace(/^\s*\S{2,12},\s+/u, "{name}, ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, words)
    .join(" ");
  return head.length > 60 ? head.slice(0, 60) : head;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function round(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(3)) : 0;
}

/**
 * The prompt input. Counts only - never raw messages.
 *
 * Handing the model the distribution instead of a sample is what keeps the
 * output honest: it cannot describe a trait that is not in the numbers, and
 * every line it writes is checkable against them.
 */
export function renderVoiceStats(stats: BrandVoiceStats): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const list = (xs: Counted[]) =>
    xs.length ? xs.map((x) => `  "${x.value}" - ${x.count}x (${pct(x.share)})`).join("\n") : "  (none)";

  return [
    `Messages analyzed: ${stats.messagesAnalyzed} across ${stats.conversationsAnalyzed} conversations.`,
    ``,
    `EMOJI`,
    `${pct(stats.emojiMessageShare)} of messages contain at least one emoji; ${stats.emojiPerEmojiMessage} per such message.`,
    list(stats.emojis),
    ``,
    `HOW CONVERSATIONS OPEN (first business message)`,
    list(stats.openers),
    ``,
    `HOW CONVERSATIONS CLOSE (last business message)`,
    list(stats.closers),
    ``,
    `REPEATED PHRASES`,
    list(stats.signaturePhrases),
    ``,
    `CHARACTERISTIC WORDS`,
    list(stats.signatureWords),
    ``,
    `RHYTHM`,
    `Median ${stats.medianWords} words per message, mean ${stats.meanWords}.`,
    `${pct(stats.shortReplyShare)} are short one-line replies under five words.`,
    `${pct(stats.questionShare)} contain a question, ${pct(stats.exclamationShare)} an exclamation mark.`,
  ].join("\n");
}
