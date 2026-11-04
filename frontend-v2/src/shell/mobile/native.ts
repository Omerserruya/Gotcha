/**
 * The native shell, as the page sees it.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ READ FROM THE BRIDGE, NOT IMPORTED: THE WEBSITE HAS NO CAPACITOR PACKAGE
 * ════════════════════════════════════════════════════════════════════════════
 * The app loads this site remotely, and Capacitor injects `window.Capacitor`
 * into it with the plugins the shell was built with (`mobile/`). In a normal
 * browser there is no bridge and every function here answers "not native",
 * so the same page serves the phone's browser and the app.
 *
 * Only the few calls the page makes are typed, and every one is optional: a
 * shell built without a plugin is a shell without that feature, not a crash.
 */

export interface PushToken {
  readonly value: string;
}

export interface PushAction {
  readonly notification: { readonly data?: Record<string, unknown> };
}

interface Listener {
  remove(): Promise<void> | void;
}

interface PushNotificationsPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(event: 'registration', fn: (token: PushToken) => void): Promise<Listener>;
  addListener(event: 'registrationError', fn: (error: unknown) => void): Promise<Listener>;
  addListener(
    event: 'pushNotificationActionPerformed',
    fn: (action: PushAction) => void,
  ): Promise<Listener>;
  removeAllDeliveredNotifications?(): Promise<void>;
}

interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
}

/** The app's own plugin (NavigationPolicyPlugin.java): a document in the phone's viewer. */
interface DocumentPlugin {
  openDocument(options: { url: string; fileName: string }): Promise<{ opened: boolean }>;
}

interface CapacitorGlobal {
  isNativePlatform?(): boolean;
  getPlatform?(): string;
  Plugins?: {
    PushNotifications?: PushNotificationsPlugin;
    Browser?: BrowserPlugin;
    NavigationPolicy?: Partial<DocumentPlugin>;
  };
}

function capacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  const found = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return found?.isNativePlatform?.() === true ? found : null;
}

/** `ios` / `android` inside the app, `null` in any browser. */
export function nativePlatform(): 'ios' | 'android' | null {
  const platform = capacitor()?.getPlatform?.();
  return platform === 'ios' || platform === 'android' ? platform : null;
}

export function pushPlugin(): PushNotificationsPlugin | null {
  return capacitor()?.Plugins?.PushNotifications ?? null;
}

export function browserPlugin(): BrowserPlugin | null {
  return capacitor()?.Plugins?.Browser ?? null;
}

/**
 * The phone's document viewer, or `null`. An app built before 2026-11-04 has
 * the plugin without `openDocument`: then `null`, and the caller uses the
 * browser as before.
 */
export function documentPlugin(): DocumentPlugin | null {
  const plugin = capacitor()?.Plugins?.NavigationPolicy;
  return typeof plugin?.openDocument === 'function' ? (plugin as DocumentPlugin) : null;
}

/** Where this phone's token is kept between starts, so sign-out can forget it. */
export const PUSH_TOKEN_KEY = 'gotcha:push-token';

export function storedPushToken(): string | null {
  try {
    return window.localStorage.getItem(PUSH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storePushToken(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(PUSH_TOKEN_KEY);
    else window.localStorage.setItem(PUSH_TOKEN_KEY, token);
  } catch {
    // Private storage refused: sign-out cannot forget this phone, the platform's
    // own clean-up of dead tokens still applies.
  }
}
