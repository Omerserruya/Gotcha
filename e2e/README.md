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

`e2e/evidence/` is committed. Screen 16 renders a real IP address and the city
someone signs in from, so photographing the live list would put personal data in
the repository permanently.

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
sign-in locations being committed.

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
- **Establish reversibility before exercising any write, and if you are unsure,
  ask rather than probe.** That rule has paid for itself: web chat looked like
  the one safe thing to create on screen 13 — no third party, nothing to
  authorise — and `DELETE /api/channels/:id` turns out to 500 for every channel
  type. It would have left a widget nobody could remove.
- **A test that mutates shared state must verify it did not.** Screen 11's
  stale-write shot corrupted the tenant's description twice: once by leaving
  debris, and once by a read-then-restore that raced itself six ways under
  `fullyParallel`. It now writes the value back over itself — `@updatedAt` moves
  the ETag whether or not a column changed — so there is nothing to restore and
  no `finally` to race.
