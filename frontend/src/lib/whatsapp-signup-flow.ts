/**
 * Pure logic for the Embedded Signup launcher.
 *
 * Extracted from the component so the awkward parts - a cancelled popup, a
 * popup that never opens, a `postMessage` that arrives in pieces - are unit
 * testable without a browser, a Meta account, or React. Every function here is
 * total: same input, same output, no side effects.
 */


/** Asset ids the Embedded Signup popup reports back. */
export interface SignupAssets {
  businessPortfolioId?: string;
  wabaIds?: string[];
}

/** What a `WA_EMBEDDED_SIGNUP` message means for us. */
export type SignupMessage =
  | { kind: "cancel"; step?: string }
  | { kind: "assets"; assets: SignupAssets; event: string }
  | { kind: "ignore" };


/**
 * Is this message actually from Meta?
 *
 * `endsWith("facebook.com")` alone would accept `evilfacebook.com`, so the
 * check is anchored on a dot or an exact host. This runs on every window
 * message the page receives, including ones from unrelated extensions.
 */
export function isMetaOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

/**
 * Interpret one postMessage payload.
 *
 * Unknown `event` values deliberately fall through to "ignore" rather than
 * being treated as failure: Embedded Signup v2 is deprecated on 2026-10-15 and
 * v4 may introduce completion events this build has never seen. Treating an
 * unrecognised event as a cancellation would break the flow the day Meta ships
 * one.
 */
export function interpretSignupMessage(raw: unknown): SignupMessage {
  let payload: any = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return { kind: "ignore" };
    }
  }
  if (!payload || payload.type !== "WA_EMBEDDED_SIGNUP") return { kind: "ignore" };

  if (payload.event === "CANCEL") {
    return { kind: "cancel", step: payload.data?.current_step };
  }

  const businessPortfolioId = payload.data?.business_id;
  const wabaIds: string[] =
    payload.data?.waba_ids || (payload.data?.waba_id ? [payload.data.waba_id] : []);

  if (!businessPortfolioId && wabaIds.length === 0) return { kind: "ignore" };
  return {
    kind: "assets",
    assets: { businessPortfolioId, wabaIds },
    event: String(payload.event || ""),
  };
}

/**
 * Fold a new report into what we already know.
 *
 * Merge, never replace. Meta can emit several events for one flow, and a later
 * one that omits `business_id` must not erase it - that field is the only
 * source of the business portfolio id, and losing it silently downgrades the
 * whole inspection while everything still looks fine.
 */
export function mergeSignupAssets(prev: SignupAssets, next: SignupAssets): SignupAssets {
  return {
    businessPortfolioId: next.businessPortfolioId || prev.businessPortfolioId,
    wabaIds: next.wabaIds?.length ? next.wabaIds : prev.wabaIds,
  };
}

/**
 * Pull the authorization code out of an `FB.login` response.
 *
 * Returns null when the customer closed the popup or declined, which is a
 * normal outcome and not an error.
 */
export function readAuthCode(response: unknown): string | null {
  const code = (response as any)?.authResponse?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * What happened when no authorization code came back.
 *
 * `DISMISSED` is the ordinary case - the customer shut the popup - and deserves
 * silence. `NO_CODE` is not: the flow ran to completion and Meta still handed
 * back nothing usable.
 *
 * Collapsing the two is what made a live failure invisible. A customer finished
 * the whole Embedded Signup, the popup closed itself, and the panel quietly
 * returned to its starting state - no message, no error, and no request to our
 * server, so nothing in the logs either. From the outside it was
 * indistinguishable from never having clicked the button.
 *
 * Meta reports a dismissal as `status: "unknown"` with no `authResponse` at
 * all. Anything that carries an `authResponse`, or reports `connected`, got far
 * enough that a missing code is a real fault worth naming.
 */
export type SignupAbort = "DISMISSED" | "NO_CODE";

export function classifySignupAbort(response: unknown): SignupAbort {
  const r = response as any;
  const hasAuthResponse = r?.authResponse != null && typeof r.authResponse === "object";
  if (hasAuthResponse || r?.status === "connected") return "NO_CODE";
  return "DISMISSED";
}

/**
 * The response shape, with nothing sensitive in it, for a console breadcrumb.
 *
 * Never includes `code` or any token - only whether the fields were present,
 * which is all that is needed to tell the two aborts apart after the fact.
 */
export function describeSignupResponse(response: unknown): string {
  const r = response as any;
  const auth = r?.authResponse;
  return [
    `status=${r?.status ?? "-"}`,
    `authResponse=${auth ? "present" : "absent"}`,
    `code=${typeof auth?.code === "string" && auth.code.length > 0 ? "present" : "absent"}`,
    `keys=${auth && typeof auth === "object" ? Object.keys(auth).join("|") || "-" : "-"}`,
  ].join(" ");
}


/**
 * Translation key for an outcome, so copy stays out of the logic.
 *
 * Path-independent since the move to Embedded Signup v4: there is one flow, so
 * an outcome describes the numbers themselves rather than which door was tried.
 */
export function outcomeMessageKey(reason: string): string {
  const map: Record<string, string> = {
    NO_CANDIDATES: "whatsappNumbers.outcome.noCandidates",
    ALL_ALREADY_CONNECTED: "whatsappNumbers.outcome.allAlreadyConnected",
    ALL_BLOCKED: "whatsappNumbers.outcome.allBlocked",
  };
  return map[reason] || "whatsappNumbers.outcome.unknown";
}
