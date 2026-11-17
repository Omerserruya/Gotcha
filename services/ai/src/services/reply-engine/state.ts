/**
 * ConversationState: load, merge, save. One row per conversation per lane.
 * A missing row is an empty state (first turn); a missing TABLE (P2021, the
 * migration not applied yet) is also an empty state, and saving is skipped.
 */
import { prisma } from "@chatcenter/shared";
import type { ConversationStateRecord, OfferedItem, PendingItem, StateLane, StateUpdate } from "./contract";

const MAX_FACTS = 40;
const MAX_OFFERED = 20;
const MAX_PENDING = 10;
const MAX_STR = 300;

export function emptyState(): ConversationStateRecord {
  return { stage: null, intent: null, facts: {}, offeredItems: [], pending: [], activeSkill: null, summary: null, summaryUpTo: null, turnCount: 0 };
}

const clip = (v: unknown, n = MAX_STR): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

export function rowToState(row: any): ConversationStateRecord {
  if (!row) return emptyState();
  return {
    stage: row.stage ?? null,
    intent: row.intent ?? null,
    facts: obj(row.facts),
    offeredItems: arr<OfferedItem>(row.offeredItems),
    pending: arr<PendingItem>(row.pending),
    activeSkill: row.activeSkill ?? null,
    summary: row.summary ?? null,
    summaryUpTo: row.summaryUpTo ? new Date(row.summaryUpTo).toISOString() : null,
    turnCount: Number(row.turnCount ?? 0) || 0,
  };
}

function missingTable(err: any): boolean {
  return err?.code === "P2021" || /conversation_states.*does not exist/i.test(String(err?.message ?? ""));
}

export async function loadState(tenantId: string, conversationId: string, lane: StateLane): Promise<ConversationStateRecord> {
  try {
    const row = await (prisma as any).conversationState.findUnique({
      where: { conversationId_lane: { conversationId, lane } },
    });
    if (row && row.tenantId !== tenantId) return emptyState();
    return rowToState(row);
  } catch (err: any) {
    if (!missingTable(err)) console.warn(`[reply-engine] state load failed conv=${conversationId}:`, err?.message);
    return emptyState();
  }
}

/** Pure merge: the model's update on top of the stored state, bounded. */
/** An open question for the team, written by the engine (engine.ts TEAM_PROMISE_PREFIX). */
export const isTeamPromise = (p: { kind?: string; text?: string } | null | undefined) =>
  p?.kind === "promise" && String(p.text ?? "").startsWith("checking with the team: ");
export const TEAM_OPEN_MS = 72 * 60 * 60 * 1000;
/** Engine-owned facts start with "_": the model neither sees nor writes them. */
export const CANNED_SENT_FACT = "_cannedTeamLineAt";
/** Set once a safety or damage complaint is seen: the conversation stays a safety one. */
export const SAFETY_FACT = "_safetyAt";
/** The last turn whose product search failed (timed out or errored) and found nothing: two in a row go to the team. */
export const SEARCH_FAIL_FACT = "_searchFailedAt";
/** Order numbers a tool marked inactive (cancelled, failed, refunded) in any turn: later replies must label them. */
export const INACTIVE_ORDERS_FACT = "_inactiveOrders";
const engineFact = (k: string) => k.startsWith("_");

