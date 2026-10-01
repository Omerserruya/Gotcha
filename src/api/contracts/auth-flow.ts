import { z } from 'zod';

/**
 * Authentik's flow executor, as screen 00a drives it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THIS CONTRACT IS LOOSE, AND EVERY OTHER ONE IN THIS DIRECTORY IS STRICT
 * ════════════════════════════════════════════════════════════════════════════
 * The rest of `contracts/` describes routes we can ask Backend to change, so a
 * strict `z.object` is right: it names what we rely on and a surprise is a
 * conversation. **This describes a third party's API on a version nobody
 * promised us.** A strict object here strips an unknown field silently, and from
 * inside this codebase that is indistinguishable from Authentik not sending it —
 * which is the defect that hid `Message.status`, `taxed` and `upgradePath` this
 * week, three times, on contracts we DID own.
 *
 * So: `looseObject` throughout, and the distinction is written here because a
 * reader who has seen the other twenty files will assume this one is a mistake.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ AND THE IMPORTANT PART IS THE FALLBACK, NOT THE HAPPY PATH
 * ════════════════════════════════════════════════════════════════════════════
 * Driven on 2026-09-28: for a user with **no enrolled MFA device**, this flow is
 * two stages — `ak-stage-identification` (which takes the email AND the password
 * in one POST) and `ak-stage-user-login` (the "stay signed in" question).
 *
 * ⚠ WHAT THAT MEASUREMENT DOES NOT SAY, AND WAS FIRST REPORTED AS SAYING.
 * Both stages returned `device_challenges: []`, which was read as "this flow has
 * no authenticator stage". **It is equally consistent with "the flow has one and
 * this user has never enrolled a device"** — Authentik skips that stage
 * per-user. Settling it needs the flow's stage bindings, and
 * `/api/v3/flows/instances/…`, `/flows/bindings/` and `/stages/all/` all answer
 * **403** without admin credentials.
 *
 * So the honest statement is: **two stages for an unenrolled user, and nobody
 * has observed an enrolled one.** An `ak-stage-authenticator-validate` may well
 * appear, and this file must not read as though it cannot.
 *
 * ★★★ AND ON 2026-09-28 IT WAS SETTLED FROM THE FLOW'S OWN CONFIGURATION, read
 *   with an admin token rather than inferred from a challenge:
 *
 *       order  10   ak-stage-identification-form           email + password
 *       order  30   ak-stage-authenticator-validate-form   ← the second factor
 *       order 100   ak-stage-user-login-form               remember_me
 *
 *       default-authentication-mfa-validation
 *         not_configured_action: skip
 *         device_classes:  ['static', 'totp', 'webauthn', 'duo', 'sms']
 *         configuration_stages: [default-authenticator-totp-setup]
 *
 *   **`not_configured_action: skip` is the mechanism, in one word.** A user with
 *   no device is skipped past the stage, which is why two people driving the
 *   flow with an unenrolled account saw two stages and concluded there were two.
 *
 *   ★ THE ORDER MATTERS FOR THE PANEL: the second factor comes **before**
 *     "keep me signed in", not after. So the checkbox is the last thing in the
 *     flow, and a renderer that assumed MFA was the final step would put it in
 *     the wrong place.
 *
 *   ★★ AND `device_classes` ALLOWS FIVE, OF WHICH ONLY TWO ARE CODE ENTRY.
 *     `totp` and `static` are digits somebody types. **`webauthn` is a browser
 *     credential prompt, `duo` is a push notification, and `sms` is an
 *     out-of-band journey of its own** — so `chooseFactor` does not lead to "a
 *     code box" in general, and a renderer built around one would be wrong for
 *     three of the five the flow permits. What each of those three needs on the
 *     wire is unobserved; what is certain is that it is not six digits.
 *
 * ★★ AND EARLIER THE SAME DAY THE ODDS HAD ALREADY MOVED. While the gateway's redirect
 *   was still wrong, one POST landed in an odd flow position and Authentik
 *   answered with `component: "ak-stage-authenticator-validate"` and
 *   `non_field_errors: [{ string: "Empty response" }]`. **It does not invent
 *   component names for stages that are not bound to the flow.**
 *
 *   Evidence, not proof — it came from an anomalous run nobody could reproduce
 *   cleanly, and the bindings still answer 403. But it is strong enough that the
 *   handover below should be read as **the ordinary path for a colleague with
 *   two-step set up**, not as a guard against a hypothetical.
 *
 * ★ That is not a hypothetical worry about the future — it is the ordinary
 *   present for any colleague who has set up two-step. It is the strongest
 *   reason the handover below exists.
 *
 * **And a flow is Authentik configuration, not a deploy of ours** either way. An
 * administrator can add a stage this afternoon and our panel would meet a
 * component it has never heard of, mid-sign-in, with somebody's password already
 * accepted.
 *
 * So an unrecognised stage is not an error here: it means **this panel cannot
 * finish the job, and the identity provider's own page still can.** `handOver`
 * is the answer, and the full redirect flow stays in the product as the path we
 * fall back to rather than the path we replaced. An optimisation that cannot
 * degrade is not an optimisation, it is a second implementation.
 */

