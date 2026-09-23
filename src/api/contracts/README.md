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
