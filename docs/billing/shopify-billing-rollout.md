# Shopify billing — rollout and rollback

Companion to the [architecture assessment](./shopify-billing-architecture-assessment.md),
the [implementation plan](./shopify-billing-implementation-plan.md) and the
[Partner Dashboard steps](./shopify-partner-dashboard-setup.md).

## The default state, and why it is safe

**Everything ships off.** With `SHOPIFY_BILLING_ENABLED` unset or false:

- `getBillingSource("SHOPIFY")` returns a source that refuses every operation.
- The policy resolver answers `UNRESOLVED / shopify_billing_disabled`, which
  sends nobody to a payment page.
- Usage rows attributed to Shopify are recorded and marked `SKIPPED`; the usage
  is on the books, it just never reaches a provider.
- The reconciliation stage finds no `ProviderSubscription` rows and does
  nothing.
- Nothing about `GOTCHA_EXTERNAL` billing changes. Its adapter reads existing
  state and adds no behaviour.

A disabled or missing flag therefore lands in a non-charging state — never in
accidental paid access, and never in a real charge. That is asserted by tests
rather than asserted here.

## Migration and backwards compatibility

The migration is **additive only**: four new tables, three new columns, seven
new enums, one new enum value. No column is dropped, no constraint is altered,
no existing row is rewritten.

- `subscriptions.billing_source` defaults to `GOTCHA_EXTERNAL`, so every
  existing subscription is correctly described the moment the column exists.
  **There is no data backfill step.**
- `tenant_entitlements.funded_by_*` is nullable, and NULL means "the
  pre-existing answer" — funded by GOTCHA's own billing.
- **Nothing is inferred as grandfathered.** The resolver requires an explicit
  switch *and* an active external subscription; absent evidence yields
  `REVIEW_REQUIRED`, which is a state a human looks at, not a decision.

Existing customers cannot lose access or be charged by this change, because no
code path is reachable while the flags are off.

## Rollout

Each stage is independently reversible, and none of them should be combined.

**Stage 0 — deploy with everything off.** Run the migration. Confirm both
suites stay green and `[shopify-billing] disabled` appears at boot. Nothing
about the product changes. Sit here as long as you like.

**Stage 1 — complete the Partner Dashboard work.** See the setup doc. Nothing
is deployed in this stage.

**Stage 2 — mock, then test.** Set `SHOPIFY_BILLING_ENABLED=true`,
`SHOPIFY_BILLING_MODE`, and leave `SHOPIFY_BILLING_ENV=mock`. The service now
boots through `assertShopifyBillingConfig()`, which refuses to start on a
half-configured setup. Then move to `SHOPIFY_BILLING_ENV=test` against a
development store, where Shopify prices contracts at $0.

**Stage 3 — one policy, one merchant.** Set `SHOPIFY_BILLING_POLICY_MODE`.
Verify a `BillingPolicyDecision` row appears with the expected `policy`,
`reason`, `evidenceQuality`, `codeVersion` and `configVersion`. Only set
`SHOPIFY_ALLOW_SPLIT_BILLING=true` **after Shopify has confirmed split billing
is permitted** — `connector_addon` refuses without it, deliberately.

**Stage 4 — live.** `SHOPIFY_BILLING_ENV=live` **and**
`SHOPIFY_ALLOW_LIVE_BILLING=true`. Two variables, because one set by accident
should not be enough to move real money.

**Stage 5 — metered usage, last.** `SHOPIFY_USAGE_BILLING_ENABLED=true` only
once subscriptions are proven. Watch for `no_meter_handle_configured` in the
ledger — that is a case-sensitivity mismatch against the Partner Dashboard, not
a code fault.

## Rollback

**Turning it off is the rollback.** Set `SHOPIFY_BILLING_ENABLED=false` and
restart. Effective immediately, because the registry resolves the source on
every call rather than caching it at import.

What that does and does not do:

- New subscriptions cannot be started. Verification stops. Usage stops being
  dispatched and is marked `SKIPPED` — **recorded, not lost**, and dispatchable
  later if the feature is re-enabled.
- **It does not revoke entitlements already granted.** Rows created by a
  verified subscription stay until something authoritative says otherwise. That
  is intentional: switching off a feature flag is not evidence that a merchant
  stopped paying, and cutting off paying merchants during a rollback would turn
  a config change into an incident.
- To *also* withdraw Shopify-funded access, call `revokeShopifyEntitlements()`
  per tenant. It is scoped by `source`, so externally funded entitlements are
  untouched.
- **It does not cancel anything at Shopify.** Merchants' Shopify subscriptions
  continue to exist and to bill. Cancelling them is a deliberate, separate act.

### Rolling back the migration

Prisma has no down migrations. The reversal script is in the migration file
itself (`20260831120000_shopify_billing_foundation/migration.sql`), and it is
complete — nothing in the migration modifies existing data.

The single exception, stated plainly: **`ALTER TYPE "EntitlementSource" ADD
VALUE 'SHOPIFY_SUBSCRIPTION'` cannot be reversed.** Postgres cannot drop an
enum value. It is inert when unused, so it is left in place rather than
rebuilding the type.

Rolling the code back **without** the migration is safe: the new tables simply
go unread.

## What to watch

Structured, greppable, and carrying correlation ids without secrets or PII:

| Prefix | Says |
|---|---|
| `[shopify-billing] mode=… env=… policy=…` | boot configuration |
| `[billing][policy]` | a policy decision, its reason and evidence quality |
| `[billing][provider-sub]` | a subscription status transition |
| `[billing][reconcile]` | a mismatch repaired, or a failure |
| `[billing][uninstall]` | a disconnect and how much was revoked |
| `[commerce][cross-tenant]` | **a shop claimed by a second workspace — investigate** |
| `[usage][conflict]` | **one unit claimed by two providers — investigate** |
| `[shopify-version] VERSION DRIFT` | our pinned API version is no longer accessible |

The two in bold should never appear in normal operation.

Worth alerting on: `usage_ledger_entries` rows in `FAILED` (retries exhausted);
`BillingPolicyDecision` rows with `evidenceQuality = REVIEW_REQUIRED`; a rising
count of `CommerceConnection` rows stuck in `BILLING_PENDING`; and
`reconcile.failed` staying non-zero across ticks.

## Known limitations

1. **App Pricing has no webhooks.** Reconciliation cadence — currently the
   billing scheduler's `BILLING_CYCLE_INTERVAL_MS`, one hour by default — is the
   real bound on how quickly a cancellation or freeze is noticed. If that is too
   slow commercially, shorten the interval; there is no event to subscribe to.
2. **Capabilities are declared `unverified`** for both Shopify adapters, so
   `assertBillingCapability` refuses them. They are promoted to `verified` only
   after being exercised against a real development store. This is deliberate:
   shipping `verified` on the strength of documentation is the mistake the
   capability table exists to prevent.
3. **`Subscription.billableEntityId` is still `@unique`.** Split billing is
   expressed through `ProviderSubscription`; folding the two together is a later
   migration, deferred rather than designed out.
4. **The manual adapter's three `services/ai` endpoints do not exist yet.** The
   contract is defined in `manual-billing.source.ts`; the endpoints are listed
   in the Partner Dashboard doc as work required before `mode=manual` is usable.
5. **`schema.prisma` on `main` is ~214 lines out of sync with its own migration
   history**, including `DROP TABLE` for three tables. Unrelated to this work,
   but it means `prisma migrate diff --from-migrations` cannot be used to
   generate migrations in this repo until it is reconciled.