/**
 * Field errors, keyed by field name.
 *
 * Authentik puts errors that belong to no field under `non_field_errors`, which
 * is where a wrong password lands — the stage will not say *which* of email or
 * password was wrong, deliberately, and neither should we.
 */
export const NON_FIELD = 'non_field_errors';

const flowErrorsSchema = z
  .record(
    z.string(),
    z.array(z.looseObject({ string: z.string().default(''), code: z.string().default('') })),
  )
  .default({});

export type FlowErrors = z.infer<typeof flowErrorsSchema>;

const flowInfoSchema = z
  .looseObject({
    title: z.string().default(''),
    cancel_url: z.string().default(''),
  })
  .optional();

/** Email + password in one stage. The design's single panel, by luck or by design. */
export const identificationChallengeSchema = z.looseObject({
  component: z.literal('ak-stage-identification'),
  flow_info: flowInfoSchema,
  /** `["email", "username"]` here. Which identifier the stage will accept. */
  user_fields: z.array(z.string()).default([]),
  /** `true` on this tenant: the password is part of THIS stage, not the next. */
  password_fields: z.boolean().default(false),
  /**
   * Where "Forgot it?" goes. **Read from the challenge, never hardcoded** — it
   * is a flow slug an administrator can change, and a stale path here sends
   * somebody who has forgotten their password to a 404.
   */
  recovery_url: z.string().nullable().default(null),
  primary_action: z.string().default(''),
  response_errors: flowErrorsSchema,
});

/** "Stay signed in?" — a stage, which is why it can live in our own panel. */
export const userLoginChallengeSchema = z.looseObject({
  component: z.literal('ak-stage-user-login'),
  flow_info: flowInfoSchema,
  pending_user: z.string().default(''),
  response_errors: flowErrorsSchema,
});

/**
 * Authentik's device classes for a validate stage.
 *
 * ★ `static` IS RECOVERY CODES, AND IT ARRIVES AS A PEER. Not a link under the
 *   code box — an entry in the same `device_challenges` list as the
 *   authenticator app. So this stage is not "enter your code", it is **a choice
 *   between devices**, and any panel that renders it has to express that.
 *
 * Open on purpose: Authentik also ships `webauthn`, `duo`, `sms` and `email`
 * classes, and only two have been observed here. A class we do not recognise is
 * carried through rather than dropped, because dropping it would silently remove
 * somebody's only second factor from the list.
 */
export const OBSERVED_DEVICE_CLASSES = ['totp', 'static'] as const;

export const deviceChallengeSchema = z.looseObject({
  device_class: z.string().default(''),
  device_uid: z.string().default(''),
  /** Empty on both observed classes. The class carries the meaning. */
  challenge: z.looseObject({}).default({}),
  /** ISO timestamp, or null on a device nobody has used yet. */
  last_used: z.string().nullable().default(null),
});
export type DeviceChallenge = z.infer<typeof deviceChallengeSchema>;

