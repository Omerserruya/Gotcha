# Capture specs: what the five gates are for

These specs are not regression tests. They are **acceptance evidence** — they
produce the screenshots a screen is accepted on, and they are written by the
person who built the screen and run by someone else.

That split is the point. A capture one person describes and another performs is
the one place a screen gets accepted on a guess.

Everything below was learned by getting it wrong first. Each gate exists because
something reached a screenshot, or nearly did, that should not have.

## Running one

```bash
export PATH="$HOME/.local/share/node22/bin:$PATH"     # the default node here is 18; Playwright needs 20+
GOTCHA_SESSION='<gotcha_session cookie>' npx playwright test e2e/settings-<screen>.spec.ts
```

The PATH line is not optional. Under Node 18 Playwright fails with a message
that reads like it is not installed, which sends you to the wrong problem.

`settings-security.spec.ts` additionally needs the **server** started with
`E2E_SECURITY_FIXTURES=1` — see gate 2.

And check what is actually being served before you believe a green run:

```bash
stat -c '%y' .next/BUILD_ID          # must be newer than the commits you are testing
find src -type f -newer .next/BUILD_ID   # must be empty
ss -lptn 'sport = :3000'             # the pid must have changed since you restarted
```

`next start` serves `.next`. A clean tree and a green `verify` say nothing about
what is running. This check has caught a stale bundle three times, once after a
restart that silently failed on `EADDRINUSE` and left the old process serving.

---

## Gate 0 — no source file is newer than the running build

Run this before every capture. It costs one second and it has already cost us a run.

```bash
find src e2e -newer .next/BUILD_ID -type f      # must print nothing
```

**If it prints a file, that file's changes are not in the running build** and the capture
photographs the previous screen. The capture will not say so — it produces a clean, plausible
failure against code that is not running, and the natural next move is to debug the fix instead
of the build.

**The timestamp comparison is a hint, not the gate.** `stat -c %y .next/BUILD_ID` against
`git show -s --format=%ci HEAD` will report a stale build whenever someone builds and *then*
commits, which is the normal order — BUILD_ID ends up seconds older than HEAD while containing
every line of it. Sending that person to rebuild a correct build is the same class of
wrong-thing-checked this gate exists to prevent. **"Nothing in `src` is newer than the build" is
the thing itself; the timestamp is a proxy for it.**

When it does print something, **judge it and say so out loud** rather than silently deciding it
did not matter. Measured 2026-09-22: it printed four `features/customers` files while the three
Studio specs were being run. Nothing that could reach a Studio screen — but the gate had done its
job by making that a decision instead of an assumption.

**Three forms of the same trap, and Gate 0's content check only catches the first:**
```
source newer than build     find src e2e -newer .next/BUILD_ID   ← the content check
build newer than PROCESS    ps -o lstart= -p <pid>  vs  stat -c %y .next/BUILD_ID
capture against either
```
Measured 2026-09-23: `next-server` started 16:43:35, `BUILD_ID` 17:19:59. **The build was
current, `src` was older than it, the content check passed — and the running process was
thirty-six minutes behind, so a new route 404'd.** Nothing in `src` or `.next` was stale.

**The general form, which caught three people on this project in one day:**

> **A check that runs against an artifact older than the change it is checking returns a clean
> result and means nothing.** A restart that reloaded a baked image with no source mount. An
> unauthenticated probe against a service that authenticates before it routes. A capture against
> a stale build. None of them announce themselves.

---

## The request budget is 1,000 per fifteen minutes, and it is shared

```ts
// ChatCenter packages/shared/src/lib/service-app.ts:62 — EVERY service
rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 })
```

**Per IP, per service, in a fifteen-minute WINDOW.** `--workers=1` does not help: serialising
changes the rate, not the budget.

