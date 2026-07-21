#!/usr/bin/env node
/**
 * Idempotent Authentik bootstrap for GOTCHA.
 *
 * Creates (or updates in place) the OIDC provider + application that GOTCHA
 * authenticates against. Safe to re-run: every object is looked up by name
 * first and patched rather than duplicated.
 *
 * The app is registered as a PUBLIC client: the frontend is a browser SPA, so
 * it cannot hold a client secret. Authorization Code + PKCE is the only
 * supported flow, and PKCE is enforced server-side by Authentik for public
 * clients.
 *
 * Usage:
 *   AUTHENTIK_URL=http://localhost:9000 \
 *   AUTHENTIK_BOOTSTRAP_TOKEN=... \
 *   node scripts/authentik/bootstrap.mjs
 */

const BASE = (process.env.AUTHENTIK_URL || "http://localhost:9000").replace(/\/$/, "");
const TOKEN = process.env.AUTHENTIK_BOOTSTRAP_TOKEN;
const APP_SLUG = process.env.AUTHENTIK_APP_SLUG || "gotcha";
const CLIENT_ID = process.env.AUTHENTIK_CLIENT_ID || "gotcha-app";

// Where Authentik is allowed to send the user back after login. Anything not
// listed here is rejected by Authentik - this is the open-redirect gate.
const REDIRECT_URIS = (
  process.env.AUTHENTIK_REDIRECT_URIS ||
  "http://localhost:3000/auth/callback,http://localhost/auth/callback,https://app.gotcha.co.il/auth/callback"
).split(",").map((s) => s.trim()).filter(Boolean);

const POST_LOGOUT_URIS = (
  process.env.AUTHENTIK_POST_LOGOUT_URIS ||
  "http://localhost:3000/,http://localhost/,https://app.gotcha.co.il/"
).split(",").map((s) => s.trim()).filter(Boolean);

