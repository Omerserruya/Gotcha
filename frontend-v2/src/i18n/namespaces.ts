/**
 * Translation namespaces.
 *
 * One file per namespace per locale, so a feature owns its strings and two
 * features cannot collide on a key. Product features add their own namespace
 * here when they are built; the foundation ships the cross-cutting ones.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ THIS LIST IS WHAT LOADS. A FILE ABSENT FROM IT DOES NOT EXIST AT RUNTIME.
 * ════════════════════════════════════════════════════════════════════════════
 * `loadMessages` maps over this array, not over the directory. Three complete,
 * both-locale, key-for-key-matching catalogues were missing from it and none
 * of them loaded:
 *
 *   inbox            screen 02 had NO heading - a client component asking for
 *                    a nested namespace throws, so the page died outright and
 *                    twelve capture tests reported "is the app serving?"
 *   analytics        screen 06's two panels
 *   whatsappNumbers  screen 13's signup outcome sentence, resolved as a root
 *                    dotted key, so it rendered as nothing at all
 *
 * Every test over these files read the namespace list from the DIRECTORY, and
 * the unit tests handed components an imported catalogue directly - so a
 * complete file that never loaded passed all of them. `messages.test.ts` now
 * compares this list against the directory in both directions.
 */
export const NAMESPACES = [
  'business-core',
  /** Shared vocabulary: save, cancel, close, retry. */
  'common',
  /** Navigation and shell chrome. */
  'navigation',
  /** Error surfaces, by failure kind. */
  'errors',
  /** Sign-in, sign-out, session expiry. */
  'auth',
  /** Capability explanations: why an action is unavailable. */
  'permissions',
  /** Form validation messages. */
  'validation',
  /** Labels read only by assistive technology. */
  'a11y',
  /** The Home screen. */
  'home',
  /** Inbox - screen 02. */
  'inbox',
  /** The notifications screen. */
  'notifications',
  /** Settings · Workspace - screen 11. */
  'workspace',
  /** Settings · People & teams - screen 12. */
  'people',
  /** Settings · Channels - screen 13. */
  'channels',
  /**
   * Settings · Channels · the Embedded Signup outcome sentences - screen 13.
   *
   * ★ CAMEL CASE, UNLIKE EVERY OTHER NAME HERE, because
   * `whatsapp-signup-flow.ts` emits fully-qualified keys
   * (`'whatsappNumbers.outcome.noCandidates'`) that are resolved from the root
   * of the merged catalogue. The first segment of those strings IS this name,
   * so renaming the file renames the keys.
   */
  'whatsappNumbers',
  /** Settings · Business systems - screen 14. */
  'systems',
  /** Settings · Security - screen 16. */
  'security',
  'studio',
  /** Settings · Usage & billing - screen 17. */
  'billing',
  /** Settings · Developer - screen 18. */
  'developer',
  /** Settings · Notifications - screen 15. Not `notifications`, which is 01d. */
  'notifications-settings',
  /** Approvals - screen 03, with 03b and 03c. */
  'approvals',
  /** Customers - screen 04. */
  'customers',
  /** Outreach - screens 05 and 05b. */
  'outreach',
  /** Outreach · templates - screen 05c. */
  'templates',
  /** Outreach · calls - screens 05d and 05e. */
  'calls',
  /** Analytics - screen 06, with 06b, 06c and 06e's panel. */
  'analytics',
  /** Studio · employees - screen 07. */
  'employees',
  /** Studio · knowledge - screen 08. */
  'knowledge',
  /** Studio · skills - screens 09, 09b, 21 (design 6). */
  'skills',
  /** Onboarding after the workspace exists - screens 00d-00h (design 6). */
  'onboarding',
  /** Studio · automations - screen 09c (design 6; 09 before it). */
  'automations',
  /** Studio · capabilities - screen 10. */
  'capabilities',
  /** Settings · People & teams · Roles - screen 12b. */
  'roles',
  /** The customer checkout (/checkout/*), signed in or out. */
  'checkout',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/**
 * What the pre-authentication surface loads into the browser.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE SIGN-IN PAGE WAS SHIPPING THE ENTIRE PRODUCT'S VOCABULARY
 * ════════════════════════════════════════════════════════════════════════════
 * `NextIntlClientProvider` with no `messages` serialises **everything in the
 * request config** into the client payload. Measured on the deployed page:
 * 143,757 bytes of HTML, 1,097 message-shaped strings, and among them -
 * on a page nobody has authenticated to reach -
 *
 *     "Approvals" x5   "Studio" x6   "Analytics" x2
 *     "conversation" x121   "refund" x20   "Shopify" x4
 *
 * including *"…in your Approvals queue, because merging the wrong two
 * customers cannot be undone."* Feature names, warnings and limits, readable
 * by anyone who opens the page.
 *
 * ★ A GATEWAY ALLOWLIST CANNOT TOUCH THIS. It restricts which routes answer;
 *   this is not another route, it is *this* route's payload. Serving sign-in
 *   from an origin meant to exclude the product, while the page carries the
 *   product's copy, gets the address right and the contents wrong.
 *
 * ── WHY THESE TWO AND NOT A COMFORTABLE MARGIN ──
 * Every `useTranslations` / `getTranslations` call reachable from the auth
 * surface asks for `auth` (the panel) or `errors` (the design system's state
 * displays, and the route error boundary, which is a client component). That
 * is measured by `namespaces.test.ts`, which reads the call sites rather than
 * trusting this comment - because a list that drifts from its callers renders
 * a blank string, and a blank string on a sign-in screen is indistinguishable
 * from a page that simply says less.
 */
export const CREDENTIAL_SURFACE_NAMESPACES = [
  'auth',
  'errors',
] as const satisfies readonly Namespace[];

/**
 * What the route error boundary needs, above both groups.
 *
 * `error.tsx` is a client component by Next's requirement and lives at the
 * locale root, outside `(app)` and `(auth)` alike, so something must provide
 * its namespace before either group's layout runs.
 */
/**
 * What the checkout pages load into the browser: their own copy and the
 * error boundary's. They are reached signed out from an emailed link, so -
 * like sign-in - they carry none of the product's vocabulary.
 */
export const CHECKOUT_NAMESPACES = ['checkout', 'errors'] as const satisfies readonly Namespace[];

export const SHELL_NAMESPACES = ['errors'] as const satisfies readonly Namespace[];
