# Contracts

One file per platform surface. Zod schemas, plus the small functions that turn
a payload into the distinctions a screen is allowed to draw.

`object`, not `looseObject`, unless there is a reason: these routes return
whole rows, and a billing screen needs four fields of forty.

---

## Before a claim about the platform leaves this session, grep here

```bash
grep -rn "<the concept>" src/api/contracts/
```

One command, and it runs in **both directions**:

**Before declaring the platform LACKS something.** `pendingChange` was reported
as write-only after a whole-repo search for `pendingSubscriptionChange` found
only the writer and the scheduler. The relation is loaded one file over as
`include: { pendingChange: true }`, and it was *already in `billing.ts`*, added
for an earlier screen, described in a comment as "so the screen can say so".
A search that goes outward never passes what you wrote going inward.

**Before declaring you have FOUND something.** The same day, `languages[0]`
silently dropping the rest of a six-element list was reported as a discovery.
It had been in `workspace.ts` for weeks, with the same reasoning and the
conclusion already drawn: *"The UI is single-select until the column catches
up — deliberately, so no control accepts two languages and forgets one."*

The second direction is the one that gets skipped, and it is the more
dangerous of the two:

> **A false discovery arrives with excitement attached, and you are inclined to
> believe it. The excitement is not private — it transmits, and the person
> reading your report starts composing a response before they check.**

---

## What a contract is for

Not validation. **Keeping distinctions the platform makes and a screen would
otherwise flatten.** Most of the functions here exist because two things that
look alike are not alike:

| file | the distinction |
|---|---|
| `billing-profile.ts` | no account · never entered · **emptied** · filled — four facts behind one blank form |
| `credits.ts` | credits that expire at renewal · credits that do not · a consumption figure that counts expiry as spend |
| `pricing.ts` | a scheduled change that has **already been applied** · one that has not |
| `whatsapp-numbers.ts` | receiving · sending — two booleans, because a number can do one and not the other |
| `workspace.ts` | scan · human · **unknown**, where unknown is not a missing second state |

If a helper here only restates a field, it is probably not needed. If it
separates two states the payload lets you confuse, it is the point.

---

## `null` is a third thing

A failed read is not an empty list, and an empty list is not a missing one.
Loaders return `null` for "we could not find out" and `[]` for "there are
none", and every screen that renders one must render the other differently.

The cost of getting this wrong is not theoretical: a payment-methods read that
lost removed the only actionable sentence from the billing screen for about one
page load in six, and it looked like a flaky test.

## A fixture is a claim that the system can produce these values

A test fixture is not neutral data. Every field it sets asserts that some code
path in the platform could write that value — and nothing checks that
assertion, so it passes forever whether or not it is true.

**If you cannot name the code path that would produce a value, it does not go
in a fixture.**

This rule already existed, in `features/customers/capture-fixtures.ts`, scoped
to *capture* fixtures because that is where it was first found:

> EVERY ROW MUST BE A ROW THE PRODUCT COULD HAVE CREATED. If you cannot name
> the code path that would produce it, it does not go in the evidence.

It was written after a capture fixture hand-assigned a `personId` the unifier
cannot produce — an Instagram contact has `phone: null`, and the unifier
matches on phone — and photographed it beneath the screen's own sentence
saying that join is impossible. Green, and demonstrating something the product
cannot do.

**The scoping to captures was the mistake.** One directory over,
`outreach.test.ts` carried `readCount: 904, repliedCount: 188` on counters
that are initialised to zero and never incremented by anything in the
monorepo. The tests asserted arithmetic correctly and said nothing about the
product, and they would have gone on passing for as long as anybody kept them.

Two ways to get this wrong, and the second is the common one:

- **an impossible combination** — each field plausible, the row unreachable
  (the `personId` case)
- **a value on a field nothing writes** — the field exists, so the fixture
  type-checks, and the number is fiction (the `readCount` case)

The second is invisible to every tool we have. A schema will accept it, a type
will accept it, and the test will pass. The only check is naming the writer.

When a field turns out to be never-written, **set the fixture to what the
platform actually emits** — usually the default — rather than deleting the
test. A fixture carrying the real zero makes the next person's assertion fail
honestly instead of passing on fiction.

## A flag without its payload is a feature that does not exist

`knowledge-candidates.ts` named `conflict` and omitted `variants`. `z.object`
strips what it does not name, so every conflicted candidate arrived carrying
both of its competing answers and the UI received a boolean saying a conflict
existed and nothing to show for it. Screen 08's hero panel looked unbuildable
for as long as that was true.

**A contract that names a flag and omits the payload the flag guards turns "we
have this" into "this does not exist."** It is worse than dropping both: the
flag is enough to make the gap look like a backend gap rather than ours.

This was the fourth field in one day that we needed and were already being
sent — after `data.customer.customerId`, `hasActiveVoiceChannel` and the
`{ notes, contactId }` envelope. When a screen seems to need something the
platform has no room for, check what the response actually carries before
writing that down.

**And read the payload's shape from its writers, not from the column comment.**
`variants` has two writers that disagree — the extraction stage writes four
fields, the dedupe stage merges and writes back three, dropping
`customerCount`. The column's comment promises a fifth, `exampleEvidenceIds`,
which **no code writes at all**.

