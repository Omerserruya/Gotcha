# Reviewer test account — verify immediately before resubmitting

> **Verification status, 2026-09-29.** Six of the ten checks below can only be
> confirmed by signing in or by opening the Partner Dashboard, and neither is
> possible from a shell. They are marked UNVERIFIED rather than assumed, because
> a Test-Instructions statement that turns out to be false is the kind of thing
> that fails a review on its own.
>
> | Check | Status |
> |---|---|
> | Credentials work | **UNVERIFIED** — needs a sign-in attempt |
> | MFA disabled | **UNVERIFIED** — Authentik holds this, not the app DB |
> | No social sign-in required | **UNVERIFIED** |
> | No password reset pending | **UNVERIFIED** |
> | Full testable feature set | **VERIFIED** — 47 provider-neutral entitlements (1 OVERRIDE + 46 TRIAL) |
> | Opens the intended workspace | **VERIFIED** — the account resolves to the review tenant |
> | Workspace has no Shopify connection | **NOT YET TRUE** — see below |
> | GOTCHA Core active | **VERIFIED** — `poc`, ACTIVE, period end 2028-12-31 |
> | Reviewer can attach their own store | **VERIFIED by design** — no allowlist gates installation, and the claim path is tested |
> | Partner Dashboard declares non-embedded | **UNVERIFIED** — the repo declares `embedded = false` in `shopify.app.production.toml`, but the Dashboard is authoritative and only a browser can read it |
>
> **The workspace is not yet clean.** `new-for-test-of1cm1on.myshopify.com` is
> still installed and CONNECTED. It holds no paid access - `grantsAccess` is
> false and all four Shopify-funded entitlements are absent - so it is not a
> billing problem. It is a *staging* problem: a reviewer attaching their own
> store should not find somebody else's already attached. **Uninstall GOTCHA
> from that store in Shopify Admin before submitting**, then re-run the
> clean-state verification.


Run this within a few hours of submitting. Several items decay: a session
expires, a pending installation ages out, a previous review attempt leaves a
store claimed.

**No password appears in this repository.** The password lives only in the
Partner Dashboard test-credentials field and in the team password manager. If a
check below needs it, read it from there.

## Credentials

- [ ] Sign in end to end **in a fresh Incognito window**, using only what the
      reviewer is given. Not your own browser, not a saved session.
- [ ] **No MFA** challenge on this account.
- [ ] **No forced password reset** or "change your password" interstitial.
- [ ] **No social-login requirement** — email and password alone work.
- [ ] Account is not locked, expired or pending email verification.

## Workspace

- [ ] Workspace is **clean**: no Shopify store connected, and no leftover data
      from a previous review attempt.
- [ ] **No existing Shopify connection** on this tenant.
- [ ] **No stale pending installation** parked against this account.
- [ ] **The reviewer's store is not already claimed** by this or any other
      workspace. A store claimed elsewhere is refused by design and would look
      like a broken install.

## Entitlements

- [ ] **GOTCHA Core subscription is active** on the review workspace, so the
      reviewer never meets a GOTCHA paywall or is asked for a payment method.
- [ ] The account has **permission to reach every screen in the script**:
      Billing, the Shopify integration page, the Inbox, and the approvals view.
- [ ] The workspace has **no Shopify-funded entitlement** and **no grandfather
      grant** before the review begins. The reviewer must start from unpaid, or
      shot 9 cannot be filmed honestly.

## Support

- [ ] Support email in the listing is **monitored for the whole review window**,
      with someone who can answer within a working day.
- [ ] Whoever is monitoring knows this submission is about billing separation,
      so a reviewer question is not routed to general support triage.

## Record before submitting

| Item | Value |
|------|-------|
| Review email | `<REVIEW_EMAIL>` |
| Password location | Partner Dashboard test-credentials field + password manager |
| Workspace / tenant id | `<TENANT_ID>` |
| Reviewer store domain | `<REVIEW_SHOP>.myshopify.com` |
| Checked by | `<NAME>` |
| Checked at | `<UTC TIMESTAMP>` |
