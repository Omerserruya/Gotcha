# Switching billing enforcement on

`BILLING_ENFORCEMENT_MODE` is one environment variable that changes what happens
to live customer conversations. This is how to change it without finding out the
consequences from the organizations whose bots went quiet.

## The three modes

| Mode | What it does |
|---|---|
| `off` | Answers nothing, decides nothing. In production this means **nobody is required to pay**. |
| `audit` | Evaluates every check and reports it, then allows anyway. |
| `enforce` | Refuses. **This is the production setting.** |

`hard`, `soft` and `observe` are accepted as older spellings of `enforce`,
`audit` and `audit`. Both vocabularies work because a deployment set to the
other one used to fall through to `off` — which does not merely skip
enforcement, it skips **metering**, so usage stops being recorded and no number
anywhere looks wrong.

Services refuse to start on a missing or misspelt value in production. `off` in
production requires `BILLING_ALLOW_UNENFORCED=true` — deliberately hard to do by
accident, because running production unenforced should be a decision someone had
to write down.

## What is actually checked

Both halves of one question, which is the point:

1. **Is this organization commercially in good standing?** Tenant status,
   subscription status, trial and POC expiry, past-due grace.
2. **Does their plan include the capability being used?**

These used to be answered by two separate functions with nothing composing them,
so a paying customer could use a capability they had never bought, and a feature
check passed for an organization that stopped paying months ago.

## Before you switch it

Run the impact report **in the environment you are about to change**:

```bash
docker compose exec billing npx tsx src/scripts/enforcement-impact.ts
```

It calls the same gate the runtime calls, under an assumed `enforce`, so it
reports what would actually happen rather than a second opinion about it. It is
read-only.

The number that matters is **actively serving** — organizations with
conversations in the last 7 days. A tenant with none can be refused today and
nobody notices. A tenant with conversations goes quiet in front of their
customers.

If that number is above zero, each row is a decision, not a statistic. Resolve
or accept them individually first.

## The rule that changed

**An ACTIVE tenant with no subscription row is now refused** (`no_subscription`).

This reverses the previous behaviour, which allowed it on the reasoning that
free and pre-billing tenants legitimately have no subscription. The cost of that
reasoning was that "never paid" and "paid" were served identically.

The blast radius is real and is the main thing the impact report is for.

Two deliberate exemptions:

- **Onboarding.** A tenant mid-onboarding has no subscription by definition, and
  onboarding is the flow through which one gets bought. Refusing it would make
  the product impossible to start using. The paid product stays out of reach
  anyway — the tenant access matrix denies that scope for those statuses.
- **Grandfathered subscriptions**, which have `enforcementEnabled` false. That
  is a commercial decision recorded on the row, not an accident.

## What fails open, and why

Exactly one thing: a **database error** while reading tenant or subscription
state allows the request. A database blip must not lock every paying customer
out of the product they are paying for.

Nothing else does. In particular, "we could not determine whether they have a
subscription" is not treated as "they do".

## Related settings

| Variable | Default | Purpose |
|---|---|---|
| `BILLING_ENFORCEMENT_MODE` | `enforce` in compose | The mode. |
| `BILLING_PAST_DUE_GRACE_HOURS` | `72` | How long a failed renewal keeps working. An expired card should not be punished as harshly as never paying. |
| `BILLING_ALLOW_UNENFORCED` | unset | Required to run `off` in production. |

Every service that can produce billable work receives these: `ai`, `billing`,
`conversation`, `chatbot`, `voice-copilot`, `incoming-worker`,
`outgoing-worker`. Only `ai` and `billing` used to, and the other five defaulted
to `off` — five services producing billable work, each a way in.
