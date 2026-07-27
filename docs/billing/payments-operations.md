# Payments: how it works and how to run it

GOTCHA prices in **USD** and charges in **ILS**. Everything below follows from
that one fact, and from a second: iCount has no idempotency key, so a retry is a
second charge unless we prevent it ourselves.

---

## The rate

Plans are sold in dollars. iCount is always sent shekels with `currency_id: 1`.
Something has to decide the number in between, and that decision is commercial,
not technical — so a person makes it.

`BillingExchangeRate` holds it: versioned, windowed, proposed by one
administrator and approved by another. Nothing fetches it. There is deliberately
no "look up today's rate" button, because a rate arriving from the web during a
charge is a rate nobody approved.

**With no ACTIVE rate, charging is off.** Checkout refuses before sending anyone
to a card form, and renewals fail rather than charging 499 shekels for a $499
plan. This is the intended behaviour, not a gap: an unpriced charge is worse
than a blocked one.

> There is an older `FxRateSnapshot` used for *displaying* approximate prices. It
> refreshes itself from an external source and falls back to a hardcoded 3.7 when
> that fails. It must never be used to decide what to charge — a network blip
> would quietly change the amount taken from someone's card, and nobody could
> say afterwards which rate applied.

An **identity** quote (`fxRateSource = "IDENTITY"`) covers an ILS-priced plan,
where nothing is converted. A database CHECK stops that from becoming a way to
record a real conversion with no approved rate behind it.

### Turning charging on

1. Sign in as a platform administrator → **System → Exchange Rate**.
2. Enter shekels per dollar. The page shows what a $499 plan becomes; check that
   figure, not the multiplier.
3. **Propose.** Nothing is chargeable yet.
4. A **different** administrator approves it. The service refuses if the approver
   is the author.

To stop charging, retire the active rate without approving another. That is the
lever for "this number is wrong, stop taking money".

---

## Modes

| `ICOUNT_MODE` | Network | Can charge | Use |
|---|---|---|---|
| `mock` (default) | no | no | ordinary development |
| `simulator` | no | no | testing failure paths |
| `live` | yes | yes | production only |

`simulator` also needs `ICOUNT_ALLOW_SIMULATOR=true`; without it, it degrades to
mock rather than switching on a mode nobody asked for.

`mock` models a customer who pays immediately and successfully, so a full
checkout completes locally. Use `simulator` when you need the failure paths.

`live` additionally requires `NODE_ENV=production` **and**
`ICOUNT_ALLOW_LIVE=true`. Both, checked before any network call — so a developer
flipping `ICOUNT_MODE=live` in a local `.env` still cannot charge a real card.

The simulator models declines, timeouts, expired cards and successes that carry
no usable reference. It enforces the same currency rules as production: a
simulator more permissive than the real thing certifies code that would fail on
the real thing.

---

## Configuration

Billing service only. **Never** `NEXT_PUBLIC_*` — the API token is a credential
and the page id has no business in a browser.

| Variable | Notes |
|---|---|
| `ICOUNT_MODE` | `mock` \| `simulator` \| `live` |
| `ICOUNT_ALLOW_SIMULATOR` | required for `simulator` |
| `ICOUNT_ALLOW_LIVE` | required for `live`, with `NODE_ENV=production` |
| `ICOUNT_API_TOKEN` | Bearer token. Never logged; stripped from every error path |
| `ICOUNT_API_BASE_URL` | defaults to the v3 endpoint |
| `ICOUNT_PAYMENT_PAGE_ID` | the `cc_token` PayPage. Configuration, not a secret. **Validated before any customer is sent to it** — see below |
| `BILLING_PAYMENT_TOKEN_ENCRYPTION_KEY` | 32 bytes, base64. Dedicated — no fallback to any other key. **Required even in mock/simulator**: storing a card token encrypts it, so an unset key fails checkout at the moment the card is confirmed |
| `APP_PUBLIC_URL` | where customers return after the hosted page |
| `BILLING_SCHEDULER_ENABLED` | renewal, dunning, reconciliation sweep |

Startup fails closed: `ICOUNT_MODE=live` without a token refuses to boot rather
than running a billing service whose every charge will fail at the worst moment.

### The page must store cards, not sell them

Before sending anyone to the hosted page, the service reads its configuration
and refuses unless it is a `cc_token` page that is active and is not a standing
order. Two things this prevents, both of which charge a real person:

- an `invrec` page **charges immediately** instead of storing a card;
- an `hk_page` standing order makes iCount a **second renewal owner**, billing
  the same customer every month alongside us.

A page that checks out is trusted for ten minutes. A page that fails, or that
cannot be read at all, is **not** cached — so correcting it in iCount takes
effect on the next attempt, and a provider outage blocks checkout rather than
waving it through. A delayed checkout is recoverable; an unintended charge is
not.

---

## Taking a payment

```
customer                     GOTCHA                          iCount
   |                            |                               |
   |-- start payment ---------->|-- record which cards exist -->|
   |                            |-- paypage/generate_sale ----->|
   |<-- redirect to hosted page-|                               |
   |------------------ enters card details ------------------->|
   |<---------------- redirected back --------------------------|
   |-- "please check" --------->|-- client/get_cc_tokens ------>|
   |                            |   is there a NEW card?        |
   |                            |-- cc/bill (ILS, currency 1) ->|
   |<-- plan active ------------|                               |
```