**Count the fan-out, not the tests.** The billing screen calls six endpoints per page load:
```
/billing/pricing · /pricing/packages · /plans · /subscription · /payment-methods · /pricing/current
```
`settings-billing` (66 tests) plus `settings-billing-plan` (36) is **~600 requests for one pass
of the pair**, and the budget covers every capture run in the preceding fifteen minutes.

**The symptom is a screen that renders blank sections and a testid that is "absent".** It looks
exactly like a regression. Check the server log for `"kind":"rate_limited"` before believing one:

```bash
grep -c rate_limited <server log>
```

**A page that renders correctly when you open it directly, and fails in the capture, is this.**

---

## Gate 0b — mutate a control before you trust it

**Reading a test tells you what it says. Mutating tells you what it can detect.** Those come
apart exactly where the fixtures are too tame to reach the boundary the assertion names.

Measured, 2026-09-23: a golden capture asserting *"byte-for-byte, the per-page slices are part
of the contract"* **passed when the slice was changed from 2800 to 2000** — every fixture page
was shorter than either bound, so the assertion described nothing. Fixed by adding pages that
straddle both boundaries; four mutations, four failures.

> **A control that cannot fail is the same failure as a template that is never emitted.** Both
> look like coverage. Neither can produce a negative result.

**A mocked query is blind to its own WHERE.** A mock returns what it was told to return however
it is called, so a result-shape assertion **cannot see the filter at all**. Measured: adding
`detectedLocale: { not: null }` to a grouped query passed every assertion in the test written to
keep undetected rows in the denominator. **Assert on the query as well as the result, or the
whole class of output assertions is decoration.**

**And a guard that pins half a rule rejects the right answer.** A source-scanning test asserting
the literal `isTest: false` **failed the one query in its file that excluded sandbox rehearsals
correctly**, because that one used the complete shared predicate.

> **It is not passive. It pushes back toward the wrong answer, and the person who hits it is the
> one doing it right.**

**It is not found by reading.** It is found by changing something you expect to be caught and
watching it not be. Three other instances this project, all the same shape:

- an absence assertion over a set where the thing could not appear (`/fire|retire|delete/` while
  delete did not exist)
- an assertion whose scope did not match its claim (`main` instead of the list)
- a probe that built its fixture, matched no anchor, and printed PASS

---

## Gate 1 — the screen must be the screen

Every spec's `open…()` helper refuses to photograph anything until it has
confirmed it is on the right page with the right build. Three checks, because a
missing test id has three quite different causes:

1. redirected to sign-in → the session cookie is missing or expired
2. no page heading → not this route; the app may not be serving
3. heading but no test ids → **the served build predates the test ids**

An earlier version blamed cause 1 for what was actually cause 3 and sent someone
to look at authentication for half an hour. **Failing loudly is only useful if it
fails accurately.**

Note also that `gotcha_session` rotates on every BFF request, so a saved cookie
is single-use outside Playwright. A 401 on a hand-rolled probe usually means the
cookie was spent, not that the route rejected you.

## Gate 2 — no personal data reaches an evidence file

Screen 16 renders a real IP address and the city someone signs in from, so
photographing the live list would put personal data into a file.

**Correction, 2026-09-19.** This gate used to say *"`e2e/evidence/` is
committed"*. It is not, and it never has been: the ignore rule was added in
`6112786`, the very commit that introduced evidence, and `git log` across all
branches shows **zero** commits touching `e2e/evidence/`. I wrote the wrong
reason down and it stood for three days.

The gate is unchanged, because the reason it exists was never really about
git. These files are written to disk, opened by whoever runs the capture, and
relayed between sessions and to the client. **"Not committed" is not "not
disclosed."**

And being ignored makes it *worse*, not better. A committed file has a history
someone could purge and a review that would have seen it. An ignored one sits
in a working directory indefinitely, invisible to every review, covered by no
retention or deletion process at all. So the correct reading is the opposite of
the tempting one: do not conclude from `.gitignore` that the fixtures are
unnecessary.