export function mergeState(
  prev: ConversationStateRecord,
  update: StateUpdate | null | undefined,
  extra: { offered?: OfferedItem[]; activeSkill?: string | null; approvals?: PendingItem[]; engineFacts?: Record<string, string>; now?: Date } = {},
): ConversationStateRecord {
  const now = (extra.now ?? new Date()).toISOString();
  const u = update ?? {};
  const facts: Record<string, any> = { ...prev.facts };
  for (const [k, v] of Object.entries(obj(u.facts))) {
    const key = clip(k, 60);
    if (!key || engineFact(key)) continue;
    if (v === null || v === "") delete facts[key];
    else facts[key] = typeof v === "number" || typeof v === "boolean" ? v : clip(v);
  }
  const factKeys = Object.keys(facts).filter((k) => !engineFact(k));
  for (const k of factKeys.slice(0, Math.max(0, factKeys.length - MAX_FACTS))) delete facts[k];
  for (const [k, v] of Object.entries(extra.engineFacts ?? {})) facts[k] = v;

  // Offered items: newest last, one per ref (a re-show moves it to the end).
  const offered = [...prev.offeredItems];
  for (const it of extra.offered ?? []) {
    const i = offered.findIndex((o) => (it.productId && o.productId === it.productId) || o.title === it.title);
    if (i >= 0) offered.splice(i, 1);
    offered.push(it);
  }

  let pending: PendingItem[] = prev.pending;
  if (Array.isArray(u.pending)) {
    // The open team questions are the engine's, not the model's: the model's
    // list replaces everything else, but cannot drop or re-stamp them (prod replay
    // 2026-11-16: a dropped one was asked again on the next turn). They expire
    // after TEAM_OPEN_MS, when the team has long answered in the chat.
    const nowMs = Date.parse(now);
    const team = prev.pending.filter((p) => isTeamPromise(p) && !(nowMs - Date.parse(p.at ?? now) > TEAM_OPEN_MS));
    pending = [
      ...team,
      ...u.pending
        .filter((p) => p && p.text && ["promise", "pending", "approval"].includes(String(p.kind)) && !isTeamPromise(p as any))
        .map((p) => ({ kind: p.kind, text: clip(p.text), ...(p.tool ? { tool: clip(p.tool, 80) } : {}), at: now })),
    ];
  }
  for (const a of extra.approvals ?? []) if (!pending.some((p) => p.kind === "approval" && p.tool === a.tool)) pending = [...pending, a];

  return {
    stage: u.stage !== undefined ? (u.stage ? clip(u.stage, 40) : null) : prev.stage,
    intent: u.intent !== undefined ? (u.intent ? clip(u.intent, 160) : null) : prev.intent,
    facts,
    offeredItems: offered.slice(-MAX_OFFERED),
    pending: pending.slice(-MAX_PENDING),
    activeSkill: extra.activeSkill !== undefined ? extra.activeSkill : prev.activeSkill,
    summary: prev.summary,
    summaryUpTo: prev.summaryUpTo,
    turnCount: prev.turnCount + 1,
  };
}

export async function saveState(
  tenantId: string,
  conversationId: string,
  lane: StateLane,
  aiAgentId: string,
  s: ConversationStateRecord,
): Promise<void> {
  const data = {
    aiAgentId,
    stage: s.stage,
    intent: s.intent,
    facts: s.facts as any,
    offeredItems: s.offeredItems as any,
    pending: s.pending as any,
    activeSkill: s.activeSkill,
    summary: s.summary,
    summaryUpTo: s.summaryUpTo ? new Date(s.summaryUpTo) : null,
    turnCount: s.turnCount,
  };
  try {
    await (prisma as any).conversationState.upsert({
      where: { conversationId_lane: { conversationId, lane } },
      create: { tenantId, conversationId, lane, ...data },
      update: { ...data, version: { increment: 1 } },
    });
  } catch (err: any) {
    if (!missingTable(err)) console.warn(`[reply-engine] state save failed conv=${conversationId}:`, err?.message);
  }
}

/** Save only the rolling summary (written after the reply, off the critical path). */
export async function saveSummary(conversationId: string, lane: StateLane, summary: string, upTo: Date): Promise<void> {
  try {
    await (prisma as any).conversationState.update({
      where: { conversationId_lane: { conversationId, lane } },
      data: { summary: clip(summary, 2000), summaryUpTo: upTo },
    });
  } catch (err: any) {
    if (!missingTable(err)) console.warn(`[reply-engine] summary save failed conv=${conversationId}:`, err?.message);
  }
}

/** The state as the model reads it: short, no empty sections. */
export function renderState(s: ConversationStateRecord): string {
  const lines: string[] = [];
  if (s.stage) lines.push(`stage: ${s.stage}`);
  if (s.intent) lines.push(`intent: ${s.intent}`);
  const facts = Object.entries(s.facts).filter(([k]) => !engineFact(k));
  if (facts.length) lines.push(`known facts: ${facts.map(([k, v]) => `${k}=${v}`).join("; ")}`);
  if (s.offeredItems.length) {
    lines.push(
      "already shown: " +
        s.offeredItems.slice(-8).map((o) => `${o.title}${o.productId ? ` [id ${o.productId}]` : ""}${o.price != null ? ` (${o.price}${o.currency ? " " + o.currency : ""})` : ""}`).join("; "),
    );
  }
  if (s.pending.length) lines.push(`open: ${s.pending.map((p) => `[${p.kind}] ${p.text}`).join("; ")}`);
  if (s.activeSkill) lines.push(`skill in use: ${s.activeSkill}`);
  return lines.length ? lines.join("\n") : "(first turn: nothing known yet)";
}
