/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★ A COPY OF
 *   ChatCenter/frontend/src/lib/whatsapp-signup-flow.ts
 *   - verbatim when it was made, and **no longer**. See the end of this note.
 *
 * Copied, not reimplemented, and the reason is one line inside it:
 *
 *     `endsWith("facebook.com")` alone would accept `evilfacebook.com`
 *
 * That is a bug somebody already found and fixed once. Rewriting this module
 * from memory in a second repository is exactly how it comes back - and it
 * would come back SILENTLY, because a wrong origin check passes every test
 * that does not specifically attack it.
 *
 * The two test files beside this one were copied FIRST and watched to fail
 * against nothing, so the property is pinned here by the same assertions that
 * pin it there, rather than by anyone's reading of them.
 *
 * The two repositories share no build, no types and no test - only a runtime
 * contract with Meta. Whether this logic should live in a shared package is an
 * architecture decision with Omer, not something to settle by picking a repo.
 * Until then this is a duplicate WITH A POINTER, which is a chore; a duplicate
 * nobody knows is duplicated is the hazard.
 *
 * If you change this file, change the other one.
 *
 * ⚠⚠ THAT INSTRUCTION WAS NOT FOLLOWED, BY ME, ONE COMMIT LATER.
 * Measured 2026-09-28, both files as they stand:
 *
 *     this copy at `79c81d9` (when made)  vs ChatCenter today    0 differ
 *     this copy today                     vs ChatCenter today   48 differ
 *                                       (code lines, quote style normalised)
 *
 * **It was verbatim. We drifted; they did not.** `750625b` replaced eight
 * `any`s with `unknown` plus the `field()`/`text()` accessors below, to satisfy
 * `@typescript-eslint/no-explicit-any` - a **repo-wide lint gate** with no way
 * to know that this one file answers to another repository. I wrote that
 * commit and did not think of it as "changing this file". I thought of it as
 * fixing eleven lint errors.
 *
 * ★ THAT IS A STRONGER ARGUMENT THAN "TWO COPIES MIGHT DRIFT". A
 *   cross-repository sync instruction living in a comment is invisible to
 *   every gate this project runs. It did not fail through carelessness - the
 *   mechanism that changed the file was not reading comments.
 *
 * ⚠ AND THE DRIFT CARRIED A BUG FIX THAT HAS NOT PROPAGATED. `750625b` also
 *   filtered `waba_ids` to non-empty strings. ChatCenter's copy still reads
 *   `payload.data?.waba_ids || …` unfiltered, so a list with a null in it
 *   still becomes a waba id of `null` further down **over there**. Not fixed
 *   here: that repository is read-only to this session. Reported instead.
 *
 * ★ The security-critical line is still identical in both, modulo quotes -
 *   `host === 'facebook.com' || host.endsWith('.facebook.com')` - which is the
 *   part the copy exists for, and it survived because the lint rule happened
 *   not to touch it. **Luck, not design.**
 * ════════════════════════════════════════════════════════════════════════════
 */
/**
 * Pure logic for the Embedded Signup launcher.
 *
 * Extracted from the component so the awkward parts - a cancelled popup, a
 * popup that never opens, a `postMessage` that arrives in pieces - are unit
 * testable without a browser, a Meta account, or React. Every function here is
 * total: same input, same output, no side effects.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ⚠ NOTHING IN THIS APP CALLS ANY OF IT YET, AND THAT IS THE STATE TO KNOW
 * ═════════════════════════════════════════════════════════════════════════════
 * The launcher component does not exist, so there is **no `message` listener
 * anywhere in this codebase** - checked, not assumed. `isMetaOrigin` is
 * therefore dormant rather than bypassed: there is no unguarded handler.
 * `scripts/unused-guard-sweep.ts` reports it with no callers, and this is the
 * answer.
 *
 * ★★ SO THE ONE THING THAT MATTERS WHEN SOMEBODY BUILDS THE LAUNCHER: the
 *   origin check has to be WIRED to the listener, not merely present. A guard
 *   that exists and is never called is worse than none, because the file's
 *   existence is the reassurance - `safeLinkUrl` sat here with passing tests
 *   and zero callers while two screens rendered somebody else's string into an
 *   `href`. Every `message` handler starts by refusing an origin this module
 *   does not recognise.
 */