Network interception was the right mechanism and **is not available**: the pages
are server components, so those calls leave the Node process and `page.route`
never sees them. The substitution is therefore server-side, in
`src/features/security/capture-fixtures.ts`, gated on:

```
E2E_SECURITY_FIXTURES === '1'   AND   APP_ORIGIN is a loopback address
```

The second condition is the one doing the work, and it took two attempts:

- The first guard was `NODE_ENV !== 'production'`. **`next start` IS production
  mode** — Next sets it itself — so the clause was always false and the fixtures
  could never engage at all. Build mode describes how the bundle was compiled; it
  says nothing about whose machine is serving it.
- `APP_ORIGIN` being loopback answers the question that actually matters: *am I
  only reachable from this machine?* A host serving real people cannot be, because
  a browser anywhere else could never reach it.

It **fails closed**, and `isLoopbackOrigin` is tested in both directions — the
broken version was wrong in the *safe* direction and therefore produced no
symptom at all. A guard that never engages looks exactly like a guard that works.

Two more properties worth keeping if you write another one:

- **The fixtures are RFC 5737 documentation addresses** (`203.0.113.x`), reserved
  so they can never belong to anyone.
- **They are distinct from each other.** The screen's claim is that an unfamiliar
  session is recognisable; fixtures that made every row identical would pass a
  capture that proved nothing.

## Gate 3 — refuse rather than trust

`openSecurity()` asserts a `203.0.113.` address is on the page **before** taking
any screenshot. If the fixtures did not engage, the run fails with a message
saying why and writes nothing.

This is the only safety assertion on the project that has caught a real
condition. When the `NODE_ENV` guard was broken, 42 tests failed and
`e2e/evidence/s16` was left empty — instead of 21 screenshots of a real person's
sign-in locations sitting on disk and being passed around.

**Do not weaken a gate to make a run pass.** If it is firing, either the screen
is wrong or the gate is; both are worth knowing, and neither is fixed by
loosening the assertion.

## Gate 4 — assert what the screen says, not what it lacks

The habit that produced the most bugs here: asserting that something *wrong* is
absent instead of asserting that something *right* is present.

It fails in both directions:

- **Screen 14** shipped a banner reading `"Reconnecting {system} means…"` with
  the placeholder unreplaced. Every assertion on it was negative — must not say
  "holding", must not say "sync" — and a completely wrong message contains none
  of the forbidden words. Six screenshots, all green.
- **Screen 16** did the opposite. `expect(audit-unavailable).not.toHaveText(…)`
  still requires the element to exist, so when the audit routes shipped and the
  section rendered properly, a working screen failed.

So: state what the section must contain. Every spec now also carries the general
form of the first case:

```ts
await expect(page.locator('main')).not.toHaveText(/\{[a-zA-Z]+\}/);
```

No ICU placeholder may survive into rendered copy, anywhere. One line per spec,
catches the whole class.

## Gate 5 — pin the omissions and the substitutions

A great deal of this design describes things the backend cannot do. Every one of
those decisions is an assertion, so that restoring it from the mockup fails the
capture rather than shipping:

| Screen | Pinned |
| --- | --- |
| 12 | `person-role-*` matches no `[₪$€£]` or digit — per-person money limits do not exist |
| 13 | the count reads "open", never "live" — `not CLOSED` includes WAITING |
| 13 | the unavailable connect panel contains **no button** |
| 14 | the banner claims nothing is "held"; `lastTestedAt` is never "synced" |
| 17 | no "per extra conversation", no "spending cap", no "hours your team didn't spend" |

And the same for substitutions — screen 17 asserts the rendered plan name does
**not** match the shape of a snake_case key, because `ai_voice` shipped as the
most prominent line on the billing screen.

Rulings live longer than the people who made them. An assertion is how one
survives.

---

## Writing a new one

- **390 from the first commit**, alongside 1440 and 1280. It was added
  voluntarily on screen 12 and found two real defects in screens that had
  already been accepted.
