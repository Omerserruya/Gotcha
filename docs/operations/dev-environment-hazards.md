# Dev environment hazards

Things about this repository and this dev box that cost someone a day to find, written
down so the next person does not pay for them twice. Each entry is a fact that was
observed, not advice.

---

## The dev stack does not survive a reboot

**Signature.** Nineteen of twenty services show `Exited(255)` at one timestamp and
`swagger-ui` is up. `swagger-ui` is the only service with a restart policy, which is why
it alone survives.

It has happened at least twice. The failure presents to whoever works next as **broken
routes**, not as a dead stack — you will debug endpoints that are fine.

**Recovery.**

```bash
docker compose up -d      # no --build: reversible, no disk cost, no image churn
```

**Then verify it is *serving*, not merely running.** A container count is not proof.

```bash
for p in /api/ai-agents /api/knowledge /api/tool-permissions /api/chatbot-flows; do
  printf "%-24s " "$p"; curl -s -o /dev/null -w "%{http_code}\n" "http://localhost$p"
done
```

- **401 is the pass.** nginx resolved the upstream and the service answered.
- **502 means drift.** After a full stop every container takes a new IP; the gateway can
  hold a stale one. Recreate the gateway.

Sweep **several paths across different services** — one path proves one upstream.

---

## Restarting Authentik breaks the Next app until it is also restarted

The app discovers Authentik's OIDC configuration at startup. If Authentik restarts
afterwards — including because a compose change recreated it — the app holds a stale
reference and **`GET /api/auth/login` returns 500 with an empty body**.

It presents as a broken app. It is not. Restart `next start`:

```bash
pid=$(ss -ltnp | grep ':3000' | grep -oP 'pid=\K[0-9]+' | head -1)
tr '\0' '\n' < /proc/$pid/environ | grep -E '^(E2E_|PORT|APP_ORIGIN)='   # preserve these
kill $pid && sleep 3 && npx next start
```

**Read the environment off `/proc/<pid>/environ` before killing it.** The e2e captures
need `E2E_SECURITY_FIXTURES=1`; without it the security and customer screens refuse to
photograph rather than capturing real personal data, which is correct and looks like a
broken capture.

**The pass is `307` to `auth-dev.gotcha.co.il/application/o/authorize/`**, not `200`.

---

## Dev sends REAL email, from the production sender domain

```
auth container:  SMTP_HOST=smtp.resend.com
                 SMTP_FROM=GOTCHA <no-reply@gotcha.co.il>
```

**There is no mail sink and no catcher on this box.** Anything that triggers an email — an
invite, a notification, a password setup link — **leaves the building, from the real domain,
against the real sending reputation.**

So a probe that exercises an invite path is not a local operation: it provisions an Authentik
identity **and mails a stranger**. `POST /api/onboarding/invite-team` is the one to watch.

**Before driving any flow that might send: check whether it sends, and ask.**

---

## The box is shared with another team

```
docker compose ps   →  20   our services
docker ps           →  22   plus two buildkit builders, one of which is not ours
```

- **Use `docker compose ps`**, not `docker ps`, when the question is "is our stack
  healthy".
- **`docker image prune -a` is forbidden.** It removes images no *running* container
  references, which includes other people's tagged releases. Dangling-only is the
  ceiling: `docker image prune -f`.
- On `ENOSPC`, **stop and ask**. Losing an hour beats deleting somebody else's release.

---

## Build cost

**Measured, and it is a ladder rather than one number — per single service:**
```
~0.1 GB   a code edit, mostly cached layers
~1.04 GB  a change inside packages/shared TypeScript
~1.36 GB  a Prisma schema change (the regenerated client invalidates deeper layers)
```
**Check the SCOPE before the size.** A `CalendarAccount` schema change looked like it would cost
~10GB and cost 1.36GB, because only one service references that model. The question *"which
services import this?"* is worth more than the measurement.

A change inside `packages/shared` rebuilds every service that imports it — most of them —
which is roughly **10GB**. Check free space before starting one; hitting `ENOSPC` partway
through is the outcome to avoid on a shared box.