/**
 * Second factor — measured 2026-09-28 against an enrolled account.
 *
 * ⚠⚠ THE SUBMIT SHAPE IS NOT KNOWN AND IS NOT GUESSED. Posting `{}` answers
 * `non_field_errors: [{ string: "Empty response" }]`, which — unlike
 * `ak-stage-user-login`'s `remember_me` — **does not name the field.** The
 * self-describing trick does not work on this stage.
 *
 * And it cannot be probed by trial: every malformed attempt is a failed
 * authentication that Authentik counts, against the one enrolled account there
 * is. Locking it to learn a field name would be a bad trade.
 *
 * So this parses the challenge and **nothing renders it yet.** The panel hands
 * over, as it did before, and the reason is now specific rather than "a stage we
 * have never heard of".
 */
export const authenticatorValidateChallengeSchema = z.looseObject({
  component: z.literal('ak-stage-authenticator-validate'),
  flow_info: flowInfoSchema,
  /**
   * ⚠ A USERNAME, NOT AN EMAIL — observed as `akadmin`. The design's panel puts
   * "Welcome back" over an identity, and this field will not always be a pretty
   * name. Whatever renders it must not assume an address.
   */
  pending_user: z.string().default(''),
  device_challenges: z.array(deviceChallengeSchema).default([]),
  /**
   * Empty for an already-enrolled user. **This is where 00b's second half —
   * enrolment — would appear**, for a user in a workspace that requires two-step
   * and has no device. Still unobserved.
   */
  configuration_stages: z.array(z.looseObject({})).default([]),
  response_errors: flowErrorsSchema,
});
export type AuthenticatorValidateChallenge = z.infer<typeof authenticatorValidateChallengeSchema>;

/**
 * What the validate stage accepts — from Authentik's own OpenAPI schema
 * (`GET /api/v3/schema/`, `2024.10.5`), **and confirmed against the live stage
 * on 2026-09-28**: a real TOTP code was submitted with this exact body and the
 * flow advanced to `ak-stage-user-login` with no `response_errors`.
 *
 * ★ So three things are measured rather than read: `code` as a **string** is
 *   correct here, `selected_challenge` takes the device object back **verbatim**
 *   (the confirmation echoed the challenge unmodified), and validate really does
 *   precede `user-login` — the bindings and the behaviour agree.
 *
 * ⚠ `static` IS NOT CONFIRMED. It shares the `code` field per the schema and no
 *   recovery code has been fired, because they are single-use and burning one to
 *   check a field name is a bad trade. Spec plus a confirmed sibling is strong
 *   evidence; it is not the same as having seen it, and the difference belongs
 *   here rather than in somebody's memory.
 *
 *     AuthenticatorValidationChallengeResponseRequest
 *       component           string
 *       selected_challenge  DeviceChallengeRequest   ← the whole device, echoed
 *       selected_stage      string
 *       code                string                   ← totp and static
 *       webauthn            object                   ← webauthn
 *       duo                 integer                  ← duo
 *
 * ★★ `code`, `webauthn` AND `duo` ARE THREE SEPARATE FIELDS, which settles
 *   something that was an inference from class names an hour ago: **these are
 *   three different journeys, and the payload says so.** A picker that leads to
 *   a code box is wrong for three of the five classes the flow permits, and that
 *   is now a fact about the contract rather than a reading of Authentik's docs.
 *
 * ★ `selected_challenge` takes the **entire** device object back — all four of
 *   `device_class`, `device_uid`, `challenge` and `last_used` are required. So
 *   the picker does not invent an identifier; it hands back exactly what it was
 *   given, which is also why nothing here needs to understand `challenge`.
 *
 * ⚠⚠ AND A TRAP TWO LINES APART IN THE SAME SCHEMA:
 *
 *     AuthenticatorValidationChallengeResponseRequest.code  →  string
 *     AuthenticatorTOTPChallengeResponseRequest.code        →  integer
 *
 * **Six digits, same name, different type, in two stages of one product.** A
 * shared `code` helper would be wrong in one of the two places, and the failure
 * would land at runtime on the screen where being wrong locks somebody out of
 * their account. This function is for **validation only** and is named so; when
 * enrolment is built it needs its own, with a number.
 */