/** Asset ids the Embedded Signup popup reports back. */
export interface SignupAssets {
  businessPortfolioId?: string;
  wabaIds?: string[];
}

/** What a `WA_EMBEDDED_SIGNUP` message means for us. */
export type SignupMessage =
  | { kind: 'cancel'; step?: string }
  | { kind: 'assets'; assets: SignupAssets; event: string }
  | { kind: 'ignore' };

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
    return host === 'facebook.com' || host.endsWith('.facebook.com');
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
/**
 * One field of a value that may not be an object, without `any`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHY NOT `any`, WHICH IS WHAT THIS FILE USED
 * ════════════════════════════════════════════════════════════════════════════
 * Everything here reads a payload Meta's SDK hands over, whose shape this build
 * has never been promised. `as any` expresses that honestly and then **turns off
 * the checking for everything downstream**: a typo in `authResponse` compiles,
 * and on this path a silently-undefined field is the difference between "the
 * customer declined" and "we lost the authorization code".
 *
 * `unknown` plus this accessor keeps the honesty and keeps the checking. Every
 * read is explicit about the level it is at, and nothing narrows a value without
 * saying so.
 */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A string field, or undefined - never an empty string masquerading as one. */
function text(value: unknown, key: string): string | undefined {
  const found = field(value, key);
  return typeof found === 'string' && found !== '' ? found : undefined;
}

export function interpretSignupMessage(raw: unknown): SignupMessage {
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return { kind: 'ignore' };
    }
  }
  if (field(payload, 'type') !== 'WA_EMBEDDED_SIGNUP') return { kind: 'ignore' };

  const data = field(payload, 'data');
  const event = field(payload, 'event');

  if (event === 'CANCEL') {
    return { kind: 'cancel', step: text(data, 'current_step') };
  }

  const businessPortfolioId = text(data, 'business_id');
  /*
   * `waba_ids` when Meta sends a list, `waba_id` when it sends one. Filtered to
   * strings rather than trusted: a list with a null in it used to become a waba
   * id of `null` further down, and this is the only place that can be caught.
   */
  const list = field(data, 'waba_ids');
  const wabaIds: string[] = Array.isArray(list)
    ? list.filter((id): id is string => typeof id === 'string' && id !== '')
    : (() => {
        const single = text(data, 'waba_id');
        return single ? [single] : [];
      })();

  if (!businessPortfolioId && wabaIds.length === 0) return { kind: 'ignore' };
  return {
    kind: 'assets',
    assets: { businessPortfolioId, wabaIds },
    event: typeof event === 'string' ? event : '',
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
  return text(field(response, 'authResponse'), 'code') ?? null;
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
export type SignupAbort = 'DISMISSED' | 'NO_CODE';

export function classifySignupAbort(response: unknown): SignupAbort {
  const auth = field(response, 'authResponse');
  const hasAuthResponse = auth != null && typeof auth === 'object';
  if (hasAuthResponse || field(response, 'status') === 'connected') return 'NO_CODE';
  return 'DISMISSED';
}

/**
 * The response shape, with nothing sensitive in it, for a console breadcrumb.
 *
 * Never includes `code` or any token - only whether the fields were present,
 * which is all that is needed to tell the two aborts apart after the fact.
 */
export function describeSignupResponse(response: unknown): string {
  const auth = field(response, 'authResponse');
  return [
    `status=${text(response, 'status') ?? '-'}`,
    `authResponse=${auth ? 'present' : 'absent'}`,
    `code=${text(auth, 'code') ? 'present' : 'absent'}`,
    `keys=${auth && typeof auth === 'object' ? Object.keys(auth).join('|') || '-' : '-'}`,
  ].join(' ');
}

/**
 * Translation key for an outcome, so copy stays out of the logic.
 *
 * Path-independent since the move to Embedded Signup v4: there is one flow, so
 * an outcome describes the numbers themselves rather than which door was tried.
 */
export function outcomeMessageKey(reason: string): string {
  const map: Record<string, string> = {
    NO_CANDIDATES: 'whatsappNumbers.outcome.noCandidates',
    ALL_ALREADY_CONNECTED: 'whatsappNumbers.outcome.allAlreadyConnected',
    ALL_BLOCKED: 'whatsappNumbers.outcome.allBlocked',
  };
  return map[reason] || 'whatsappNumbers.outcome.unknown';
}