Two things this diagram is built around.

**The customer's browser never reports an outcome.** Returning to the success
URL proves they came back. People close tabs, lose signal and bookmark redirect
URLs. The only accepted proof is iCount's own answer.

**Baseline fingerprints.** We record which card tokens exist *before* sending
anyone anywhere, then look for one that is new. Checking only that "a card
exists" would accept a card saved months ago, or a replayed session, as proof
that this payment happened.

---

## Not charging twice

iCount confirms no provider-side idempotency. Four mechanisms, each covering
what the previous one cannot:

1. **A deterministic attempt key** (`checkout:chk_...`), unique in Postgres. Two
   requests for the same logical charge collide, across every instance.
2. **An execution lease.** Uniqueness stops two *rows*; it does not stop two
   *workers* finding the same row and both charging it.
3. **A single-use payment quote,** bound atomically to one attempt.
4. **Reconciliation** for anything still unresolved.

### UNKNOWN is not FAILED

The most important distinction in the system.

- **FAILED** — iCount said no. No money moved. Retry freely.
- **UNKNOWN** — the request went out and no answer came back. Money may have
  moved. **Never retried automatically**, by anything.

A renewal with an unknown outcome does **not** become `PAST_DUE`, because
`PAST_DUE` opens a dunning record and dunning retries. If that charge landed,
the retry takes a second month from someone who already paid.

`RECONCILIATION_REQUIRED` covers a success that came back with no reference we
recognise: the money moved but nothing identifies it, so it can be neither
reconciled nor refunded until a human looks.

---

## Reconciliation

The scheduler sweeps unresolved attempts, waiting `RECONCILE_AFTER_MS` first —
asking too early gets a confident "no transaction" for one that is about to
appear, which would mark a paying customer unpaid.

It matches on the **submitted shekel amount**, not the dollar price. It only
asks; it never re-submits.

| Provider says | Result |
|---|---|
| exactly one matching transaction | `SUCCEEDED`, reference recorded |
| none | `FAILED` — safe to charge again |
| two or more identical | `MANUAL_REVIEW` |

The last case is unavoidable: without a merchant reference, two identical
legitimate charges are genuinely indistinguishable. It escalates rather than
picking one.

**System → Exchange Rate** lists everything awaiting a human, and can trigger a
sweep by hand — useful when a provider outage has just ended.

Resolving one means looking at iCount's own records and then either refunding or
activating manually, both of which have their own audited paths. There is
deliberately no "mark as paid" button: that would be a way to grant a plan with
no evidence at all.

---

## What a customer sees

- The dollar price **and** the shekel figure, with the rate between them. Showing
  only dollars would leave someone unable to recognise the line on their own
  statement, and that surprise is what becomes a chargeback.
- Before payment the conversion is marked indicative; afterwards it is the
  frozen figure actually charged.
- Declines are a category ("that card has expired"), never iCount's raw string.
- An unknown outcome shows as *processing*, never as a retryable failure —
  offering a retry there could charge them twice.

---

## Refunds

`doc/cancel` with `refund_cc: true`. Two consequences of it being **document**-
linked rather than charge-linked:

- It needs the document reference. A charge recorded without one cannot be
  refunded this way.
- It cancels the **whole** document. A partial refund request is refused rather
  than approximated, because approximating would return more than was asked.

A refund returns the **shekel** amount that was actually taken, not the dollar
figure on the invoice. Both are written to the audit entry, along with who asked.

`POST /internal/billing/refund` (internal key required) takes `chargeId`,
optional `amount` and `reason`, and an `actor` — pass a real person, otherwise
the audit entry records the refund as "system".

A charge in `UNKNOWN` **cannot** be refunded. Returning money for a charge we
cannot confirm happened could refund something that was never taken; reconcile
it first. That refusal is audited too — it is what someone reconstructs when a
customer says they were promised their money back.

---

## Manual contracts

For an organization paying by bank transfer or a signed agreement. A Sysadmin
activates the plan with an external reference and a reason.

It reuses the same activation boundary as a paid checkout, so the amount still
has to match the snapshot and credits are still granted exactly once. What
differs is provenance: the attempt records `MANUAL_EXTERNAL_CONTRACT` and no
provider charge, so nothing downstream can present it as a card payment that
cleared. It carries no payment quote, and activation refuses if one is attached
— no money moved through a provider, so there is nothing to convert.

---

## Deploying

1. `npx prisma migrate deploy` in `packages/shared`.
2. Set the environment above. Leave `ICOUNT_MODE=mock` until the rest is ready.
3. Confirm nginx routes `/api/checkout` and `/api/admin/billing` to the billing
   service.
4. Set `ICOUNT_MODE=live`, `ICOUNT_ALLOW_LIVE=true`, `NODE_ENV=production`.
5. Propose and approve a rate. **Charging stays off until this is done.**
6. Verify with one real payment on a card you control, then refund it.

### If something looks wrong

Retire the active rate. Charging stops immediately; nothing falls back to an
estimate. Existing quotes keep the rate they froze, so anything mid-flight stays
consistent and explainable.
