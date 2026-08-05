/**
 * Recovering from the un-guessable choice.
 *
 * Meta makes us pick an Embedded Signup flow BEFORE authorization:
 *
 *   business-app  extras.featureType = "whatsapp_business_app_onboarding"
 *   new           standard Embedded Signup, no featureType
 *
 * and the field that would tell us which was right - `is_on_biz_app` - is only
 * readable through a `<PHONE_NUMBER_ID>` we can access, which only exists once
 * authorization has already happened. So the customer has to guess, and some
 * of them will guess wrong.
 *
 * This module turns "wrong guess" from a dead end into one click. It is pure:
 * candidates in, an explanation out. No network, no database, no React, so
 * every branch is unit-testable without a Meta account.
 *
 * The rule it exists to enforce: **never return a bare empty state.** Every
 * outcome carries a reason code, and the UI is expected to say something
 * specific for each one.
 */

/** The two flows Meta offers. */
export type SignupPath = "new" | "business-app";

export type PathOutcomeReason =
  /** Meta returned nothing at all for this flow. */
  | "NO_CANDIDATES"
  /** Business app flow, but nothing found is actually on the Business app. */
  | "NO_BUSINESS_APP_NUMBER"
  /** Numbers were found, but this workspace already has all of them. */
  | "ALL_ALREADY_CONNECTED"
  /**
   * Numbers were found but every one has a blocker (connected to another
   * workspace, banned, webhooks owned elsewhere). Switching flows cannot help,
   * and each candidate already carries its own explanation.
   */
  | "ALL_BLOCKED"
  /** Numbers were found and something is connectable. */
  | "OK";

/**
 * The subset of a candidate this decision needs.
 *
 * Deliberately minimal so the caller can pass its own richer shape and so
 * tests do not have to build a whole inspection.
 */
export interface PathCandidate {
  usesBusinessApp?: boolean;
  alreadyConnectedHere?: boolean;
  scenario?: string;
}

export interface PathOutcome {
  /** The flow that produced these candidates. */
  path: SignupPath;
  /** How many the customer could actually connect right now. */
  eligibleCount: number;
  /**
   * The other flow, when switching would plausibly help. `null` when it would
   * not, so the UI never offers a pointless relaunch: telling someone to try
   * again a different way when the outcome will be identical is worse than
   * telling them plainly what is going on.
   */
  switchTo: SignupPath | null;
  reason: PathOutcomeReason;
}

/** The other one. Trivial, but it keeps the pairing in a single place. */
export function otherPath(path: SignupPath): SignupPath {
  return path === "new" ? "business-app" : "new";
}

/**
 * Can the customer connect this candidate right now?
 *
 * `BLOCKED` covers the fatal cases the flow selector already identified
 * (connected to another workspace, on-premise, banned, webhooks owned
 * elsewhere). Already connected here is not a failure, but it is not
 * something to connect again either.
 */
function isEligible(c: PathCandidate, path: SignupPath): boolean {
  if (c.alreadyConnectedHere) return false;
  if (c.scenario === "BLOCKED") return false;
  // The Business app flow is only satisfied by a number actually on that app.
  // Meta can return others alongside; connecting one of those through the
  // Coexistence door would onboard the wrong thing the wrong way.
  if (path === "business-app" && !c.usesBusinessApp) return false;
  // NOTE the deliberate asymmetry: under the STANDARD path a number with
  // `is_on_biz_app: true` stays eligible. If it surfaced here at all it is
  // already on Cloud API, so it was onboarded to Coexistence previously and
  // the flow selector will route it to COEXISTENCE and skip registration.
  // Excluding it would block a perfectly good connection. A Business app
  // number NOT yet on Cloud API never appears in this flow, so the signal we
  // act on is its absence, not its presence.
  return true;
}

/**
 * Decide what to tell the customer after an inspection.
 *
 * Always returns an outcome. `reason: "OK"` means get on with it.
 */
export function evaluatePathOutcome(
  path: SignupPath,
  candidates: PathCandidate[],
): PathOutcome {
  const eligible = candidates.filter((c) => isEligible(c, path));

  if (eligible.length > 0) {
    return { path, eligibleCount: eligible.length, switchTo: null, reason: "OK" };
  }

  // Nothing to connect. The only question worth answering now is whether the
  // OTHER flow would plausibly have done better. A relaunch costs the customer
  // a full re-authorization, so it is offered only when it genuinely might
  // help - suggesting it when the outcome would be identical is worse than
  // saying plainly what is wrong.

  // Meta showed nothing at all. This is the one case where the other door is
  // the obvious next try, because each flow is blind to the other's numbers.
  if (candidates.length === 0) {
    return { path, eligibleCount: 0, switchTo: otherPath(path), reason: "NO_CANDIDATES" };
  }

  // Everything we found is already ours. Re-authorizing down the other path
  // reaches the same numbers, so there is nothing to suggest.
  if (candidates.every((c) => c.alreadyConnectedHere)) {
    return { path, eligibleCount: 0, switchTo: null, reason: "ALL_ALREADY_CONNECTED" };
  }

  // Business app flow, and nothing that came back is on the Business app. The
  // standard flow is where these numbers belong.
  if (path === "business-app" && !candidates.some((c) => c.usesBusinessApp)) {
    return { path, eligibleCount: 0, switchTo: "new", reason: "NO_BUSINESS_APP_NUMBER" };
  }

  // Numbers exist and are the right kind for this flow, but each carries its
  // own blocker. Those blockers are already displayed per candidate, and none
  // of them is fixed by starting again somewhere else.
  return { path, eligibleCount: 0, switchTo: null, reason: "ALL_BLOCKED" };
}
