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
 * What the panel should do next.
 *
 * `handOver` carries the reason so the fallback is explicable rather than a
 * shrug — and so a log line says which component we did not know.
 */
export type FlowStep =
  | { readonly kind: 'identify'; readonly challenge: IdentificationChallenge }
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
 *   screen where somebody has just typed a password: it is a reason to hand over
 *   to the identity provider's own page, which still works.
 */
export function readChallenge(raw: unknown): FlowStep {
  const redirect = redirectChallengeSchema.safeParse(raw);
  if (redirect.success) return { kind: 'done', idpPath: redirect.data.to };

  const identify = identificationChallengeSchema.safeParse(raw);
  if (identify.success) {
    /*
     * ★★ A STAGE THAT WANTS AN IDENTIFIER AND NOT A PASSWORD IS NOT OUR PANEL.
     * `password_fields` is true on this tenant, which is what makes 00a a single
     * submit. If a flow is reconfigured to ask for them separately, the design's
     * one-action screen is no longer what the flow does, and rendering a
     * password box that the stage will reject is worse than handing over.
     */
    if (!identify.data.password_fields) {
      return { kind: 'handOver', because: 'identification-without-password' };
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