- **Capture early** — before the screen is finished. On screen 11 every one of
  five defects was found by capture and none by 196 unit tests.
- **Diff the ids before running.** The ids a spec references against the ids the
  components emit. A scripted rename once left four `data-testid`s unwritten and
  the spec failed on the wrong thing.
- **Derive any set twice, by different routes, and `comm` the two.** This is the
  enumeration equivalent of the id diff, and it exists for the same reason: it
  produces a result whether or not you are paying attention, where "be careful"
  does not.

  Screen 15 needed the list of event types a notification rule may target. Two
  people derived it independently — one from the declared unions intersected
  with templates, one from actual emit call sites intersected with templates —
  and **both derivations were wrong, in different ways.** One silently dropped
  `system.error.critical`, because the pattern assumed two dotted segments and
  that name has three. The other counted types that are declared and templated
  and that nothing ever raises.

  Neither of us could have found our own error. The one-item disagreement
  between the two is what exposed both, and the item turned out to be the
  notification for the single thing an operator most wants to be woken up
  about — which cannot fire.

  So: **if the two derivations agree, that agreement is the evidence. If they
  disagree, the disagreement is the more interesting result.** Never reason
  from a single derivation, and never state a conclusion about a whole from a
  search whose completeness you have not tested.

  **And a set comparison answers whether a name is in both lists, never
  whether it means the same thing in both.** `/api/usage/allowance` is present
  in both nginx templates and a `comm` of the two shows it matched and fine.
  What that agreement does not show is that it sits eight lines above
  `location /api/usage { proxy_pass ai_service; }` and survives only because
  nginx picks the longest matching prefix. Delete the specific block and the
  path still resolves — to a service that does not serve it.

  That is a third failure mode, past the 404 and past the SPA-fallback 200: a
  **200 from the wrong service**, which is the only one of the three that
  looks like success. So when the set is a set of routes, the second
  derivation has to resolve each one to its upstream rather than confirm the
  name is present. Two derivations protect you from missing a member. They do
  not protect you from agreeing about the wrong thing.

- **A scripted edit must assert its result, not only its match.** Asserting
  `count(old) == 1` before a replace catches the anchor that drifted; it says
  nothing about what you replaced it with. Both halves have now failed here —
  once when a Prettier-collapsed signature made the anchor stale, and once when
  the anchor matched perfectly and the replacement silently ate two lines of the
  comment it was meant to extend. Read the result back and assert something
  about it. The second failure was caught by a two-line `sed -n` afterwards,
  which costs nothing.

- **Establish reversibility before exercising any write, and if you are unsure,
  ask rather than probe.** That rule has paid for itself: web chat looked like
  the one safe thing to create on screen 13 — no third party, nothing to
  authorise — and `DELETE /api/channels/:id` turns out to 500 for every channel
  type. It would have left a widget nobody could remove.
- **A spec that writes is opt-in, runs in one project, and proves the tenant
  was left as found.** `settings-notifications-seeded.spec.ts` is the only one,
  because the rule list cannot be photographed on a tenant with no rules. It
  skips entirely without `E2E_SEED_RULES=1`; it runs in `ltr` only, since two
  projects writing to one tenant would each trip the other's "count must be 0"
  guard and report a second writer that was us; and it writes the before/after
  counts to `e2e/evidence/s15/seed-counts.txt` rather than a terminal, so the
  evidence carries its own proof. A teardown failure names what is still on
  the tenant and never retries down a second path — retrying is how D26's
  probe became a defect.

- **A test that mutates shared state must verify it did not.** Screen 11's
  stale-write shot corrupted the tenant's description twice: once by leaving
  debris, and once by a read-then-restore that raced itself six ways under
  `fullyParallel`. It now writes the value back over itself — `@updatedAt` moves
  the ETag whether or not a column changed — so there is nothing to restore and
  no `finally` to race.
