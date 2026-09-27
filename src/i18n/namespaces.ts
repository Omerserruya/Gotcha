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
 *   inbox            screen 02 had NO heading — a client component asking for
 *                    a nested namespace throws, so the page died outright and
 *                    twelve capture tests reported "is the app serving?"
 *   analytics        screen 06's two panels
 *   whatsappNumbers  screen 13's signup outcome sentence, resolved as a root
 *                    dotted key, so it rendered as nothing at all
 *
 * Every test over these files read the namespace list from the DIRECTORY, and
 * the unit tests handed components an imported catalogue directly — so a
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
  /** Inbox — screen 02. */
  'inbox',
  /** The notifications screen. */
  'notifications',
  /** Settings · Workspace — screen 11. */
  'workspace',
  /** Settings · People & teams — screen 12. */
  'people',
  /** Settings · Channels — screen 13. */
  'channels',
  /**
   * Settings · Channels · the Embedded Signup outcome sentences — screen 13.
   *
   * ★ CAMEL CASE, UNLIKE EVERY OTHER NAME HERE, because
   * `whatsapp-signup-flow.ts` emits fully-qualified keys
   * (`'whatsappNumbers.outcome.noCandidates'`) that are resolved from the root
   * of the merged catalogue. The first segment of those strings IS this name,
   * so renaming the file renames the keys.
   */
  'whatsappNumbers',
  /** Settings · Business systems — screen 14. */
  'systems',
  /** Settings · Security — screen 16. */
  'security',
  'studio',
  /** Settings · Usage & billing — screen 17. */
  'billing',
  /** Settings · Notifications — screen 15. Not `notifications`, which is 01d. */
  'notifications-settings',
  /** Approvals — screen 03, with 03b and 03c. */
  'approvals',
  /** Customers — screen 04. */
  'customers',
  /** Outreach — screens 05 and 05b. */
  'outreach',
  /** Outreach · templates — screen 05c. */
  'templates',
  /** Outreach · calls — screens 05d and 05e. */
  'calls',
  /** Analytics — screen 06, with 06b, 06c and 06e's panel. */
  'analytics',
  /** Studio · employees — screen 07. */
  'employees',
  /** Studio · knowledge — screen 08. */
  'knowledge',
  /** Studio · automations — screen 09. */
  'automations',
  /** Studio · capabilities — screen 10. */
  'capabilities',
  /** Settings · People & teams · Roles — screen 12b. */
  'roles',
] as const;

export type Namespace = (typeof NAMESPACES)[number];