export function validateBody(device: DeviceChallenge, code: string): Record<string, unknown> {
  return {
    component: 'ak-stage-authenticator-validate',
    selected_challenge: {
      device_class: device.device_class,
      device_uid: device.device_uid,
      challenge: device.challenge,
      last_used: device.last_used,
    },
    code,
  };
}

/**
 * Which device classes are a code somebody types.
 *
 * `totp` and `static` go through the `code` field. `webauthn` needs the browser
 * credential API and its own `webauthn` object; `duo` is a push and answers with
 * an integer; `sms` is out of band. **Three states, and the third is the point:**
 * a class nobody has seen is `unknown`, not `other`, because "we know this is not
 * a code box" and "we have never met this" are different facts and only one of
 * them licenses a fallback.
 */
export function factorEntry(deviceClass: string): 'code' | 'other' | 'unknown' {
  const normalised = deviceClass.trim().toLowerCase();
  if (normalised === 'totp' || normalised === 'static') return 'code';
  if (normalised === 'webauthn' || normalised === 'duo' || normalised === 'sms') return 'other';
  return 'unknown';
}

/**
 * The devices, most recently used first, never-used last.
 *
 * `last_used` is populated per device and `null` on one nobody has touched,
 * which is the affordance for ordering. Putting the familiar one first is the
 * design's *"never make somebody choose a method they cannot remember picking"*
 * applied to a list whose order somebody did not choose.
 *
 * ★ Stable within a group: two devices last used at the same instant keep the
 *   order the server sent, rather than swapping between renders.
 */
