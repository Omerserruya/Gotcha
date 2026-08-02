# Domain rollout checklist

Ordered. Each step is verifiable before the next begins, because the expensive
failures here are silent — a dropped webhook and a login loop both look like
"quiet" for a while.

**Nothing below has been executed.**

## Before starting

- [ ] Answer the cookie-domain question in §0 of the dashboard checklist. Cookie
      scope cannot be changed later without invalidating every live session.
- [ ] Record the **current** WebAuthn RP ID. If it changes, every enrolled
      passkey dies and users must re-enrol.
- [ ] Confirm `npm run check:domains` is green.
- [ ] Confirm who can roll back Cloudflare, and that they are available.

## 1. Serve the new host — no cutover

- [ ] Cloudflare DNS: `app.gotcha.co.il` → tunnel/origin, proxied
- [ ] Tunnel ingress: `app.gotcha.co.il` → gateway
- [ ] SSL: Full (strict); certificate covers the host
- [ ] Cache: bypass `/api/*`, `/auth/*`, `/cb`, all webhook paths
- [ ] WAF: exempt every webhook path from bot protection
- [ ] **Old host keeps serving everything.** No redirects yet.

Verify: `https://app.gotcha.co.il` loads; `/api/health` responds; no certificate
warning.

## 2. Application environment

- [ ] Set the `PUBLIC_*` variables (dashboard checklist §9)
- [ ] Set `APP_ORIGIN`, `AUTH_ALLOWED_ORIGINS`, `APP_PUBLIC_URL`,
      `APP_PUBLIC_URL_ALLOWED_HOSTS`
- [ ] **Rebuild and push the gateway image** — `NEXT_PUBLIC_*` are frozen at
      build time and setting them at runtime changes nothing
- [ ] Confirm the startup diagnostics print all five origins with no error

Verify: sign in on the new host; the app loads; no CORS or CSP errors in the
console.

## 3. Authentik

- [ ] **Add** the new redirect URIs; do not remove the old ones yet
- [ ] Update the launch URL
- [ ] Set the post-logout redirect
- [ ] Apply the cookie-domain decision
- [ ] Verify the WebAuthn RP ID is unchanged

Verify each, on the new host: login, logout, MFA, password reset, email
verification, invitation, passkey, expired session, cross-tab session, and
return to the originally requested path after login.

**Stop if any fail.** Everything after this depends on authentication.

## 4. OAuth allow-lists — add only

- [ ] Add the new redirect URI at every provider in the OAuth matrix
- [ ] Leave old URIs in place
- [ ] Allow propagation time (Google in particular)

Verify per provider: connect a test integration and complete one read.

## 5. Webhooks

Order matters: endpoints must answer before anything is pointed at them.

- [ ] Confirm each new endpoint responds on the new host
- [ ] Shopify Chat: `shopify app deploy` with **both** redirect URLs present
- [ ] Shopify Core: update webhook URLs in the Partner Dashboard
- [ ] Stripe: **create a new endpoint**, store its secret, accept both
- [ ] Meta: switch the callback URL — atomic, one per product, watch delivery
- [ ] Voice/iCount/other: per the webhook matrix

Verify per provider: signature validation passes on a real delivery; tenant
resolution succeeds; a replayed event is deduplicated and does not mutate twice.

## 6. Transactional links

- [ ] Confirm invitation, password-created, approval, billing and notification
      emails render `app.gotcha.co.il`
- [ ] Check **both** Hebrew and English templates
- [ ] Confirm no authenticated link points at the marketing host
- [ ] Confirm no link contains `localhost`

## 7. Compatibility redirects

- [ ] `gotcha.co.il/app/*` → `app.gotcha.co.il/*` — **302**
- [ ] Old login paths → `app.gotcha.co.il/login` — 302
- [ ] Preserve path and safe query parameters
- [ ] **Do not redirect webhook POST paths** — a redirect loses body and signature
- [ ] Do not reflect arbitrary `returnTo` values

302 until the observation period ends. A 301 is cached by browsers and
intermediaries and is effectively irreversible.

## 8. Storefront widget

- [ ] Deploy the extension version with `app.gotcha.co.il` defaults
- [ ] **Keep `gotcha.co.il/widget/*` and the storefront API paths serving** —
      merchant themes hold the old value until each picks up the new version
- [ ] Monitor old-host widget traffic until it reaches zero

This one is not under our control: a merchant's theme decides when it updates.
Plan for a long tail.

## 9. Help Center

- [ ] Publish the article updates (see the Help Center audit)
- [ ] Re-shoot the screenshots listed there
- [ ] Verify no article links to `dev.gotcha.co.il`

## 10. Observation — minimum 14 days

Do not remove anything during this period.

Monitor:

- old-host traffic to `/api/*`, by path
- OAuth callback failures, by provider
- webhook delivery failures and signature failures, by provider
- duplicate webhook deliveries
- CORS and CSP violation reports
- login loops (repeated `/auth/callback` without a session)
- session/cookie failures
- storefront widget requests to the old host

## 11. Remove old configuration — only after §10 is quiet

- [ ] Remove old redirect URIs from every provider
- [ ] Remove the marketing-host entry from `shopify.app.toml`, and its exemption
      from `scripts/check-domains.mjs`, in the same change
- [ ] Remove the old Stripe endpoint and its secret
- [ ] Remove old webhook registrations
- [ ] Consider promoting redirects from 302 to 301
- [ ] Remove old Authentik redirect URIs

---

## Rollback

| Stage | Rollback | Reversible |
|---|---|---|
| 1 Cloudflare | remove DNS/ingress for `app.` | yes, immediate |
| 2 env + gateway | redeploy previous image, restore vars | yes, needs a rebuild |
| 3 Authentik URIs | old URIs still present | yes |
| 3 cookie domain | restore previous value | **sessions invalidated either way** |
| 3 WebAuthn RP ID | restore previous value | **no — passkeys already invalidated** |
| 4 OAuth allow-lists | old URIs still present | yes |
| 5 Shopify Chat deploy | redeploy previous manifest | yes, but merchants mid-install may fail |
| 5 Meta callback | restore old URL | yes, events during the gap are lost |
| 5 Stripe endpoint | disable the new endpoint | yes, old endpoint untouched |
| 7 redirects (302) | delete the rule | yes |
| 7 redirects (301) | **cached by browsers** | effectively no |
| 8 widget extension | re-publish previous version | slow — merchant themes lag |

**Point of no return:** step 11. Until then every step has a path back.

The two genuinely irreversible items — WebAuthn RP ID and any 301 — are both
avoidable. Do not change the RP ID unless it is unavoidable, and do not promote
redirects to 301 until the migration is finished.
