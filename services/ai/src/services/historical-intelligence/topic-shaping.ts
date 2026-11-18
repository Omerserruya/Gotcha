import { z } from "zod";
import { structuredCall } from "./llm";
import { languageDirective } from "./stage-utils";

/**
 * Topic shaping between the first topic pass and consolidation (2026-11-18, the Smoovee rerun on luna: 94 topics,
 * 34 of them a single item with twins like "מידות משטח" / "מידות המשטח"; one topic of 30 questions that
 * consolidation, capped at 12 canonical items, left nearly unmerged).
 *
 * 1. The tail: a single-item topic joins an existing topic of its category. Free first, by the labels' word keys
 *    (equal, or one contains the other when the smaller has 2 keys or more); then ONE model call per category
 *    for the singletons left. OTHER's singletons may join a topic of any category.
 * 2. The big ones: a topic over 12 members gets ONE split call into parts of 2 to 8, by what is asked.
 * Every id stays in exactly one group; a model answer that does not hold is ignored, never a lost item.
 */
export interface ShapeGroup { label: string; category: string; candidateIds: string[] }
export interface ShapeCandidate { id: string; question: string; answer: string }

export const SPLIT_ABOVE = 12;
export const PART_MAX = 8;
export const PART_MIN = 2;

/** A label's word keys: the joined prefix letter and a plural ending off, the first four letters (משטחי, המשטח: משטח). */
export function labelKeys(label: string): Set<string> {
  const words = (String(label ?? "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) as string[];
  return new Set(words.map((w) => {
    let x = w;
    // ה and ו off a word of 4+, ל and ב off one of 5+; never מ or ש, which begin words (משטח, שמלה).
    if (/^[הו][֐-׿]{3,}$/u.test(x)) x = x.slice(1);
    else if (/^[לב][֐-׿]{4,}$/u.test(x)) x = x.slice(1);
    if (/^[֐-׿]/u.test(x) && x.length >= 5) x = x.replace(/(?:ים|ות|י)$/u, "");
    return x.slice(0, 4);
  }));
}
const contains = (a: Set<string>, b: Set<string>) => [...b].every((k) => a.has(k));
/** Joined without a model: the same keys, or one set inside the other when the smaller has 2 keys or more. */
export function labelsJoin(a: string, b: string): boolean {
  const ka = labelKeys(a), kb = labelKeys(b);
  if (!ka.size || !kb.size) return false;
  if (ka.size === kb.size && contains(ka, kb)) return true;
  const [big, small] = ka.size >= kb.size ? [ka, kb] : [kb, ka];
  return small.size >= 2 && contains(big, small);
}

/** The free join: each single-item topic into the first larger (or earlier) topic of its category whose label joins. */
export function freeJoin(groups: ShapeGroup[]): ShapeGroup[] {
  const out: ShapeGroup[] = groups.filter((g) => g.candidateIds.length > 1).map((g) => ({ ...g, candidateIds: [...g.candidateIds] }));
  for (const s of groups.filter((g) => g.candidateIds.length === 1)) {
    const into = out.find((g) => g.category === s.category && labelsJoin(g.label, s.label));
    if (into) into.candidateIds.push(...s.candidateIds);
    else out.push({ ...s, candidateIds: [...s.candidateIds] });
  }
  return out;
}

const JoinSchema = z.object({ joins: z.array(z.object({ id: z.string(), topic: z.string().nullable() })).max(80) });
const JOIN_PROMPT = `You tidy the topics of a business's question/answer review. You get the existing topics (labels) and single items, each in no topic of its own yet.
For each single item, name the existing topic that ONE knowledge article would answer together with it, by its label exactly as given; or null when none fits. Never invent a label. Join only when it is truly the same subject.
Reply with ONLY JSON: {"joins":[{"id":"...","topic":"<label or null>"}]}`;

/** One call per category that still has singletons (OTHER may join any category). */
export async function joinSingletons(args: { tenantId: string; importId?: string; language: string; groups: ShapeGroup[]; byId: Map<string, ShapeCandidate> }): Promise<{ groups: ShapeGroup[]; calls: number; joined: number }> {
  const groups = args.groups.map((g) => ({ ...g, candidateIds: [...g.candidateIds] }));
  let calls = 0, joined = 0;
  for (const category of [...new Set(groups.map((g) => g.category))]) {
    const singles = groups.filter((g) => g.category === category && g.candidateIds.length === 1);
    const targets = groups.filter((g) => g.candidateIds.length > 1 && (category === "OTHER" || g.category === category));
    if (!singles.length || !targets.length) continue;
    calls++;
    const r = await structuredCall({
      tenantId: args.tenantId, importId: args.importId, schema: JoinSchema, system: JOIN_PROMPT + languageDirective(args.language), tier: "import", maxTokens: 2000,
      feature: "historical_knowledge_topics",
      user: `Existing topics:\n${targets.map((g) => `- ${g.label}`).join("\n")}\n\nSingle items:\n${singles.map((g) => { const c = args.byId.get(g.candidateIds[0]); return `${g.candidateIds[0]} | ${g.label} | ${c?.question ?? ""}`; }).join("\n")}`,
    });
    for (const j of r?.joins ?? []) {
      if (!j.topic) continue;
      const s = singles.find((g) => g.candidateIds[0] === j.id && groups.includes(g));
      const into = targets.find((g) => g.label === String(j.topic).trim());
      if (!s || !into) continue;
      into.candidateIds.push(...s.candidateIds);
      groups.splice(groups.indexOf(s), 1);
      joined++;
    }
  }
  return { groups, calls, joined };
}

const SplitSchema = z.object({ parts: z.array(z.object({ label: z.string().min(2).max(60), ids: z.array(z.string()).min(1) })).max(12) });
const SPLIT_PROMPT = `You split ONE large topic of a business's question/answer review into sub-topics a reviewer approves one at a time.
Split by what is asked: one device or model, the general size rule, a measurement such as the handle or the height, buying or price.
Each sub-topic holds 2 to 8 items. Every id must appear in exactly one sub-topic. Labels: three to five words, in the business's language, each different.
Reply with ONLY JSON: {"parts":[{"label":"...","ids":["...","..."]}]}`;

const shared = (a: string, b: string) => {
  const w = (t: string) => new Set((String(t ?? "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) as string[]);
  const x = w(a);
  return [...w(b)].filter((k) => x.has(k)).length;
};

/**
 * A model's split checked: ids only from the topic, each once, every one placed; a part over 8 cut into runs of 8;
 * a part of 1 joins the part whose questions share the most words with it (the first part when none).
 * With no usable answer: runs of 8 in the topic's own order.
 */
export function checkSplit(g: ShapeGroup, raw: z.infer<typeof SplitSchema> | null, byId: Map<string, ShapeCandidate>): ShapeGroup[] {
  const mine = new Set(g.candidateIds);
  const used = new Set<string>();
  let parts: Array<{ label: string; ids: string[] }> = [];
  for (const p of raw?.parts ?? []) {
    const ids = p.ids.filter((id) => mine.has(id) && !used.has(id));
    ids.forEach((id) => used.add(id));
    if (ids.length) parts.push({ label: p.label.trim(), ids });
  }
  const left = g.candidateIds.filter((id) => !used.has(id));
  if (!parts.length) parts = [{ label: g.label, ids: [] }];
  for (const id of left) parts[0].ids.push(id);
  // Over 8: runs of 8.
  parts = parts.flatMap((p) => {
    if (p.ids.length <= PART_MAX) return [p];
    const runs: Array<{ label: string; ids: string[] }> = [];
    for (let i = 0; i < p.ids.length; i += PART_MAX) runs.push({ label: runs.length ? `${p.label} ${runs.length + 1}` : p.label, ids: p.ids.slice(i, i + PART_MAX) });
    return runs;
  });
  // A part of 1 joins the part with the most shared words (never makes a part over 8 when another has room).
  for (const p of [...parts].filter((x) => x.ids.length < PART_MIN)) {
    if (parts.length < 2) break;
    const q = byId.get(p.ids[0])?.question ?? "";
    const others = parts.filter((o) => o !== p && o.ids.length < PART_MAX);
    if (!others.length) continue;
    const best = others.map((o) => ({ o, s: o.ids.reduce((n, id) => n + shared(q, byId.get(id)?.question ?? ""), 0) })).sort((a, b) => b.s - a.s)[0].o;
    best.ids.push(...p.ids);
    parts.splice(parts.indexOf(p), 1);
  }
  // Labels unique within the topic (a topic is keyed by its label).
  const seen = new Map<string, number>();
  return parts.map((p) => {
    const n = (seen.get(p.label) ?? 0) + 1;
    seen.set(p.label, n);
    return { label: n > 1 ? `${p.label} ${n}` : p.label, category: g.category, candidateIds: p.ids };
  });
}

export async function splitBig(args: { tenantId: string; importId?: string; language: string; groups: ShapeGroup[]; byId: Map<string, ShapeCandidate> }): Promise<{ groups: ShapeGroup[]; calls: number; split: number }> {
  const out: ShapeGroup[] = [];
  let calls = 0, split = 0;
  for (const g of args.groups) {
    if (g.candidateIds.length <= SPLIT_ABOVE) { out.push(g); continue; }
    calls++;
    const raw = await structuredCall({
      tenantId: args.tenantId, importId: args.importId, schema: SplitSchema, system: SPLIT_PROMPT + languageDirective(args.language), tier: "import", maxTokens: 3000,
      feature: "historical_knowledge_topics",
      user: `Topic: ${g.label}\n${g.candidateIds.length} items:\n${g.candidateIds.map((id) => `${id} | ${args.byId.get(id)?.question ?? ""}`).join("\n")}`,
    });
    const parts = checkSplit(g, raw, args.byId);
    if (parts.length > 1) split++;
    out.push(...parts);
  }
  return { groups: out, calls, split };
}

/** The tail join, then the split: the groups consolidation runs over. */
export async function shapeTopics(args: { tenantId: string; importId?: string; language: string; groups: ShapeGroup[]; byId: Map<string, ShapeCandidate> }): Promise<{ groups: ShapeGroup[]; detail: { before: number; freeJoined: number; modelJoined: number; joinCalls: number; split: number; splitCalls: number; after: number } }> {
  const before = args.groups.length;
  const free = freeJoin(args.groups);
  const joined = await joinSingletons({ ...args, groups: free });
  const split = await splitBig({ ...args, groups: joined.groups });
  return { groups: split.groups, detail: { before, freeJoined: before - free.length, modelJoined: joined.joined, joinCalls: joined.calls, split: split.split, splitCalls: split.calls, after: split.groups.length } };
}
