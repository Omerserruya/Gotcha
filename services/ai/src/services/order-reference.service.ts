/**
 * Which order is the customer talking about, decided deterministically.
 *
 * The failure this exists to stop, observed live: Matan discussed order #1006,
 * a refund on it failed, and he then wrote
 *
 *     "לא, שכח מ1006. אני מבקש החזר כספי מלא עבור ההזמנה מספר 1010 בלבד"
 *
 * and the bot kept answering about #1006 - twice, through an explicit
 * correction and a negation. The order the model carries is drawn from a long
 * conversation history, and history is exactly what a correction is trying to
 * overrule. Left to inference, an anchored model can walk a stale order into a
 * refund.
 *
 * So the current message is read directly, with rules rather than inference,
 * and the answer is used to FENCE the tool call: a financial action whose
 * target contradicts what the customer just typed does not run.
 *
 * Nothing here guesses. When the message names no order, this module says so
 * and the existing resolution path is left alone.
 */

/** Order words that license a bare number to be read as an order number. */
const ORDER_WORD = "(?:הזמנה|הזמנת|הזמנות|order|ord\\.?)";

/**
 * A number only counts as an order when it is written as `#1010`, or sits
 * next to an order word. Bare digits are NOT order references: "יש את הדגם
 * הזה במידה 159?" is a board length, and "תחזירו לי 200 שקל" is money.
 * Reading either as an order id would be worse than reading neither.
 */
const HASH_REF = /#\s?(\d{2,})/g;
const WORDED_REF = new RegExp(`${ORDER_WORD}\\s*(?:מספר\\s*|number\\s*|no\\.?\\s*|#\\s*)?(\\d{2,})`, "gi");
/** "1010 בלבד" / "רק 1010" - a number the customer is narrowing TO. */
const ONLY_REF = /(?:רק|בלבד\s*)?\s*(\d{2,})\s*(?:בלבד)/g;

/**
 * A LIST after one order word: "הזמנות 1009 ו-1010", "orders 1009 and 1010".
 * Only the first number carries the order word, so the per-number pattern
 * above sees just one of them - and a customer naming two orders then has one
 * of them silently ignored.
 */
const ORDER_LIST = new RegExp(
  `${ORDER_WORD}\\s*(?:מספר\\s*|number\\s*|no\\.?\\s*)?((?:#?\\s?\\d{2,}(?:\\s*(?:ו-?|,|\\/|and|או)\\s*)?)+)`,
  "gi",
);
const LIST_SEPARATOR = /\s*(?:ו-?|,|\/|and|או)\s*/;

/** Phrases that drop earlier order context wholesale. */
const RESET_RE =
  /(שכח|תשכח|תשכחי|עזוב|עזבי|נעזוב)\s*(?:את\s*)?(?:מ-?\s*)?(?:ההזמנה\s*)?(?:הקודמת|הקודם|הישנה)?|forget\s+(?:the\s+)?(?:previous|earlier|other|last)\s+order/i;

/**
 * Negation immediately attached to a number: "לא 1006", "שכח מ-1006",
 * "במקום 1006", "not 1006". The number is being EXCLUDED, not selected.
 */
const NEGATED_REF =
  /(?:לא|במקום|בלי|חוץ מ|שכח\s*מ|תשכח\s*מ|not|instead of|except)\s*-?\s*#?\s?(\d{2,})/gi;

const LATEST_RE =
  /(ההזמנה\s*האחרונה|האחרונה\s*שלי|the\s+(?:latest|last|most recent)\s+order|latest\s+order)/i;

export interface OrderReferenceSignals {
  /** Order names named in THIS message, first-appearance order, normalized. */
  explicit: string[];
  /** Order names this message explicitly excludes. */
  negated: string[];
  /** The customer asked for their most recent order. */
  wantsLatest: boolean;
  /** The customer told us to drop the order we were discussing. */
  resetsContext: boolean;
}

/** "#1010" / "1010" / " 01010 " → "1010". */
export function normalizeOrderName(raw: unknown): string {
  return String(raw ?? "").trim().replace(/^#/, "").replace(/^0+(?=\d)/, "");
}

function collect(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const n = normalizeOrderName(m[1]);
    if (n) out.push(n);
  }
  return out;
}

