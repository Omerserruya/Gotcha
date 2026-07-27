/**
 * DEAD CODE - UNREACHABLE, PENDING REMOVAL.
 *
 * Nothing imports this. It implements a popup + postMessage contract that iCount
 * does not actually offer: the real flow is a redirect with a server-to-server
 * callback. It is retained only so the eventual redirect implementation can be
 * diffed against it, and MUST be deleted in the round that lands that flow.
 *
 * Do not import it. A provider token must never originate in a browser.
 *
 * ---
 *
 * iCount PayPage client flow - the browser side of secure card capture.
 *
 * Trust model (defense in depth):
 *   1. The card is entered ONLY on the provider-hosted PayPage (popup). GOTCHA
 *      never renders a PAN field and never sees card data.
 *   2. The popup reports back a SHORT-LIVED page token via postMessage. That
 *      message is untrusted browser input: we accept it only from the exact
 *      PayPage origin and only in the expected shape - anything else is
 *      silently ignored (never an error path an attacker can steer).
 *   3. The token is worthless by itself: the backend confirms it with iCount
 *      server-side (paypage/get_token_info + J5 verification) before anything
 *      is stored, and binds the result to the AUTHENTICATED tenant. A forged
 *      or replayed token fails that confirmation.
 *   4. Only provider references (token id, brand, last4, expiry) are ever
 *      persisted - see services/billing payment-methods route.
 *
 * This module is deliberately split into pure, unit-testable validators
 * (payPageOrigin / parsePayPageMessage) and the impure popup orchestration
 * (openPayPage) that composes them.
 */

/** Message shape the PayPage posts on completion. */
export interface PayPageTokenMessage {
  type: "icount:paypage";
  pageToken: string;
}

export type PayPageOutcome =
  | { status: "success"; pageToken: string }
  | { status: "cancelled" } // user closed the popup without completing
  | { status: "timeout" } // no result within the allotted window
  | { status: "blocked" }; // popup blocked by the browser

/** The exact origin the PayPage is allowed to postMessage from, or null when
 *  the configured URL is unparseable (in which case NO message is trusted). */
export function payPageOrigin(payPageUrl: string | undefined | null): string | null {
  if (!payPageUrl) return null;
  try {
    return new URL(payPageUrl).origin;
  } catch {
    return null;
  }
}

/** Validate an untrusted postMessage payload. Returns the page token only for
 *  the exact expected shape; anything else → null (ignored, never thrown). */
export function parsePayPageMessage(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.type !== "icount:paypage") return null;
  if (typeof m.pageToken !== "string") return null;
  const token = m.pageToken.trim();
  // Sanity bounds: a page token is a short opaque reference, not a blob.
  if (token.length < 4 || token.length > 512) return null;
  return token;
}

/** Should this message event be accepted? Origin must match the PayPage origin
 *  exactly; a null expected origin rejects everything. */
export function isTrustedPayPageEvent(eventOrigin: string, expectedOrigin: string | null): boolean {
  return expectedOrigin !== null && eventOrigin === expectedOrigin;
}

/**
 * Open the hosted PayPage and resolve with the outcome. Never rejects - every
 * failure mode is a typed outcome the caller renders honestly.
 */
export function openPayPage(
  payPageUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<PayPageOutcome> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // card entry can take a while
  const expectedOrigin = payPageOrigin(payPageUrl);

  return new Promise((resolve) => {
    const popup = window.open(payPageUrl, "icount-paypage", "width=480,height=640");
    if (!popup) {
      resolve({ status: "blocked" });
      return;
    }

    let settled = false;
    const settle = (outcome: PayPageOutcome) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(closePoll);
      clearTimeout(timer);
      try {
        popup.close();
      } catch {
        /* already closed */
      }
      resolve(outcome);
    };

    const onMessage = (event: MessageEvent) => {
      if (!isTrustedPayPageEvent(event.origin, expectedOrigin)) return; // ignore, keep listening
      const token = parsePayPageMessage(event.data);
      if (!token) return; // malformed - ignore, keep listening
      settle({ status: "success", pageToken: token });
    };

    // User closed the popup without finishing → cancellation, not an error.
    const closePoll = setInterval(() => {
      if (popup.closed) settle({ status: "cancelled" });
    }, 500);

    const timer = setTimeout(() => settle({ status: "timeout" }), timeoutMs);

    window.addEventListener("message", onMessage);
  });
}
