/**
 * What to say when a screen renders but the ids a spec needs are not there.
 *
 * ── WHY THIS IS ONE STRING AND NOT ELEVEN ──
 * Every spec had its own wording, and all of them **named a single cause for
 * a symptom with at least four.** The message said *"the SERVED BUILD predates
 * this screen"*, so the person reading it checked the build — correctly, and
 * first, because that is what it told them to do — and only afterwards found
 * the real cause, a 429 from running the whole suite at once.
 *
 * That is the same mistake as keying a guard on *"was a query typed"* instead
 * of *"are rows on screen"*: **asserting an explanation where an observation
 * belongs.** A failure message is read by someone who does not yet know what
 * went wrong; naming one cause sends them down it.
 *
 * So this describes what was seen and orders the candidates by how cheap they
 * are to rule out — cheapest and most common first.
 *
 * ── AND WHY 3b EXISTS ──
 * Check 3 compares two things **on disk**, and a 404 on a route that was in
 * the build turned out to be a server process 36 minutes OLDER than the
 * BUILD_ID it was meant to serve. Check 3 passed: `src` was older than
 * `BUILD_ID`, so both artefacts agreed with each other.
 *
 * **The running process is not on disk, so no amount of stat-ing finds it.**
 * Every candidate this list offered was the same KIND of check, which is how
 * a list of four causes still pointed away from the real one.
 */
/**
 * Why an expected element is absent when a SIBLING branch says the read failed.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ THE FIFTH CAUSE, AND THE ONE THAT LOOKS MOST LIKE A FLAKE
 * ════════════════════════════════════════════════════════════════════════════
 * `credits · no metering is not no activity` failed once at 390px in a
 * 78-test run and passed alone in 2.1s. The obvious reading was a timeout:
 * the page helpers wait 15s and that assertion used the default 5s.
 *
 * It cannot have been. These screens are SERVER components — by the time the
 * page helper has confirmed its landmark, the whole HTML exists and the
 * element is either in it or it is not. **There is no later fetch for a
 * longer timeout to catch.**
 *
 * What removes it is the section's own read failing: the loader catches, the
 * value is null, and the section renders its `*-unavailable` branch instead.
 * Against a 1,000-request-per-fifteen-minutes budget, with a settings page
 * costing ~10 reads and 78 tests in flight, a 429 on one endpoint is the
 * likeliest cause by some distance.
 *
 * In that case a longer timeout fails slower rather than passing, and a retry
 * that happens to pass teaches nothing — which is exactly how a real
 * rate-limit signal gets recorded as a flake and thrown away.
 *
 * ── HOW WIDE THIS IS ──
 * The UI can render 22 distinct "we could not read this" testids. Sixteen of
 * the twenty-one specs mention NONE of them, so they cannot tell a failed
 * read from a missing element and would report the wrong cause for both.
 *
 * Pass the failure branch that belongs to the section under test. It is only
 * consulted when the element is absent, so a branch that is legitimately on
 * screen for this tenant — `breakdown-unavailable` is — costs nothing.
 */
export function readFailed(testId: string, failureBranch: string): string {
  return (
    `${testId} is absent because THE READ FOR THIS SECTION FAILED — it rendered ` +
    `\`${failureBranch}\`, so the element was never in the HTML and no timeout ` +
    'would have helped.\n' +
    '  Most likely a 429. `rateLimit({ windowMs: 15*60*1000, max: 1000 })` is per\n' +
    '  IP per service — a window, not a rate — and a settings page costs ~10 reads.\n' +
    '  ★ Re-running this one test alone WILL pass and will prove nothing. Wait the\n' +
    '  window out, then run the file once. A retry that passes is not a run that\n' +
    '  passed.'
  );
}

export function missingIds(what: string): string {
  return (
    `${what} is absent, though the page rendered. Check in this order:\n` +
    '  1. a 429 from PARALLELISM — run ONE spec, not the suite.\n' +
    '  1b. a 429 from BUDGET, which serialising does NOT fix. The limit is\n' +
    '      `rateLimit({ windowMs: 15*60*1000, max: 1000 })` in service-app.ts —\n' +
    '      1,000 requests per FIFTEEN MINUTES per IP per service, shared across\n' +
    '      every capture run in that window. A screen that fans out to six\n' +
    '      endpoints costs six times its test count: the two billing specs are\n' +
    '      ~600 requests for one pass of the pair. `--workers=1` does not help,\n' +
    '      because the budget is a window and not a rate. WAIT IT OUT.\n' +
    '  2. a 401 — `gotcha_session` ROTATES on every BFF request, so a reused\n' +
    '      cookie is spent. ★ AND SO IS A COOKIE YOU PROBED TO CHECK: each curl\n' +
    '      against the BFF rotates it, so verifying the session is what spends\n' +
    '      it. Three probes, then a 96-test run that failed with rendered pages\n' +
    '      and no ids — read as a screen defect. Do not test the credential;\n' +
    '      mint a fresh one and smoke-test ONE spec before spending the budget.\n' +
    '  3. a stale build — `stat -c %y .next/BUILD_ID` and `find src -newer .next/BUILD_ID`.\n' +
    '  3b. a stale PROCESS. Identify it by what is LISTENING — not by name, and\n' +
    "      not by working directory. This machine also runs the platform's own\n" +
    '      next-server, and a `next build` leaves workers in OUR cwd that have\n' +
    '      already exited, so both of those return a start time for something\n' +
    '      that is not serving the page:\n' +
    '        ss -ltnp | grep :3000      # the one pid that can be responsible\n' +
    '        ps -o lstart= -p <that pid>\n' +
    '      Compare it to `stat -c %y .next/BUILD_ID`. A build NEWER than the\n' +
    '      running server serves the OLD one, and check 3 still passes: src is\n' +
    '      older than BUILD_ID, so both artefacts on disk agree with each other.\n' +
    '  4. a real regression, which is the least likely and the only one worth reporting.'
  );
}
