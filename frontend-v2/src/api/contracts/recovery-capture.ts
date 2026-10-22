/**
 * Backend's capture of the recovery flows on dev, 2026-10-22 (Authentik
 * 2026.2.7, through /auth-api/ on the app host - this screen's own path).
 * Verbatim but for the one-time consent token. Tests only: a fixture is a
 * claim the platform produces this, and these were produced.
 *
 * Not captured, because it would change a real password: what follows a
 * valid submit (user_login, then the flow's redirect) - inferred from the
 * stage code by Backend.
 */
const field = (key: 'password' | 'password_repeat', label: string, order: number) => ({
  field_key: key,
  label,
  type: 'password',
  required: true,
  placeholder: label,
  initial_value: '',
  order,
  sub_text: '',
  choices: null,
});
const FIELDS = [
  field('password', 'Password', 300),
  field('password_repeat', 'Password (repeat)', 301),
];

export const CAPTURED = {
  /** A reset link (gotcha-recovery-self), first GET with its token. */
  consent: {
    component: 'ak-stage-consent',
    pending_user: 'gotcha.dev.test@gmail.com',
    header_text: 'Continue to confirm this email address.',
    permissions: [],
    additional_permissions: [],
    token: 'consent-token-1',
  },
  /** After consent; and an invite's (gotcha-recovery) FIRST challenge. */
  prompt: { component: 'ak-stage-prompt', fields: FIELDS },
  promptRules: {
    component: 'ak-stage-prompt',
    response_errors: {
      non_field_errors: [
        {
          string:
            'Password must be at least 12 characters with upper and lower case letters, a number, and a symbol, and must not appear in a known breach.',
          code: 'invalid',
        },
      ],
    },
    fields: FIELDS,
  },
  promptBreached: {
    component: 'ak-stage-prompt',
    response_errors: {
      non_field_errors: [{ string: 'Password exists on 295389 online lists.', code: 'invalid' }],
    },
    fields: FIELDS,
  },
  promptMismatch: {
    component: 'ak-stage-prompt',
    response_errors: { non_field_errors: [{ string: "Passwords don't match.", code: 'invalid' }] },
    fields: FIELDS,
  },
  promptWeak: {
    component: 'ak-stage-prompt',
    response_errors: {
      non_field_errors: [
        { string: 'Password is too weak.', code: 'invalid' },
        { string: 'Add another word or two. Uncommon words are better.', code: 'invalid' },
      ],
    },
    fields: FIELDS,
  },
  promptEmpty: {
    component: 'ak-stage-prompt',
    response_errors: {
      password: [{ string: 'This field is required.', code: 'required' }],
      password_repeat: [{ string: 'This field is required.', code: 'required' }],
    },
    fields: FIELDS,
  },
  /** A reset link whose token is spent, expired or unknown: the flow restarts. */
  identification: {
    component: 'ak-stage-identification',
    user_fields: ['email', 'username'],
    pending_user_identifier: null,
    password_fields: false,
    allow_show_password: false,
    flow_designation: 'recovery',
    captcha_stage: null,
    primary_action: 'Continue',
    sources: [],
    show_source_labels: false,
    enable_remember_me: false,
    passkey_challenge: null,
  },
  /** An invite whose token is dead, found out only on submit. */
  accessDenied: {
    component: 'ak-stage-access-denied',
    pending_user: '',
    error_message: "No user found and can't create new user.",
  },
  /** INFERRED (not captured): after a valid submit. */
  userLogin: { component: 'ak-stage-user-login', pending_user: '' },
  redirect: { component: 'xak-flow-redirect', to: '/' },
} as const;