`services/ai` bind-mounts its source and the frontend hot-reloads, so neither needs a
rebuild for a source change.

**A curl cookie jar rides the session rotation.** `gotcha_session` rotates on every BFF
request, so a saved cookie is single-use and a sweep costs one minted session per path.
`curl -b jar -c jar` carries each rotation forward and covers a whole sweep from one mint.

**Reclaimable without touching anyone else's work:** `npm cache clean --force`, stale
`.next/cache` directories. **Do not** delete `~/.cache/ms-playwright` — the e2e captures
need those browsers.

---

## `applyLiveByDefault` suppresses itself if you mention `origin`

`packages/shared/src/lib/prisma.ts` injects `origin: "LIVE"` into bulk where-clauses on
`Conversation` and `Message`, so imported history stays out of live figures by default.

**`mentionsOrigin()` treats any mention of `origin` as explicit caller intent and skips
the injection.** So writing `origin: "LIVE"` yourself *replaces* the platform guarantee
with a hand-written copy that the next edit can silently break. Do not restate it.

**It keys on the top-level model.** A `user.findMany` with a nested `_count` on
conversations has `model = "User"`, so the guard never reaches the nested aggregate. **It
protects top-level queries on `Conversation` and `Message`, and not relation counts
reached through another model.**

---

## `isTest` does not mean sandbox

A sandbox conversation — the rehearsal someone runs while setting up an AI employee —
has **`isTest = false`**. It is identified by `customerExternalId` starting `sandbox:`,
which is what `sandbox-conversation.service.ts` treats as definitive, and it carries
`handledBy = "sandbox"`.

This has been the root cause of two shipped miscounts: billable conversation volume, and
the per-employee open-conversation figure. **Filtering on `isTest` alone excludes
nothing.**

---

## Route-level traps

- **The production gateway is an explicit per-path allowlist.** A path with no `location`
  block does not 404 — it falls through to the SPA and returns **200 with `index.html`**,
  so the client fails at `JSON.parse` or silently reads `undefined`. Add the block to
  **both** `nginx/nginx.conf.template` and `gateway/nginx.prod.conf.template`, and check
  the longest-prefix interaction with existing blocks: a path can match a *broader*
  sibling and be answered by the wrong service.
- **A 401 proves almost nothing. The services authenticate BEFORE they route.** Two
  routers can be mounted at the same prefix, and only an *authenticated* request tells
  them apart. Measured: `app.use("/api/knowledge-bases", knowledgeRoutes)` is the list
  route; `app.use("/api/knowledge", knowledgeOauthRoutes)` is Confluence/Drive OAuth and
  has no `GET "/"`. `/api/knowledge` **is** in the gateway allowlist, proxies cleanly and
  returns 401 unauthenticated — so the reboot sweep above passes on it. **Measured: all six
  Studio paths return 401 unauthenticated, including the dead one**, because the auth
  middleware answers before the router is consulted. Authenticated, `/api/knowledge` returns
  **404 with an HTML body**, `Cannot GET /api/knowledge`, from Express.
  **The static check that does work needs no session and no running stack:** resolve the
  longest matching `app.use` prefix, then verify that router declares the remaining path. A screen
  wired to it reads nothing and cannot say why. This is the allowlist trap's twin: the
  first is a *missing* `location` block answering 200 with `index.html`, this is a
  *present* one answering 404 from the wrong router.
- **`voiceCopilotGate` 404s the whole voice router** for a tenant without the feature. A
  404 from a gate and a 404 from a missing route are the same response. Read
  `voiceCopilotEnabled` from `GET /api/tenant-settings`, which is not behind the gate.

---

## The internal-service bearer does not reach every service

The smoke-test pattern — call a service with `INTERNAL_SERVICE_KEY` — works on `auth`, `billing`
and `ai` and **fails on two services for two different reasons**:

```
analytics   compose does not pass INTERNAL_SERVICE_KEY at all
            → "Invalid or expired token".  The endpoint is fine.
billing      has the key, but the internal principal does not hold
            settings:billing:manage → the route refuses it. The endpoint is fine.
```

**Neither is a defect and both look like one.** Verify those two by calling the function inside
the container, and say in the report which method was used.

