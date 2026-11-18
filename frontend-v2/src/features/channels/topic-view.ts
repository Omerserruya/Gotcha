import {
  answerOptions,
  type ImportTopic,
  type TopicItem,
  type TopicItemStatus,
  type TopicStatus,
} from '@/api/contracts/import-topics';

/**
 * 13f by topic, as the client card draws it: every date and the chosen-value
 * line already written on the server - one runtime's ICU for every string,
 * never the browser's (#418).
 */
export interface TopicItemView {
  readonly candidateId: string;
  readonly status: TopicItemStatus;
  readonly question: string;
  readonly unresolved: boolean;
  /** `answerOptions`: the suggestion, then the variants, one per text. */
  readonly options: readonly string[];
  /** Per option: when it was last said, written; `null` when unknown. */
  readonly optionSeen: readonly (string | null)[];
  /** "נבחר: 449 ₪ (התשובה העדכנית, 12.11) · קודם: 350 ₪ (עד 06.2026)"; `null` for other answers. */
  readonly chosenLine: string | null;
  /** Up to two of the real exchanges behind it. */
  readonly quotes: readonly { readonly question: string; readonly answer: string }[];
}

export interface TopicView {
  readonly topicId: string;
  readonly label: string;
  readonly status: TopicStatus;
  /** "12 שיחות · 9 לקוחות · נראה לאחרונה 12.11", nothing for a figure of 0. */
  readonly meta: string;
  readonly docConflict: boolean;
  readonly items: readonly TopicItemView[];
}

export interface TopicWords {
  /** ICU messages of `channels.whatsapp.topics`. */
  readonly t: (key: string, values?: Record<string, string | number>) => string;
  /** A day and month: "12.11". */
  readonly day: (iso: string) => string | null;
  /** A month and year: "06.2026". */
  readonly month: (iso: string) => string | null;
}

/** A date the server sent, read only when it is one. */
export function validDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A month and year with the month in two digits, in the locale's own order
 * and separator: "06.2026" in Hebrew, "06/2026" in English. ICU writes "6.2026"
 * for `month: '2-digit'` in Hebrew; the parts are its own, only padded.
 */
export function monthYear(format: Intl.DateTimeFormat, date: Date): string {
  return format
    .formatToParts(date)
    .map((part) => (part.type === 'month' ? part.value.padStart(2, '0') : part.value))
    .join('');
}

export function chosenLineOf(item: TopicItem, w: TopicWords): string | null {
  const { chosen, previous } = item;
  if (!chosen || !chosen.value) return null;
  const at = chosen.at ? w.day(chosen.at) : null;
  const basis =
    chosen.basis === 'policy'
      ? w.t('chosen.policy')
      : at
        ? w.t('chosen.latestOn', { date: at })
        : w.t('chosen.latest');
  const parts = [w.t('chosen.line', { value: chosen.value, basis })];
  if (previous && previous.value) {
    const until = previous.until ? w.month(previous.until) : null;
    parts.push(
      until
        ? w.t('chosen.previousUntil', { value: previous.value, until })
        : w.t('chosen.previous', { value: previous.value }),
    );
  }
  return parts.join(' · ');
}

function itemView(item: TopicItem, w: TopicWords): TopicItemView {
  const options = answerOptions(item);
  const seen = new Map<string, string | null>();
  for (const v of item.variants) {
    const key = v.answer.trim();
    if (!seen.has(key)) seen.set(key, v.lastSeenAt ? w.day(v.lastSeenAt) : null);
  }
  return {
    candidateId: item.candidateId,
    status: item.status,
    question: item.question,
    unresolved: item.unresolved,
    options,
    optionSeen: options.map((o) => seen.get(o) ?? null),
    chosenLine: chosenLineOf(item, w),
    quotes: item.quotes.slice(0, 2).map((q) => ({ question: q.question, answer: q.answer })),
  };
}

export function topicView(topic: ImportTopic, w: TopicWords): TopicView {
  const seen = topic.lastSeenAt ? w.day(topic.lastSeenAt) : null;
  const meta = [
    topic.occurrences > 0 ? w.t('meta.chats', { count: topic.occurrences }) : null,
    topic.customers > 0 ? w.t('meta.customers', { count: topic.customers }) : null,
    seen ? w.t('meta.lastSeen', { date: seen }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    topicId: topic.topicId,
    label: topic.label,
    status: topic.status,
    meta,
    docConflict: topic.docConflict,
    items: topic.items.map((item) => itemView(item, w)),
  };
}
