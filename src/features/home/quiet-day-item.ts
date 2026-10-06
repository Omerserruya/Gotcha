import type { QuietDayItem } from '@/api/contracts/analytics';

/**
 * 01b's rows - "Worth an hour, while it is quiet" - ONE PER SOURCE.
 *
 * The ranker (`packages/shared/src/lib/quiet-day-ranking.ts`) emits an item
 * per question, per term, per conflict. 02 draws one row per kind of work:
 * "Four questions it could not answer this week", the questions in its line,
 * one "Answer them". So items are grouped by `source`, in the order of each
 * group's best rank.
 *
 * What the ranker emits, by source:
 *
 *   unanswered_question  kind `knowledge_gap.<reason>`
 *                        values { question, askCount, askedBy }
 *   knowledge_conflict   kind `knowledge_conflict.pending`
 *                        values { field, affectedCustomerCount }
 *   product_demand       kind `product_demand.not_stocked`
 *                        values { term, askCount, askedBy, weeksRunning }
 *   dormant_customers    kind `dormant_customers.reachable`
 *                        values { count, quietForDays }
 *
 * ★ An item without the values its sentence needs is DROPPED, not drawn: a
 * missing ICU argument renders as nothing in production, and the row was an
 * empty line with a button. A source this list does not know gets no row.
 *
 * Counts across items: `askCount` adds up; `askedBy` does not - the same
 * person can ask two questions - so a group says "asked N times".
 */

export const QUIET_SOURCES = [
  'unanswered_question',
  'knowledge_conflict',
  'product_demand',
  'dormant_customers',
] as const;
export type QuietSource = (typeof QUIET_SOURCES)[number];

/** 02's left edge: amber a gap, red a conflict, green an opportunity. */
export type QuietTone = 'gap' | 'conflict' | 'opportunity' | null;

export interface QuietRow {
  readonly source: QuietSource;
  /** The message key under `home.quietWork.item`. */
  readonly key: 'gaps' | 'conflicts' | 'demandOne' | 'demandMany' | 'dormant';
  readonly values: Record<string, string | number>;
  readonly href: string;
  readonly tone: QuietTone;
  readonly effect: QuietDayItem['effect'];
}

const HREF: Record<QuietSource, string> = {
  unanswered_question: '/studio/knowledge',
  knowledge_conflict: '/studio/knowledge',
  product_demand: '/analytics/topics',
  dormant_customers: '/outreach',
};

const TONE: Record<QuietSource, QuietTone> = {
  unanswered_question: 'gap',
  knowledge_conflict: 'conflict',
  product_demand: null,
  dormant_customers: 'opportunity',
};

const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The values each source's sentence needs. */
const VALID: Record<QuietSource, (v: Record<string, unknown>) => boolean> = {
  unanswered_question: (v) => str(v.question) && num(v.askCount),
  knowledge_conflict: (v) => str(v.field),
  product_demand: (v) => str(v.term) && num(v.askCount) && num(v.askedBy) && num(v.weeksRunning),
  dormant_customers: (v) => num(v.count) && num(v.quietForDays),
};

const isSource = (s: string): s is QuietSource => (QUIET_SOURCES as readonly string[]).includes(s);

/** Up to four, in rank order, as a phrase. */
const list = (parts: readonly string[]) => parts.slice(0, 4).join(', ');

const sum = (items: readonly QuietDayItem[], key: string) =>
  items.reduce((total, i) => total + (num(i.values[key]) ? (i.values[key] as number) : 0), 0);

export function quietRows(items: readonly QuietDayItem[]): readonly QuietRow[] {
  const groups = new Map<QuietSource, QuietDayItem[]>();
  for (const item of [...items].sort((a, b) => a.rank - b.rank)) {
    if (!isSource(item.source) || !VALID[item.source](item.values)) continue;
    groups.set(item.source, [...(groups.get(item.source) ?? []), item]);
  }

  return [...groups.entries()].map(([source, group]): QuietRow => {
    const first = group[0]!;
    const base = { source, href: HREF[source], tone: TONE[source], effect: first.effect };
    switch (source) {
      case 'unanswered_question':
        return {
          ...base,
          key: 'gaps',
          values: {
            count: group.length,
            questions: list(group.map((i) => `“${String(i.values.question).trim()}”`)),
            asked: sum(group, 'askCount'),
          },
        };
      case 'knowledge_conflict':
        return {
          ...base,
          key: 'conflicts',
          values: { count: group.length, fields: list(group.map((i) => String(i.values.field))) },
        };
      case 'product_demand':
        return group.length === 1
          ? {
              ...base,
              key: 'demandOne',
              values: {
                term: String(first.values.term),
                askedBy: first.values.askedBy as number,
                weeksRunning: first.values.weeksRunning as number,
              },
            }
          : {
              ...base,
              key: 'demandMany',
              values: {
                count: group.length,
                terms: list(group.map((i) => String(i.values.term))),
                asked: sum(group, 'askCount'),
              },
            };
      case 'dormant_customers':
        return {
          ...base,
          key: 'dormant',
          values: {
            count: first.values.count as number,
            quietForDays: first.values.quietForDays as number,
          },
        };
    }
  });
}

/** How many questions the list holds - 01b's "Answer the N open questions". */
export function openQuestionCount(items: readonly QuietDayItem[]): number {
  return items.filter((i) => i.source === 'unanswered_question').length;
}