**And the billing suite cannot pass on the host at all.** 286 failures, identical before and
after any change: `PrismaClientInitializationError` and Redis refused on `127.0.0.1:6379`,
because that suite wants a database and a Redis the host does not expose. **Do not read a billing
test run as a gate, and do not read 286 as a regression.**

---

## The frontend is a second repository, and nothing links them

```
/home/ocs/projects/ChatCenter   the platform
/home/ocs/projects/redesign     the rebrand frontend — its own repo, one directory up
```

**There is no import edge between them.** No shared build, no shared types, no test that spans
both. **The only thing connecting them is a runtime contract**, and a runtime contract is
invisible to every static tool either side runs.

So a response-shape change here is a breaking change **with no compiler, no linter and no test
anywhere that can see it.** Measured 2026-09-23: a field went from `0` to `null`, which is more
truthful and cannot be expressed by `z.number().default(0)`, and a screen two repositories away
started rendering *"could not be loaded"*. The commit message said **"no screen reads it yet"**,
written after grepping `ChatCenter/frontend/src` — **the wrong tree.**

> **"No consumer in this repo" is not "no consumer."**

**Before changing a served response shape:**
```bash
grep -rn "<the field>" ../redesign/src/api/contracts/
```

**And the frontend's diagnosis is the one to keep**, because it says why the guard was right to
trip on an improvement:
> **A contract that fails closed will sometimes fail on good news.**

---

## A green vitest run says nothing about types

`vitest` transforms with esbuild, which **strips types without checking them**. So a file with
four type errors runs green and stays green.

Measured 2026-09-23: four type errors sat in a committed test file that the suite had passed.

> **Running the suite is not running the typechecker.** `npm run verify` does both; `npm test`
> does one. A test file is code, and it is the code least likely to be compiled by anything else.

---

## A password-protected store answers 200 to every path

```
17 requested · 17 returned · 941ms · every one the SAME 188-character page
"This store is password protected."
scan still reports  businessType "ecommerce" · platform "shopify"
```

`fetchPageRaw` rejects a non-200 or a non-HTML body. **A Shopify login wall is neither**, so
every candidate path "succeeds" and the crawl reads one page seventeen times — and the platform
markers it keys on are **in the login page's own markup**, so it is most confident about the one
thing it could not see.

> **`pages.length` is the number of fetches that worked, not the number of pages anybody read.**
> Use `distinctTextPages` for anything a person will see.

The model itself reported the wall honestly — the prompt's *"NEVER STATE ABSENCE UNLESS YOU
LOOKED"* held. **It was the count around it that lied.**

---

## `.` is a wildcard, and four search methods gave four wrong answers

Counting how many notification event types are emitted by nothing, over one unchanged tree:

```
literal `type: "x"` grep            8 dead
templated-minus-emitted diff        5
emit-call proximity window         11
per-event hand verification         6     <- the truth
```

**Four automated methods, four different wrong answers.** The diff counted a union declaration
as an emit. The proximity window over-matched. And one run matched `subscription_canceled` while
searching for `subscription.canceled`, **because `.` in a grep pattern matches any character** —
escape it, or use `-F`.

The events that defeated the literal grep are emitted through a variable:
`classifyToolForNotification()` returns the type and the emit call passes it on. **No textual
search can see that.**

> **Whether a thing is reachable is not a property a search can establish.** If a list claims it,
> the list has to be maintained with its evidence, and a test has to fail when the evidence stops
> being true — otherwise it decays into a confident wrong answer, in whichever direction happens
> to be worse.

---

## Comments that describe intent rather than behaviour

Several comments in this repository state an invariant the code does not enforce, and in
each case the comment is why the defect survived review. When a comment asserts a
guarantee, check the code still provides it before relying on it.

The counter-example worth copying is in the retention config:

> *"Must match `DEFAULTABLE_CATEGORIES`… A category present in one and not the other is
> inert: either the API refuses to configure it, or the engine cannot purge it.
> `retention-categories.test.ts` asserts the two agree."*

**A claim worth writing down is worth a test that fails when it stops being true.**
