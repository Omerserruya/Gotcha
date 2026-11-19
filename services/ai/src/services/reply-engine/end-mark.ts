/**
 * The end mark (2026-11-19, Omer: conversations never got closed). When the customer's latest message is an
 * explicit end ("תודה", "bye", "that's all") and nothing is open, the turn is MARKED as an end in the engine's
 * own state. Nothing closes in the turn: people often add a message right after "תודה", and a closed
 * conversation would make it a brand-new one. The idle sweep (incoming-worker idle-conversation.worker) closes
 * a marked conversation quietly after a short while, when no customer message came after the mark; any later
 * message cancels it.
 *
 * Marked only when all of these hold:
 *  - lib/close-intent closeAllowed says the message is an end, after the bot answered at least once;
 *  - the bot's previous message was not a question ("רוצה שאבדוק?" then "כן תודה" is a yes, not a goodbye);
 *  - this turn's reply asks nothing;
 *  - nothing is open: no handoff, no approval waiting, no open question for the team.
 */
import { BOT_IDLE_SOURCE, ENDED_FACT } from "@chatcenter/shared/src/lib/bot-idle";
import { closeAllowed } from "../../lib/close-intent";
import { isPersonOutbound } from "../conversation-history.service";
import { isTeamPromise, TEAM_OPEN_MS } from "./state";

const ASKS = /[?؟]/;
const IDLE_SOURCES: string[] = [BOT_IDLE_SOURCE.reminder, BOT_IDLE_SOURCE.close];

interface Row { direction?: string | null; body?: string | null; createdAt?: Date | string | null; metadata?: unknown; messageType?: string | null }

export interface EndMarkInput {
  /** The customer's message of this turn. */
  incoming: string | null | undefined;
  /** The conversation before this turn's reply, oldest first. */
  history: Row[];
  /** What the bot says this turn (empty: nothing). */
  reply: string | null | undefined;
  handoff: boolean;
  awaitingApproval: boolean;
  /** The state's open items after this turn. */
  pending: Array<{ kind?: string; text?: string; at?: string }> | null | undefined;
  /** When the turn began, for a message the history does not hold as one row. */
  turnStartedAt: number;
  now?: number;
}

const meta = (m: Row) => (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
/** The bot's own spoken messages: not a person's, not a product card or system row, not a holding line, not the idle reminder. */
const botSaid = (m: Row) =>
  m.direction === "OUTBOUND" && !isPersonOutbound(m as any) && !!String(m.body ?? "").trim()
  && !/product|system/.test(String(m.messageType ?? ""))
  && !["interim_ack", "holding"].includes(String(meta(m).kind ?? ""))
  && !IDLE_SOURCES.includes(String(meta(m).source ?? ""));

/** Why the turn is not an end, or null when it is. */
export function endMarkRefusal(a: EndMarkInput): string | null {
  const said = a.history.filter(botSaid);
  const verdict = closeAllowed(String(a.incoming ?? ""), said.length);
  if (!verdict.allowed) return verdict.reason ?? "not_an_end";
  if (ASKS.test(String(said.at(-1)?.body ?? ""))) return "answers_our_question";
  if (ASKS.test(String(a.reply ?? ""))) return "reply_asks";
  if (a.handoff) return "handoff";
  if (a.awaitingApproval) return "approval";
  const now = a.now ?? Date.now();
  for (const p of a.pending ?? []) {
    if (p?.kind === "approval") return "approval";
    if (isTeamPromise(p) && !(now - Date.parse(p.at ?? "") > TEAM_OPEN_MS)) return "open_team_item";
  }
  return null;
}

/**
 * The mark's time: the stored time of the customer message that ended it (the sweep compares it with the
 * stored time of the newest customer message), else when the turn began.
 */
export function endMarkTime(a: Pick<EndMarkInput, "incoming" | "history" | "turnStartedAt">): string {
  const lastIn = [...a.history].reverse().find((m) => m.direction === "INBOUND" && String(m.messageType ?? "") !== "system");
  const same = lastIn && String(lastIn.body ?? "").trim() === String(a.incoming ?? "").trim() && lastIn.createdAt;
  const at = same ? new Date(lastIn!.createdAt as any) : new Date(a.turnStartedAt);
  return (Number.isNaN(at.getTime()) ? new Date(a.turnStartedAt) : at).toISOString();
}

/**
 * The engine fact of this turn: the mark when the turn is an end; an emptied one when an earlier mark stands
 * and this turn is not an end; nothing otherwise.
 */
export function endMarkFact(previous: unknown, a: EndMarkInput): Record<string, string> {
  if (!endMarkRefusal(a)) return { [ENDED_FACT]: endMarkTime(a) };
  return previous ? { [ENDED_FACT]: "" } : {};
}
