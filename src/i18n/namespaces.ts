/**
 * Translation namespaces.
 *
 * One file per namespace per locale, so a feature owns its strings and two
 * features cannot collide on a key. Product features add their own namespace
 * here when they are built; the foundation ships the cross-cutting ones.
 */
export const NAMESPACES = [
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
  /** The notifications screen. */
  'notifications',
] as const;

export type Namespace = (typeof NAMESPACES)[number];
