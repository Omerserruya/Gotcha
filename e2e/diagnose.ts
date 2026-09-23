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
export function missingIds(what: string): string {
  return (
    `${what} is absent, though the page rendered. Check in this order:\n` +
    '  1. a 429 — run ONE spec, not the suite. 470 tests in parallel trip the rate limiter.\n' +
    '  2. a 401 — `gotcha_session` rotates on every BFF request, so a reused cookie is spent.\n' +
    '  3. a stale build — `stat -c %y .next/BUILD_ID` and `find src -newer .next/BUILD_ID`.\n' +
    '  3b. a stale PROCESS — `ps -o lstart= -p $(pgrep -f next-server)` against that\n' +
    '      same BUILD_ID time. A build NEWER than the running server serves the old\n' +
    '      one, and check 3 passes: src is older than BUILD_ID, so both artefacts on\n' +
    '      disk agree. The stale thing is neither of them.\n' +
    '  4. a real regression, which is the least likely and the only one worth reporting.'
  );
}