// Where "open GOTCHA" points from inside Authentik (app tile, brand default
// application, post-login root redirect). Without this Authentik guesses the
// launch URL from the first redirect URI - localhost - and strands anyone who
// completes a login on the IdP itself in its own user library.
const APP_LAUNCH_URL = (
  process.env.AUTHENTIK_APP_LAUNCH_URL ||
  process.env.FRONTEND_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

if (!TOKEN) {
  console.error("AUTHENTIK_BOOTSTRAP_TOKEN is required");
  process.exit(1);
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}/api/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function findFlow(designation, slug) {
  const r = await api(`/flows/instances/?designation=${designation}`);
  const match = r.results.find((f) => f.slug === slug) || r.results[0];
  if (!match) throw new Error(`No ${designation} flow found`);
  return match.pk;
}

async function findStage(name) {
  const r = await api(`/stages/all/?page_size=100`);
  const s = r.results.find((x) => x.name === name);
  if (!s) throw new Error(`Stage not found: ${name}`);
  return s.pk;
}

async function bindStage(flowPk, stagePk, order) {
  const existing = await api(`/flows/bindings/?target=${flowPk}`);
  const found = existing.results.find((b) => b.stage === stagePk);
  if (found) return;
  await api("/flows/bindings/", {
    method: "POST",
    body: JSON.stringify({ target: flowPk, stage: stagePk, order, evaluate_on_plan: true, re_evaluate_policies: false }),
  });
}

/**
 * A recovery flow is what makes invitations and password reset work. A default
 * Authentik install ships none, and without one bound to the brand the
 * `/core/users/{pk}/recovery/` endpoint returns "No recovery flow set" - so
 * every invitation would fail. We build it from the stock stages:
 *   prompt (choose a password) -> user_write (save it) -> login (session)
 * There is no identification stage: entry is via the one-time link we mint, so
 * the user is already known and asking again would only invite enumeration.
 *
 * authentication MUST be "none", not "require_unauthenticated": the one-time
 * flow token is the real gate, and an invitee who opens the link in a browser
 * that already holds ANY Authentik session (an admin testing their own invite,
 * a user invited to a second workspace) would otherwise get "Request has been
 * denied." - and the denied attempt still CONSUMES the token, burning the link
 * permanently.
 */
async function ensureRecoveryFlow() {
  const slug = "gotcha-recovery";
  const existing = await api(`/flows/instances/?slug=${slug}`);
  let flow = existing.results[0];

  if (!flow) {
    flow = await api("/flows/instances/", {
      method: "POST",
      body: JSON.stringify({
        name: "GOTCHA Recovery",
        slug,
        title: "Set your password",
        designation: "recovery",
        authentication: "none",
      }),
    });
    console.log("[bootstrap] recovery flow created");
  } else {
    // Converge existing installs (older bootstraps created it as
    // require_unauthenticated, which denies + burns invite links opened in a
    // browser with a live session).
    await api(`/flows/instances/${slug}/`, {
      method: "PATCH",
      body: JSON.stringify({ authentication: "none" }),
    });
    console.log("[bootstrap] recovery flow exists (authentication converged to none)");
  }

  await bindStage(flow.pk, await findStage("default-password-change-prompt"), 20);
  await bindStage(flow.pk, await findStage("default-password-change-write"), 30);
  await bindStage(flow.pk, await findStage("default-authentication-login"), 100);

  return flow.pk;
}

/**
 * SELF-SERVICE recovery ("Forgot username or password?" on the login page).
 *
 * `ensureRecoveryFlow` (above) has NO identification/verification because it is
 * only ever entered through a one-time link WE mint and email (invitations,
 * admin-triggered resets) - the link itself is the proof of identity. But the
 * login page's recovery link lets ANYONE start recovery, so it must NOT jump
 * straight to "set a new password" (that would let a stranger reset an account
 * they can name). This flow adds the missing proof:
 *   identification (enter email) -> email (click the link we send) -> prompt
 *   (choose password) -> write -> login
 * so a self-service reset requires control of the account's mailbox. It reuses
 * the stock password prompt/write/login stages and a dedicated email stage on
 * the global SMTP settings. Bound to the login identification stage's
 * `recovery_flow` (see ensureSingleScreenLogin). Returns the flow pk.
 */
async function ensureSelfServiceRecoveryFlow() {
  // Email verification stage (global SMTP, 30-min token). Upserted so template
  // changes reach existing installs. The template is GOTCHA-branded (no
  // Authentik logo or wording) - scripts/authentik/templates/, bind-mounted at
  // /templates/gotcha_password_reset.html in server + worker.
  const emailStagePayload = {
    name: "gotcha-recovery-email",
    use_global_settings: true,
    subject: "Reset your GOTCHA password",
    template: "gotcha_password_reset.html",
    activate_user_on_success: false,
    token_expiry: 30,
  };
  let email = (await api(`/stages/email/?name=gotcha-recovery-email`)).results?.[0];
  if (!email) {
    email = await api("/stages/email/", {
      method: "POST",
      body: JSON.stringify(emailStagePayload),
    });
    console.log("[bootstrap] recovery email stage created");
  } else {
    email = await api(`/stages/email/${email.pk}/`, {
      method: "PATCH",
      body: JSON.stringify(emailStagePayload),
    });
    console.log("[bootstrap] recovery email stage updated");
  }

  // Identification stage WITHOUT a password field and WITHOUT its own
  // recovery_flow (that would loop). pretend_user_exists avoids leaking whether
  // an address is registered.
  let ident = (await api(`/stages/identification/?name=gotcha-recovery-identification`)).results?.[0];
  if (!ident) {
    ident = await api("/stages/identification/", {
      method: "POST",
      body: JSON.stringify({
        name: "gotcha-recovery-identification",
        user_fields: ["email", "username"],
        case_insensitive_matching: true,
        show_matched_user: false,
        pretend_user_exists: true,
      }),
    });
    console.log("[bootstrap] recovery identification stage created");
  }

  const slug = "gotcha-recovery-self";
  let flow = (await api(`/flows/instances/?slug=${slug}`)).results?.[0];
  if (!flow) {
    flow = await api("/flows/instances/", {
      method: "POST",
      body: JSON.stringify({
        name: "GOTCHA Recovery (self-service)",
        slug,
        title: "Reset your password",
        designation: "recovery",
        // "none", not "require_unauthenticated": the reset EMAIL link must
        // keep working in a browser that already holds a session (same trap as
        // the invite flow above - denial would burn the one-time token).
        authentication: "none",
      }),
    });
    console.log("[bootstrap] self-service recovery flow created");
  } else {
    await api(`/flows/instances/${slug}/`, {
      method: "PATCH",
      body: JSON.stringify({ authentication: "none" }),
    });
  }

  await bindStage(flow.pk, ident.pk, 10);
  await bindStage(flow.pk, email.pk, 20);
  await bindStage(flow.pk, await findStage("default-password-change-prompt"), 30);
  await bindStage(flow.pk, await findStage("default-password-change-write"), 40);
  await bindStage(flow.pk, await findStage("default-authentication-login"), 50);

  return flow.pk;
}

/**
 * Make MFA enrolment reachable from the user-settings flow: TOTP, WebAuthn
 * (passkeys), and static recovery codes.
 *
 * The authentication flow already validates all three device classes; without
 * these bindings a user has no way to actually register a device, so MFA would
 * be "supported" and unusable.
 */
async function ensureMfaEnrollment() {
  const settings = await api(`/flows/instances/?slug=default-user-settings-flow`);
  const flowPk = settings.results[0]?.pk;
  if (!flowPk) throw new Error("default-user-settings-flow missing");

  await bindStage(flowPk, await findStage("default-authenticator-totp-setup"), 30);
  await bindStage(flowPk, await findStage("default-authenticator-webauthn-setup"), 40);
  await bindStage(flowPk, await findStage("default-authenticator-static-setup"), 50);
  console.log("[bootstrap] MFA enrolment stages bound (totp, webauthn/passkeys, recovery codes)");
}

/**
 * MFA ENFORCEMENT (security master plan F-3).
 *
 * ensureMfaEnrollment only makes enrolment *reachable*; it does not force it.
 * The stock authentication flow binds an authenticator-validation stage
 * (default-authentication-mfa-validation) whose `not_configured_action`
 * defaults to "skip" - so a user with no enrolled device sails straight past
 * the MFA check. We flip it to "configure": users without a compatible device
 * are forced to enrol inline before authentication can complete.
 *
 * Authentik enforcement is per-flow, not per-tenant/role, so this necessarily
 * applies to every user of the authentication flow. That is acceptable and, in
 * fact, is what the audit needs: flow-wide enforcement covers ADMIN /
 * SYSTEM_ADMIN, the privileged accounts F-3 requires MFA on.
 *
 * `configure` needs a stage to enrol the user in-flow, supplied via
 * `configuration_stages`; we point it at the TOTP setup stage (the same stage
 * bound into user settings by ensureMfaEnrollment) so enrolment completes
 * without leaving the login. PATCH is idempotent - re-running sets the same
 * values.
 */
async function ensureMfaEnforcement() {
  const stages = await api(`/stages/authenticator/validate/`);
  const validate = stages.results.find((s) => s.name === "default-authentication-mfa-validation");
  if (!validate) throw new Error("default-authentication-mfa-validation stage not found");

  const totpSetupPk = await findStage("default-authenticator-totp-setup");

  // not_configured_action = "skip", NOT "configure".
  //
  // Authentik's enforcement is per-FLOW - "configure" would force MFA enrolment
  // on EVERY user of the login flow (all tenants, all roles) at sign-in. That
  // contradicts GOTCHA's hierarchical, per-tenant policy (SYSTEM_ADMIN always;
  // ADMIN/AGENT only when the tenant opts in; default OFF). GOTCHA now owns
  // enforcement via the account /mfa-gate + the MfaEnrollmentGate + the
  // enforceMfaEnrollment API guard, so Authentik must NOT independently force
  // enrolment. "skip" still means a user who HAS a device is challenged for it;
  // it only stops Authentik from forcing enrolment on users who have none.
  // (configuration_stages kept so the validation stage can still offer inline
  // enrolment if a future flow ever sets the action back to "configure".)
  await api(`/stages/authenticator/validate/${validate.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({
      not_configured_action: "skip",
      configuration_stages: [totpSetupPk],
    }),
  });
  console.log("[bootstrap] MFA validation set to skip (GOTCHA owns per-tenant enforcement)");
}

/**
 * PASSWORD STRENGTH POLICY (security master plan F-3).
 *
 * Attach a strength policy to the password-setting prompt so weak passwords
 * are rejected at recovery / invitation time. The ONLY correct attachment
 * point is the prompt STAGE's `validation_policies` - the prompt stage runs
 * those against the submitted fields (with the typed password in context) on
 * every submit.
 *
 * Do NOT bind the policy to the prompt's *flow-stage binding*: those policies
 * gate whether the stage is INCLUDED, and `/core/users/{pk}/recovery/` plans
 * the flow at link-creation time where no password exists in context - the
 * policy fails ("Password not set in context"), the prompt stage is silently
 * dropped from the plan, and every invite/recovery link dies on user_write
 * with "Request has been denied. No Pending data." (burning the one-time
 * token). That mis-binding shipped in an earlier bootstrap; the cleanup below
 * removes it from existing installs.
 *
 * Requirements: >= 12 chars, at least one upper/lower/digit/symbol
 * (check_static_rules), reject known-breached passwords via HaveIBeenPwned
 * (check_have_i_been_pwned, hibp_allowed_count=0) and guessable passwords via
 * zxcvbn (check_zxcvbn, fail when score <= 2). All three checks are supported
 * in Authentik 2024.10.
 *
 * Idempotent: the policy is looked up by name and PATCHed if present, and the
 * binding is created only when absent.
 */
async function ensurePasswordPolicy(recoveryFlowPk) {
  const POLICY_NAME = "gotcha-password-strength";

  const policyPayload = {
    name: POLICY_NAME,
    length_min: 12,
    amount_uppercase: 1,
    amount_lowercase: 1,
    amount_digits: 1,
    amount_symbols: 1,
    check_static_rules: true,
    check_have_i_been_pwned: true,
    hibp_allowed_count: 0,
    check_zxcvbn: true,
    zxcvbn_score_threshold: 2,
    error_message:
      "Password must be at least 12 characters with upper and lower case letters, a number, and a symbol, and must not appear in a known breach.",
    execution_logging: true,
  };

  const existing = await api(`/policies/password/`);
  const found = existing.results.find((p) => p.name === POLICY_NAME);
  let policyPk;
  if (found) {
    const updated = await api(`/policies/password/${found.pk}/`, {
      method: "PATCH",
      body: JSON.stringify(policyPayload),
    });
    policyPk = updated.pk;
    console.log("[bootstrap] password policy updated");
  } else {
    const created = await api(`/policies/password/`, {
      method: "POST",
      body: JSON.stringify(policyPayload),
    });
    policyPk = created.pk;
    console.log("[bootstrap] password policy created");
  }

  const promptStagePk = await findStage("default-password-change-prompt");

  // Remove the legacy mis-binding (policy on the flow-stage binding) so
  // recovery-link plans include the prompt stage again.
  try {
    const policyBindings = await api(`/policies/bindings/?policy=${policyPk}&page_size=100`);
    for (const b of policyBindings.results ?? []) {
      await api(`/policies/bindings/${b.pk}/`, { method: "DELETE" });
      console.log("[bootstrap] removed legacy password-policy flow binding");
    }
  } catch {
    /* no legacy binding to clean */
  }

  // Attach as a prompt-stage validation policy (merged with whatever the stock
  // stage already validates with, e.g. default-password-change-password-policy).
  const promptStage = await api(`/stages/prompt/stages/${promptStagePk}/`);
  const validation = new Set(promptStage.validation_policies ?? []);
  if (!validation.has(policyPk)) {
    validation.add(policyPk);
    await api(`/stages/prompt/stages/${promptStagePk}/`, {
      method: "PATCH",
      body: JSON.stringify({ validation_policies: [...validation] }),
    });
  }
  console.log("[bootstrap] password policy attached to prompt stage validation");
}

/**
 * One credential screen instead of two: embed the password prompt inside the
 * identification stage (email + password together) and drop the standalone
 * password binding from the authentication flow - leaving it bound would
 * prompt for the password a second time. MFA and login stages stay as-is.
 * Idempotent: PATCHing the same value and deleting an absent binding are
 * both no-ops.
 *
 * Also binds the SELF-SERVICE recovery flow to the identification stage so it
 * renders the "Forgot username or password?" link. The brand-level
 * `flow_recovery` alone does NOT surface this link on the login screen - the
 * identification stage needs its own `recovery_flow` set. This must be the
 * self-service flow (identification + email verification), never the link-only
 * flow, or the login page would offer an unverified password reset.
 */
async function ensureSingleScreenLogin(selfRecoveryFlowPk) {
  const idStages = await api("/stages/identification/?name=default-authentication-identification");
  const idStage = idStages.results?.[0];
  const pwStagePk = await findStage("default-authentication-password");
  if (!idStage) throw new Error("identification stage not found");

  if (idStage.password_stage !== pwStagePk || idStage.recovery_flow !== selfRecoveryFlowPk) {
    await api(`/stages/identification/${idStage.pk}/`, {
      method: "PATCH",
      // user_fields must ride along: the serializer validates the pair even on
      // a partial update and treats an absent list as empty.
      body: JSON.stringify({
        password_stage: pwStagePk,
        recovery_flow: selfRecoveryFlowPk,
        user_fields: idStage.user_fields?.length ? idStage.user_fields : ["email", "username"],
      }),
    });
  }

  const authFlowPk = await findFlow("authentication", "default-authentication-flow");
  const bindings = await api(`/flows/bindings/?target=${authFlowPk}`);
  const pwBinding = bindings.results.find((b) => b.stage === pwStagePk);
  if (pwBinding) {
    await api(`/flows/bindings/${pwBinding.pk}/`, { method: "DELETE" });
  }
  console.log("[bootstrap] single-screen login (password embedded in identification)");
}

/**
 * SESSION LIFETIME + "REMEMBER ME".
 *
 * The IdP session (the SSO cookie minted by the user-login stage) is what
 * "stay signed in" really means - tokens are short-lived and refresh against
 * it. Both knobs are deployment policy, injected via env, never hardcoded:
 *
 *   AUTHENTIK_SESSION_DURATION   base session length. "seconds=0" = a browser
 *                                session (ends when the browser closes) - the
 *                                conservative default.
 *   AUTHENTIK_REMEMBER_ME_OFFSET extra lifetime granted when the user ticks
 *                                "Stay signed in" on the login screen. A
 *                                non-zero value is ALSO what makes Authentik
 *                                render the checkbox. "seconds=0" disables
 *                                the feature entirely.
 *
 * Values use Authentik's timedelta syntax ("days=30", "hours=12").
 * Older Authentik versions have no remember_me_offset field; DRF silently
 * ignores unknown fields, so we read the stage back and warn instead of
 * pretending the checkbox exists.
 */
async function ensureSessionPolicy() {
  const stages = await api(`/stages/user_login/`);
  const login = stages.results.find((s) => s.name === "default-authentication-login");
  if (!login) throw new Error("default-authentication-login stage not found");

  const sessionDuration = process.env.AUTHENTIK_SESSION_DURATION || "seconds=0";
  const rememberOffset = process.env.AUTHENTIK_REMEMBER_ME_OFFSET || "days=30";

  await api(`/stages/user_login/${login.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({
      session_duration: sessionDuration,
      remember_me_offset: rememberOffset,
    }),
  });

  const updated = await api(`/stages/user_login/${login.pk}/`);
  if (typeof updated.remember_me_offset === "undefined") {
    console.warn(
      "[bootstrap] this Authentik version has no remember_me_offset - 'Stay signed in' checkbox unavailable; session_duration still applied",
    );
  } else {
    console.log(
      `[bootstrap] session policy: duration=${sessionDuration}, remember-me offset=${updated.remember_me_offset}`,
    );
  }
}

/**
 * GOTCHA branding, so auth.gotcha.co.il does not look like a bolted-on
 * third-party login.
 */
// GOTCHA users must be type "external" (app users of the IdP). Internal users
// landing on the IdP root get its "My applications" library; external users get
// redirected to the brand's default application (GOTCHA). Only akadmin and
// service accounts stay internal.
async function ensureExternalUsers() {
  let page = 1;
  let converted = 0;
  for (;;) {
    const res = await api(`/core/users/?type=internal&page=${page}&page_size=100`);
    for (const u of res.results || []) {
      if (u.username === "akadmin") continue;
      await api(`/core/users/${u.pk}/`, {
        method: "PATCH",
        body: JSON.stringify({ type: "external" }),
      });
      converted++;
    }
    if (!res.pagination || res.pagination.next === 0 || !res.pagination.next) break;
    page = res.pagination.next;
  }
  if (converted) console.log(`[bootstrap] ${converted} user(s) converted to external type`);
}

async function ensureBranding(recoveryFlowPk, appPk) {
  const brands = await api("/core/brands/");
  const brand = brands.results.find((b) => b.domain === "authentik-default") || brands.results[0];
  if (!brand) throw new Error("No brand found");

  await api(`/core/brands/${brand.brand_uuid}/`, {
    method: "PATCH",
    body: JSON.stringify({
      branding_title: "GOTCHA",
      // Point at the GOTCHA assets bind-mounted into /web/dist/assets/custom/ by
      // docker-compose (dev + prod), served at /static/dist/assets/custom/*.
      // These replace the stock Authentik icon/wordmark so the IdP tab, logo,
      // and favicon all read as GOTCHA. Still overridable via env for a CDN URL.
      branding_logo: process.env.AUTHENTIK_BRANDING_LOGO || "/static/dist/assets/custom/logo_icon.png",
      branding_favicon: process.env.AUTHENTIK_BRANDING_FAVICON || "/static/dist/assets/custom/gotcha-favicon.ico",
      flow_recovery: recoveryFlowPk,
      // Anyone who completes a login ON the IdP itself (e.g. after a logout
      // stranded them there, or a bookmarked flow URL) lands on GOTCHA instead
      // of Authentik's "My applications" library.
      default_application: appPk || null,
    }),
  });
  console.log("[bootstrap] branding applied + recovery flow bound to brand");

  // The login card's heading comes from the flow title; the stock value is
  // "Welcome to authentik!", which breaks the one-product illusion the theme
  // (scripts/authentik/custom.css) is there to create.
  const authFlows = await api("/flows/instances/?slug=default-authentication-flow");
  const authFlow = authFlows.results?.[0];
  if (authFlow) {
    await api(`/flows/instances/${authFlow.slug}/`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Welcome back" }),
    });
    console.log("[bootstrap] authentication flow title set");
  }
}