export function devicesByRecency(devices: readonly DeviceChallenge[]): readonly DeviceChallenge[] {
  return [...devices]
    .map((device, index) => ({ device, index }))
    .sort((a, b) => {
      const at = a.device.last_used ? Date.parse(a.device.last_used) : Number.NaN;
      const bt = b.device.last_used ? Date.parse(b.device.last_used) : Number.NaN;
      const aKnown = Number.isFinite(at);
      const bKnown = Number.isFinite(bt);
      if (aKnown && bKnown && at !== bt) return bt - at;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.device);
}

/**
 * The flow is done.
 *
 * ⚠⚠ `to` IS THE IDENTITY PROVIDER'S OWN PATH AND MUST NOT BE FOLLOWED.
 * Measured 2026-09-28: a completed sign-in returns `{ to: "/" }`, and that `/`
 * is Authentik's root, not ours. Following it lands somebody who has just signed
 * in successfully on a stranger's home page.
 *
 * It is parsed because it identifies the shape, and it is renamed on the way out
 * so that using it is a deliberate act rather than an obvious one.
 */
export const redirectChallengeSchema = z.looseObject({
  component: z.literal('xak-flow-redirect'),
  to: z.string().min(1),
});

export type IdentificationChallenge = z.infer<typeof identificationChallengeSchema>;
export type UserLoginChallenge = z.infer<typeof userLoginChallengeSchema>;
export type RedirectChallenge = z.infer<typeof redirectChallengeSchema>;

/**
 * Whether a completed flow's `to` is somewhere we are willing to send a
 * browser, and the exact URL if so.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ★★ `to` MEANS DIFFERENT THINGS DEPENDING ON WHICH FLOW PRODUCED IT
 * ═══════════════════════════════════════════════════════════════════════════════
 *   AUTHENTICATION flow, measured 2026-09-28   to: "/"
 *       — Authentik's own root. Following it lands somebody who has just
 *         signed in successfully on a stranger's home page.
 *   AUTHORIZATION flow, measured 2026-09-30    to: "https://…/api/auth/callback?code=…&state=…"
 *       — our own callback, carrying the code we are waiting for.
 *
 * **One field, two meanings, and only the second is followable.** So this does
 * not ask "is `to` safe" in the abstract — it asks whether `to` IS the
 * callback we registered, and answers null for everything else.
 *
 * ★ That is the reason it takes `expectedCallback` rather than an origin or a
 *   prefix. A same-origin check would accept any path on our host; a prefix
 *   check would accept `/api/auth/callback-evil`. The endpoint is a single
 *   known URL and equality is available, so equality is what is used.
 *
 * ⚠ A relative `to` is refused outright. It would resolve against whichever
 *   origin we happened to resolve it with, and the one meaningful relative
 *   value observed — `/` — is precisely the one that must not be followed.
 */
/**
 * Whether a URL we were handed is a specific endpoint of the provider's.
 *
 * ★ Named for the question rather than for one caller. It started life as
 *   `isAuthorizeEndpoint` and the second caller — sign-out, checking an
 *   end-session URL — made the name the narrower thing, not the function.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠⚠ WITHOUT THIS, THE SIGN-IN PAGE IS A FETCH-AND-REDIRECT ANYONE CAN AIM
 * ═══════════════════════════════════════════════════════════════════════════
 * The authorize URL reaches the panel through our own query string, so it
 * lands in the address bar and anybody can retype it. A page that fetches
 * whatever it is handed with `credentials: 'include'`, and then navigates to
 * whatever comes back, is a confused deputy wearing a sign-in screen.
 *
 * ★ So: ORIGIN AND PATHNAME, both exact. Not a prefix — that admits
 *   `/application/o/authorize-evil/`. Not the origin alone — that admits
 *   every other endpoint the provider has. The authorize endpoint is one
 *   known URL and equality is available, so equality is what is used.
 *
 * ★ This is the third guard of one shape, with `followableCompletion` and
 *   `recoveryFlowSlug`: **never compose a request from a string we were
 *   handed without checking it is the endpoint we meant.** Four defects of
 *   that class in this repository already.
 *
 * ⚠ The query string is NOT checked and must not be. It carries `state`, the
 *   PKCE challenge and the nonce, all minted by our own route this request —
 *   and the response's worth is decided later by `followableCompletion`,
 *   which requires the completion to be our registered callback.
 */
export function isProviderEndpoint(candidate: string, expectedEndpoint: string): boolean {
  let target: URL;
  let expected: URL;
  try {
    target = new URL(candidate);
    expected = new URL(expectedEndpoint);
  } catch {
    return false;
  }
  return target.origin === expected.origin && target.pathname === expected.pathname;
}

export function followableCompletion(to: string, expectedCallback: string): string | null {
  let target: URL;
  let expected: URL;
  try {
    // No base: a relative `to` throws here, which is the intent.
    target = new URL(to);
    expected = new URL(expectedCallback);
  } catch {
    return null;
  }

  if (target.origin !== expected.origin) return null;
  if (target.pathname !== expected.pathname) return null;

  /*
   * ⚠ AND IT MUST CARRY A CODE. A completion pointing at our callback with no
   *   code is not a sign-in — it is a redirect loop back into a route that
   *   will refuse it and send the person to `/sign-in?error=`, which looks
   *   like a failed password rather than a broken hop.
   */
  if (!target.searchParams.get('code') || !target.searchParams.get('state')) return null;

  return target.toString();
}

/**
 * What the panel should do next.
 *
 * `handOver` carries the reason so the fallback is explicable rather than a
 * shrug — and so a log line says which component we did not know.
 */
export type FlowStep =
  | { readonly kind: 'identify'; readonly challenge: IdentificationChallenge }
  /**
   * An identification stage that wants an identifier and no password — the
   * recovery flow's first screen. Reported rather than refused: whether it can
   * be rendered is the caller's question, not the contract's.
   */
  | { readonly kind: 'identifyOnly'; readonly challenge: IdentificationChallenge }
  | { readonly kind: 'staySignedIn'; readonly challenge: UserLoginChallenge }
  /**
   * A second factor is required. **Parsed, and deliberately not rendered** — the
   * submit shape is the one unknown, and a device picker that cannot submit is a
   * control that does nothing. The panel hands over on this, specifically.
   */
  | { readonly kind: 'chooseFactor'; readonly challenge: AuthenticatorValidateChallenge }
  /**
   * Sign-in succeeded. **There is nothing here to navigate to** — `idpPath` is
   * Authentik's own destination and the panel's next move is always our
   * `/api/auth/login`, which runs the OIDC exchange that gives us OUR session.
   * Carried for logging only, and named so that following it reads as a mistake.
   */
  | { readonly kind: 'done'; readonly idpPath: string }
  | { readonly kind: 'handOver'; readonly because: string };

/**
 * Read one challenge.
 *
 * ★ Never throws. A parse failure mid-sign-in must not be an exception on a
 *   screen where somebody has just typed a password: it is a reason to hand
 *   over to the identity provider's own page.
 *
 * ⚠ That handover used to be described here as one that "still works". It is
 *   the LEAST walked path in the flow — by definition, since it fires when the
 *   body is one we could not read. The single account of what it does, and of
 *   what about it is unobserved, is in `features/auth/SecondFactor.tsx`; three
 *   copies of that sentence went stale together and are not restated here.
 */
export function readChallenge(raw: unknown): FlowStep {
  const redirect = redirectChallengeSchema.safeParse(raw);
  if (redirect.success) return { kind: 'done', idpPath: redirect.data.to };

  const identify = identificationChallengeSchema.safeParse(raw);
  if (identify.success) {
    /*
     * ★★ AN IDENTIFIER WITHOUT A PASSWORD IS NOT 00a — WHICH IS NOT THE SAME
     *    AS "NOT OURS", AND THIS USED TO SAY IT WAS.
     *
     * `password_fields` is true on the authentication flow, which is what makes
     * 00a a single submit. This branch returned `handOver` on the reasoning
     * that a flow asking for them separately is no longer the design's
     * one-action screen — correct for sign-in, and **wrong as a universal
     * rule**.
     *
     * ⚠ The RECOVERY flow's first stage is this exact shape: the same
     *   `ak-stage-identification` component with `password_fields: false`,
     *   because asking for an email and no password is what recovery IS. So
     *   this line, not Authentik, is why "Forgot it?" landed on the provider's
     *   own UI — a guard of ours, enforcing a policy about one screen on every
     *   screen.
     *
     * ★ It now REPORTS the stage and lets the caller decide. `SignInPanel`
     *   hands over on `identifyOnly` exactly as before, so 00a's behaviour is
     *   unchanged; the recovery screen renders it.
     */
    if (!identify.data.password_fields) {
      return { kind: 'identifyOnly', challenge: identify.data };
    }
    return { kind: 'identify', challenge: identify.data };
  }

  const stay = userLoginChallengeSchema.safeParse(raw);
  if (stay.success) return { kind: 'staySignedIn', challenge: stay.data };

  const factor = authenticatorValidateChallengeSchema.safeParse(raw);
  if (factor.success) return { kind: 'chooseFactor', challenge: factor.data };

  const component =
    typeof raw === 'object' && raw !== null
      ? (raw as { component?: unknown }).component
      : undefined;
  return {
    kind: 'handOver',
    because: typeof component === 'string' && component !== '' ? component : 'unreadable',
  };
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ A CHALLENGE DOES NOT DESCRIBE ITS OWN INPUTS
 * ════════════════════════════════════════════════════════════════════════════
 * `ak-stage-user-login` returns four keys — `flow_info`, `component`,
 * `pending_user`, `pending_user_avatar` — and **requires a field none of them
 * mention.** Posting `{}` answers:
 *
 *     response_errors: { remember_me: [{ string: "This field is required." }] }
 *
 * So a renderer written from the challenge shape alone sends `{}` and is told at
 * runtime, by a user, that a field it has never heard of is missing.
 *
 * ★ The method generalises and is the only self-describing thing the executor
 *   offers: **post an empty body to a new stage and read `response_errors` — the
 *   errors are the field list.** Worth doing before writing any future renderer.
 *
 * ★★ AND IT MEANS THE CHECKBOX IS NOT DECORATIVE. The design's *"Keep me signed
 *   in on this device"* maps to this field; the flow refuses to complete without
 *   an answer. What it does NOT tell us is whether `false` shortens the session
 *   or what the configured length is — so **the copy must not say "30 days"**
 *   until somebody with admin access confirms it, on the same rule as the
 *   lockout number that is also not being written.
 */
export const REMEMBER_ME = 'remember_me';

/** The body that completes `ak-stage-user-login`. Measured, not inferred. */
export function staySignedInBody(remember: boolean): Record<string, boolean> {
  return { [REMEMBER_ME]: remember };
}

/**
 * The flow this application is bound to.
 *
 * Taken from the authorize endpoint's own redirect chain rather than from a
 * drive: `/application/o/authorize/` → `/flows/-/default/authentication/` →
 * `/if/flow/default-authentication-flow/`.
 *
 * ★ The middle hop is an ALIAS and is deliberately not used. It resolves to
 *   whatever the admin UI points it at, so building on it means our sign-in
 *   panel silently starts driving a different flow than the one the application
 *   authorises against.
 */
export const AUTHENTICATION_FLOW = 'default-authentication-flow';

/**
 * The recovery flow's slug, read out of the identification challenge's own
 * `recovery_url`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ NOT A CONSTANT, AND THE REASON IS ALREADY WRITTEN IN THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════
 * `recovery_url` carries the note "it is a flow slug an administrator can
 * change, and a stale path here sends somebody who has forgotten their
 * password to a 404". Hardcoding `gotcha-recovery-self` would contradict the
 * sentence sitting forty lines above it.
 *
 * ★ So the provider names its own recovery flow and we read the name. The
 *   observed value is `/if/flow/gotcha-recovery-self/`; this returns the slug
 *   between `/if/flow/` and the trailing slash, or `null` for anything that is
 *   not that shape.
 *
 * ⚠ THE RESULT IS USED TO DRIVE A FLOW, so the slug is checked rather than
 *   trusted: lowercase, digits and hyphens, bounded. That refuses path
 *   traversal and anything with a scheme or host in it. It does NOT pretend to
 *   be an authorisation check — the executor is the provider's own and a
 *   person can reach any flow of theirs by typing its URL. What this prevents
 *   is OUR code composing a request out of an arbitrary string.
 */
export function recoveryFlowSlug(recoveryUrl: string | null | undefined): string | null {
  if (typeof recoveryUrl !== 'string') return null;
  const match = /^\/if\/flow\/([a-z0-9][a-z0-9-]{0,63})\/?$/.exec(recoveryUrl);
  return match ? match[1]! : null;
}

/**
 * The sentence to show for a failed submit, or `null` when the stage reported
 * nothing.
 *
 * ★ `non_field_errors` FIRST, AND THAT IS THE POINT. Authentik deliberately does
 *   not say whether the email or the password was wrong — telling an attacker
 *   which half they got right is how an address list becomes an account list. We
 *   keep that property by preferring the non-field message and never attributing
 *   a failure to a field ourselves.
 */
export function firstError(errors: FlowErrors | undefined): string | null {
  if (!errors) return null;
  const nonField = errors[NON_FIELD]?.find((e) => e.string.trim() !== '');
  if (nonField) return nonField.string;
  for (const list of Object.values(errors)) {
    const found = list.find((e) => e.string.trim() !== '');
    if (found) return found.string;
  }
  return null;
}
