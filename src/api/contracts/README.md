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