/**
 * Read the order references out of one customer message.
 *
 * Negation wins over selection for the SAME number: "לא 1006, 1010" names two
 * numbers, and only one of them is being asked for.
 */
export function extractOrderReferences(text: string): OrderReferenceSignals {
  const t = String(text ?? "");
  const negated = Array.from(new Set(collect(NEGATED_REF, t)));
  const listed: string[] = [];
  for (const m of t.matchAll(ORDER_LIST)) {
    for (const part of String(m[1] ?? "").split(LIST_SEPARATOR)) {
      const n = normalizeOrderName(part.replace(/#/g, ""));
      if (/^\d{2,}$/.test(n)) listed.push(n);
    }
  }
  const named = [
    ...collect(HASH_REF, t),
    ...collect(WORDED_REF, t),
    ...listed,
    ...collect(ONLY_REF, t),
  ];
  const explicit = Array.from(new Set(named)).filter((n) => !negated.includes(n));
  return {
    explicit,
    negated,
    wantsLatest: LATEST_RE.test(t),
    resetsContext: RESET_RE.test(t) || negated.length > 0,
  };
}

/** Tool arguments that identify an order. */
function targetFromArgs(args: Record<string, unknown>): string | null {
  const raw = (args?.order_name ?? args?.order_id) as unknown;
  const n = normalizeOrderName(raw);
  return n || null;
}

export interface TargetVerdict {
  ok: boolean;
  /** Model-facing explanation when blocked. Never shown to a customer as-is. */
  reason?: string;
  expected?: string[];
  got?: string;
}

/**
 * Fence a tool call against what the customer just said.
 *
 * Only two things block, and both are cases where proceeding would contradict
 * the customer in writing:
 *
 *   1. the target is a number this message explicitly excluded
 *   2. this message named order(s) and the target is none of them
 *
 * A message that names no order does not constrain anything - the existing
 * resolution path (active order, latest order) still applies. This guard adds
 * certainty where the customer supplied it; it does not invent it.
 *
 * `order_id` targets are compared too: a numeric internal id will simply not
 * match a named order, and that is the correct outcome - a financial action
 * that cannot be shown to concern the order the customer named should not run
 * silently.
 */
export function assertOrderTargetMatchesTurn(opts: {
  message: string;
  args: Record<string, unknown>;
  /** Set for tools that move money or cancel. Reads are not fenced. */
  isStateChanging: boolean;
}): TargetVerdict {
  if (!opts.isStateChanging) return { ok: true };
  const target = targetFromArgs(opts.args);
  if (!target) return { ok: true }; // nothing to compare; resolver owns it

  const sig = extractOrderReferences(opts.message);

  if (sig.negated.includes(target)) {
    return {
      ok: false,
      got: target,
      expected: sig.explicit,
      reason:
        `the customer's latest message explicitly EXCLUDES order ${target}` +
        (sig.explicit.length ? `, and names ${sig.explicit.map((o) => `#${o}`).join(" / ")} instead` : "") +
        `. Re-issue the action against the order they actually named. Do not act on ${target}.`,
    };
  }

  if (sig.explicit.length && !sig.explicit.includes(target)) {
    return {
      ok: false,
      got: target,
      expected: sig.explicit,
      reason:
        `the customer's latest message names order ${sig.explicit.map((o) => `#${o}`).join(" / ")}, ` +
        `but this action targets ${target}. Re-issue it against the order they named, or ask which order they mean.`,
    };
  }

  return { ok: true };
}

/**
 * Tools whose target must agree with the current message.
 *
 * Deliberately narrow: cancellations, refunds and invoices are the actions
 * where acting on a stale order is expensive and hard to undo. Reads are not
 * fenced - answering about the wrong order is a bad answer, but re-reading is
 * free and the model can correct itself from the result.
 */
export function isOrderStateChangingTool(toolFunctionName: string): boolean {
  const t = toolFunctionName.toLowerCase();
  return (
    /(^|\.)(cancel_order|process_refund|send_invoice|update_order_fulfillment)$/.test(t)
  );
}
