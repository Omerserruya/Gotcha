# Provisioning the clean Shopify App Review tenant

Reference 132211, section 4. Everything here needs a **SYSTEM_ADMIN** session,
which is why it is a runbook and not a script I can run: I cannot mint that
token, and the password is set by the operator through Authentik, never by us.

**No password appears in this file, in any log, or in any commit.** The flow
below never produces one for us to see: Authentik issues a setup link and the
reviewer's password is set by whoever opens it.

---

## 0. Why a new tenant rather than reusing the old one

The account the reviewer used belongs to `Urban Supply - GOTCHA Demo`
(`cmsh6kuij0003dn173eaebwm2`). That tenant carries a `DISCONNECTED` Shopify
integration row pointing at `urban-supply-gotcha-demo.myshopify.com`, which is
why the reviewer wrote "the app is currently integrated with your demo store"
and then saw `DISCONNECTED`.

Detaching that email from that tenant would leave the demo data behind and risk
the same inherited state the spec is trying to eliminate. A new tenant is
cleaner and cheaper.

---

## 1. Get a SYSTEM_ADMIN token

Sign in to GOTCHA as the system administrator, then take the access token from
the browser session. Export it into your shell:

```bash
export SYS_TOKEN='...'          # paste, do not echo it afterwards
export API=https://app.gotcha.co.il
```

Sanity check that the token really carries SYSTEM_ADMIN:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $SYS_TOKEN" \
  "$API/api/system/poc-feature-domains"
# 200 = good. 401/403 = not a system-admin token.
```

## 2. Read the grantable feature domains

The review account has to reach the complete feature set, so grant every
domain rather than a guess at a subset:

```bash
curl -s -H "Authorization: Bearer $SYS_TOKEN" \
  "$API/api/system/poc-feature-domains" | tee /tmp/domains.json
```

## 3. Create the tenant

POC rather than PAID_PLAN, deliberately. A paid tenant that has not paid is
sent to a payment screen by `destinationForTenantStatus`, and a reviewer who
lands on "please pay" has failed 4.5.5 for a second, different reason.

Set the expiry comfortably past the review window.

```bash
DOMAINS=$(jq -c '.data' /tmp/domains.json)

curl -s -X POST "$API/api/system/tenants" \
  -H "Authorization: Bearer $SYS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --argjson d "$DOMAINS" '{
        name: "GOTCHA App Review",
        slug: "gotcha-app-review",
        adminEmail: "<REVIEW EMAIL YOU CONTROL>",
        adminName: "Shopify App Review",
        billing: {
          mode: "POC",
          pocCredits: 100000,
          pocExpiresAt: "2026-12-31T23:59:59.000Z",
          pocFeatureAreas: $d
        }
      }')" | jq .
```

Record the returned tenant id. The admin user is created as part of this call,
so **step 4 is only needed if you want a second user.**

> The email must be an address GOTCHA actually controls and can receive mail
> at. Do not invent one: the setup link is delivered to it.

## 4. (Optional) an additional user

```bash
curl -s -X POST "$API/api/system/tenants/<TENANT_ID>/users" \
  -H "Authorization: Bearer $SYS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"<EMAIL>","name":"Shopify App Review","role":"ADMIN"}' | jq .
```

`ADMIN` is the highest ordinary tenant role. It is **not** `SYSTEM_ADMIN`, which
the spec forbids and which would also bounce the reviewer to `/system` instead
of into the product (`AppLayout` redirects system admins away from the app).

## 5. Set the password (operator only)

The invite issues an Authentik setup link by email. Open it and set a password.

Two things to check while you are in Authentik, both of which would fail the
review on their own:

- **MFA must not be enforced** for this user. A reviewer cannot pass a second
  factor bound to your phone.
- **No forced password change on first login**, and no social-login
  requirement.

Setup links are short-lived (this bit us before: Authentik's
`default_token_duration` expired invites after 30 minutes), so open it
promptly or reissue.

## 6. Verify the tenant is genuinely clean

Run this read-only check and expect every count to be zero.

```sql
-- against the production database
SELECT
  (SELECT count(*) FROM commerce_connections  WHERE tenant_id = '<TENANT_ID>') AS connections,
  (SELECT count(*) FROM provider_subscriptions WHERE tenant_id = '<TENANT_ID>') AS subscriptions,
  (SELECT count(*) FROM shopify_grandfather_grants WHERE tenant_id = '<TENANT_ID>') AS grandfather,
  (SELECT count(*) FROM tenant_entitlements
     WHERE tenant_id = '<TENANT_ID>'
       AND funded_by_billing_source = 'SHOPIFY')                                  AS shopify_entitlements;
```

Also confirm the reviewer lands **in this tenant** on login and is not offered a
choice between this and the old demo tenant.

## 7. What to hand Shopify

- the review email
- the password, through the Partner Dashboard credentials field only
- the direct install link

Never in a commit, a log, this document, or the engineering report.
