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
 *
 * The model's own close_conversation (2026-11-22, dev: "תודה רבה, זה הכל" and the model closed at once). That
 * tool flips the status and writes no closing event, so nothing reopens the conversation: a late "and one more
 * thing" becomes a brand-new conversation, and on the web chat lands where the widget never looks. The engine
 * therefore holds the model's close back (closeCallRefusal):
 *  - the customer's message is not an end: refused, as the legacy path always did (lib/close-intent);
 *  - it is an end and the quiet close runs for this conversation: deferred. The turn is marked as above and the
 *    sweep closes it a few minutes later, reopenably;
 *  - it is an end and no quiet close runs here (the default is off, the business switched its channel group
 *    off, the channel has no rule): the close goes through as before, because nothing else would close it.
 */
import { BOT_IDLE_SOURCE, ENDED_FACT, botIdleRuleFor, parseBotIdleRow } from "@chatcenter/shared/src/lib/bot-idle";
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
  /**
   * The model called close_conversation this turn and the engine deferred it (closeWasDeferred). The customer's
   * words and the model both say it is an end, so a question in the bot's previous message no longer makes the
   * message an answer to it ("עוד משהו שאוכל לעזור?" then "לא תודה, זה הכל"). Everything else still holds.
   */
  closeDeferred?: boolean;
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
  if (!a.closeDeferred && ASKS.test(String(said.at(-1)?.body ?? ""))) return "answers_our_question";
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

// ── The model's own close ──

export const CLOSE_TOOL = "close_conversation";
/** The codes the refusal's reason opens with: the audit line of the call reads refused:<code>. */
export const CLOSE_DEFERRED = "close_deferred";
export const CLOSE_NOT_ALLOWED = "close_not_allowed";

/** What the model reads back. Model-facing only: nothing here reaches the customer. */
export const CLOSE_DEFERRED_TEXT =
  `${CLOSE_DEFERRED}: the customer said goodbye. Do not close now: the conversation closes by itself a few minutes after a goodbye and stays open for a late message. ` +
  "Answer the customer as you would answer any goodbye, and do not call close_conversation again.";
export const CLOSE_NOT_ALLOWED_TEXT =
  `${CLOSE_NOT_ALLOWED}: do NOT close this conversation. The customer has not ended it (an explicit thanks, bye or that's all after their need was met). ` +
  "Answer their latest message and keep the conversation open.";

/** Is the customer's message of this turn an explicit end, by the same test and the same count the mark uses? */
export function customerEnded(incoming: string | null | undefined, history: Row[]): boolean {
  return closeAllowed(String(incoming ?? ""), history.filter(botSaid).length).allowed;
}

/**
 * Does the idle sweep close a marked end in this conversation? Its two conditions (incoming-worker
 * idle-conversation.worker botIdleForTenant): the default is switched on, and the conversation's channel has a
 * rule for this business. `rawRow` is the business's stored idle setting, null when it never saved one.
 */
export function quietCloseRuns(channel: string | null | undefined, rawRow: string | null | undefined, defaultOn: boolean): boolean {
  return defaultOn && botIdleRuleFor(channel, parseBotIdleRow(rawRow), true) !== null;
}

/**
 * The refusal the model's close_conversation gets instead of a close, or null when the call goes through.
 * `quietClose`: quietCloseRuns for this conversation.
 */
export function closeCallRefusal(tool: string, a: { incoming: string | null | undefined; history: Row[]; quietClose: boolean }): string | null {
  if (tool !== CLOSE_TOOL) return null;
  if (!customerEnded(a.incoming, a.history)) return CLOSE_NOT_ALLOWED_TEXT;
  return a.quietClose ? CLOSE_DEFERRED_TEXT : null;
}

interface CallRecord { tool?: string; decision?: string; content?: string }
const heldBackAs = (r: CallRecord): string | null => {
  if (r.tool !== CLOSE_TOOL || r.decision !== "deny") return null;
  let body: any = null;
  try { body = JSON.parse(String(r.content ?? "")); } catch { body = null; }
  if (body?.failure !== "refused") return null;
  const code = String(body.reason ?? "").split(":")[0];
  return code === CLOSE_DEFERRED || code === CLOSE_NOT_ALLOWED ? code : null;
};
/** A close the engine deferred this turn: the mark may skip the "answers our question" test. */
export const closeWasDeferred = (r: CallRecord): boolean => heldBackAs(r) === CLOSE_DEFERRED;
/** A close the engine held back this turn, either way. It is the engine's own rule, never a call that needs a person. */
export const closeHeldBack = (r: CallRecord): boolean => heldBackAs(r) !== null;