async function main() {
  console.log(`[bootstrap] target: ${BASE}`);

  // Use the EXPLICIT-consent flow, not implicit. Counter-intuitive, but: the
  // `offline_access` scope (refresh token) can never be granted silently, so
  // the IMPLICIT flow shows a consent screen for it on EVERY login AND does not
  // store the grant (it has no consent stage) - users hit "You're about to sign
  // into GOTCHA" every single time. The explicit-consent flow DOES have a
  // consent stage; with its mode set to "permanent" (below) a user consents
  // exactly once, ever, and every later login skips the screen entirely.
  const authorizationFlow = await findFlow("authorization", "default-provider-authorization-explicit-consent");
  const invalidationFlow = await findFlow("invalidation", "default-provider-invalidation-flow");

  // Store OAuth consent permanently so the authorization screen is a one-time
  // step, not a per-login interruption (see the note on authorizationFlow).
  const consentStages = await api("/stages/consent/?name=default-provider-authorization-consent");
  const consentStage = consentStages.results?.[0];
  if (consentStage && consentStage.mode !== "permanent") {
    await api(`/stages/consent/${consentStage.pk}/`, {
      method: "PATCH",
      body: JSON.stringify({ mode: "permanent" }),
    });
    console.log("[bootstrap] OAuth consent set to permanent (one-time authorization)");
  }

  // Signing key: Authentik must sign ID/access tokens with an asymmetric key
  // so the backend can verify via JWKS. The self-signed cert is fine for dev;
  // production should swap in a managed keypair (see docs).
  const keys = await api("/crypto/certificatekeypairs/?has_key=true");
  const signingKey = keys.results[0]?.pk;
  if (!signingKey) throw new Error("No signing keypair available");

  // openid + email + profile are the standard claims; offline_access yields a
  // refresh token so the SPA can renew without a full redirect.
  const scopeMappings = await api("/propertymappings/provider/scope/");
  const wanted = ["openid", "email", "profile", "offline_access"];
  const propertyMappings = scopeMappings.results
    .filter((m) => wanted.includes(m.scope_name))
    .map((m) => m.pk);

  const providerPayload = {
    name: "gotcha-oidc",
    authorization_flow: authorizationFlow,
    invalidation_flow: invalidationFlow,
    client_type: "public", // SPA -> PKCE, no secret
    client_id: CLIENT_ID,
    // NOTE: post_logout_redirect_uri is NOT supported by this Authentik version
    // (the provider field was removed in an old migration; end-session always
    // finishes at the IdP root). Returning users to GOTCHA after logout - and
    // after any login done ON the IdP itself - relies on users being type
    // "external" + the brand's default_application (both set by this script).
    redirect_uris: REDIRECT_URIS.map((url) => ({ matching_mode: "strict", url })),
    property_mappings: propertyMappings,
    signing_key: signingKey,
    // `sub` is the join key to User.authentikSubject, so it must be stable,
    // immutable, and knowable at invite time.
    //   - user_uuid: Authentik's immutable user UUID. Returned when we create
    //     the identity, so an invited user can be bound to their subject
    //     before they ever log in.
    //   - NOT user_email / user_username: both are mutable, so changing an
    //     email in Authentik would silently re-point the subject at another
    //     GOTCHA account.
    //   - NOT hashed_user_id: opaque and not knowable at creation time, which
    //     would force fragile email-matching on first login.
    sub_mode: "user_uuid",
    include_claims_in_id_token: true,
    issuer_mode: "per_provider",
    access_code_validity: "minutes=1",
    // Token lifetimes are deployment policy, not code - override via env.
    // Values use Authentik's timedelta syntax ("minutes=30", "hours=8", "days=30").
    access_token_validity: process.env.AUTHENTIK_ACCESS_TOKEN_VALIDITY || "minutes=30",
    refresh_token_validity: process.env.AUTHENTIK_REFRESH_TOKEN_VALIDITY || "days=30",
  };

  const existingProviders = await api("/providers/oauth2/");
  const existing = existingProviders.results.find((p) => p.name === providerPayload.name);

  let provider;
  if (existing) {
    provider = await api(`/providers/oauth2/${existing.pk}/`, {
      method: "PATCH",
      body: JSON.stringify(providerPayload),
    });
    console.log(`[bootstrap] provider updated (pk=${provider.pk})`);
  } else {
    provider = await api("/providers/oauth2/", {
      method: "POST",
      body: JSON.stringify(providerPayload),
    });
    console.log(`[bootstrap] provider created (pk=${provider.pk})`);
  }

  const appPayload = {
    name: "GOTCHA",
    slug: APP_SLUG,
    provider: provider.pk,
    meta_description: "GOTCHA - next generation of customer engagement",
    // Explicit launch URL: without it Authentik derives one from the first
    // redirect URI (localhost) and every "open the app" affordance on the IdP
    // side points at the wrong host.
    meta_launch_url: APP_LAUNCH_URL,
  };

  const apps = await api("/core/applications/");
  const existingApp = apps.results.find((a) => a.slug === APP_SLUG);
  let app;
  if (existingApp) {
    app = await api(`/core/applications/${existingApp.slug}/`, {
      method: "PATCH",
      body: JSON.stringify(appPayload),
    });
    console.log("[bootstrap] application updated");
  } else {
    app = await api("/core/applications/", { method: "POST", body: JSON.stringify(appPayload) });
    console.log("[bootstrap] application created");
  }

  const recoveryFlowPk = await ensureRecoveryFlow();
  const selfRecoveryFlowPk = await ensureSelfServiceRecoveryFlow();
  await ensureMfaEnrollment();
  await ensureMfaEnforcement();
  await ensurePasswordPolicy(recoveryFlowPk);
  // The login page's "Forgot username or password?" link points at the
  // self-service flow (identification + email verification), NOT the bare
  // link-only recovery flow.
  await ensureSingleScreenLogin(selfRecoveryFlowPk);
  await ensureSessionPolicy();
  // The brand-level recovery flow (used by createRecoveryLink / invitations)
  // stays the link-only flow - those links are already proof of identity.
  await ensureBranding(recoveryFlowPk, app?.pk);
  await ensureExternalUsers();

  const issuer = `${BASE}/application/o/${APP_SLUG}/`;
  const wellKnown = await fetch(`${issuer}.well-known/openid-configuration`);
  if (!wellKnown.ok) throw new Error(`Discovery document not reachable at ${issuer}`);
  const disco = await wellKnown.json();

  console.log("\n─── Wire these into .env ───");
  console.log(`OIDC_ISSUER=${disco.issuer}`);
  console.log(`OIDC_JWKS_URI=${disco.jwks_uri}`);
  console.log(`OIDC_CLIENT_ID=${CLIENT_ID}`);
  console.log(`NEXT_PUBLIC_OIDC_ISSUER=${disco.issuer}`);
  console.log(`NEXT_PUBLIC_OIDC_CLIENT_ID=${CLIENT_ID}`);
  console.log(`[bootstrap] POST-PKCE verified: ${disco.code_challenge_methods_supported?.join(",")}`);
}

main().catch((err) => {
  console.error("[bootstrap] FAILED:", err.message);
  process.exit(1);
});