## A component test tells you only what you handed it

A distinction between *none* and *nobody could tell us* lives in a **schema**.
If every test of it builds the object and hands it to a component, the schema
is never exercised — and the mutation that collapses the distinction passes.

That is not a gap in coverage. It is **coverage pointed at one layer and read
as coverage of another**, and a green suite then asserts your beliefs about
the contract back to you.

Found by running a mutation expected to fail: swapping `undatedCount`'s
`.optional()` for `.default(0)` broke nothing, because every test passed the
value straight into the component. There was no test double at all — **props
are a stand-in for a parse**, supplied from the author's understanding of the
schema rather than from the schema.

**The rule: for every field where a default would be a lie, one test must
drive it through `schema.parse` and assert the absent case.** One per field,
not one per component.

A sweep on 2026-09-25 found 17 of 19 already covered and 2 not — and one of
the 2 was live: `toolUsageSchema` defaulted both failure counters to `0`, so
`neverFailed()` returned **true** for any service that did not report them,
printing the exact caption that function exists to prevent.

### This completes a family

Three ways to believe something about data without checking it, all of which
read as rigour:

| | what it tells you |
|---|---|
| a **comment** describing a payload | what somebody intended once |
| a **cast** asserting a type | nothing — it is an assertion with no verifier |
| a **component test** | only what you handed it |

Against all three, the same answer: **read the shape from its writers, and
assert it where it is parsed.**

### And one no process catches

A **true general statement sitting immediately above the thing it describes.**
`ConversationList` carried a comment saying *"a partial fix that looks
complete is how a known problem stops being tracked"* two lines above a group
that was empty on every page but the last, for exactly the tenants with the
problem.

It is written by the person best placed to see it, which is presumably why
they do not: having just articulated the rule feels like having applied it.


## An error code is only where the route puts it

`cause.code` is the idiom everywhere in this codebase, and for the routes it
was written against it is right. Those codes come from the **entitlement
envelope in `packages/shared`**, which really does send a `code` field.

A service's own route-level refusals mostly do not. `historical-import.ts`
answers `{ error: "no_knowledge_base", message }`, and `readErrorBody` maps
`error` → `developerMessage` while `code` stays `undefined`. So the idiom,
copied, **compiles and never fires** — the tenant is told "something went
wrong" forever and the one action that would fix it is never named.

Read the `res.status(...).json(...)` before choosing the field to match on.
A branch that cannot fire is worse than a missing branch, because it looks
handled.

## `ok: true` is a claim about the request, not about the outcome

`POST /candidates/:id/approve` awaits `processDocument` inside a `try/catch`
that logs and swallows, then answers `{ ok: true }`. The comment above that
await says *"Awaited rather than fired and forgotten, so an approval that
reports success is an approval the AI can actually use."* The catch removes
exactly that guarantee.

**A comment that names the property the code does not have is the most
expensive kind of wrong comment**, because it answers the question a reader
came to ask. Where a write's usefulness depends on work done after the write,
the response is not evidence — read the thing back.

## A token that does not exist renders as nothing

`var(--surface-edge)` with no definition and no fallback makes the whole
declaration invalid at computed-value time: `border: 1px solid
var(--surface-edge)` is **no border at all**. No build error, no lint error,
no test failure — the same shape as a wrong i18n key, one layer down.

The vocabulary in `design-system/tokens/tokens.css` is semantic
(`--radius-card`, `--panel-base`, `--intent-urgent-text`). Inventing a
primitive-sounding name next to it (`--radius-8`, `--surface-base`) produces a
plausible declaration that does nothing. `scripts/css-token-sweep.sh` lists
every use with no definition.

## A required field in an error envelope is a bet on every handler

`errorEnvelopeSchema.error` was `z.string()`. `readErrorBody` answers `{}` when
the parse fails, so a refusal that did not happen to carry an `error` key lost
**every** field, not just that one — the code, the detail, the invoice id.

`POST /billing/credits/buy` refuses with `{ success: false, failureCode,
detail }`. So on the screen that charges a card, the reason for every refusal
was discarded inside the client, and the screen said the same generic sentence
to everybody.

An error envelope's fields are all optional, because a handler that forgot one
is exactly the case the envelope exists to survive.

## Where the discriminator lives, by service

Three places, and copying the wrong one compiles:

  `code`              the entitlement envelope in `packages/shared`, and
                      `auth`'s workspace routes. `PLAN_LIMIT_REACHED`,
                      `STALE_WRITE`, `NO_BUSINESS_PROFILE`.
  `error`             most route-level refusals, e.g. `historical-import`'s
                      `no_knowledge_base`. Arrives as `developerMessage`.
  `failureCode`       the billing services, with a per-code `detail`.

Six `cause.code` matches were checked against the routes that answer them.
Five were right. The sixth was on the buy action and could never fire.

## An outcome that cannot be produced still has copy

`BuyOutcome` declared `declined`, `no_billable_entity` and `too_many`, all
decided from the body of a 200 — and the route sends every refusal as a 402,
which throws. Three declared outcomes, three written sentences, none reachable,
and the tests passed because they handed the component an outcome directly.

When an outcome is decided in a `catch`, the test that proves it exists has to
throw. A test that constructs the outcome proves only that the renderer has a
branch for it.
