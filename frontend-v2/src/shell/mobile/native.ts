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

/*
 * ★ addListener answers a promise on Android and the listener itself on iOS
 *   (its bridge's legacy plugin object). Never call `.then` on it: `await`
 *   it, or wrap it in Promise.resolve.
 */
interface PushNotificationsPlugin {
  checkPermissions(): Promise<{ receive: string }>;
  requestPermissions(): Promise<{ receive: string }>;
  register(): Promise<void>;
  addListener(event: 'registration', fn: (token: PushToken) => void): Promise<Listener> | Listener;
  addListener(
    event: 'registrationError',
    fn: (error: unknown) => void,
  ): Promise<Listener> | Listener;
  addListener(
    event: 'pushNotificationActionPerformed',
    fn: (action: PushAction) => void,
  ): Promise<Listener> | Listener;
  removeAllDeliveredNotifications?(): Promise<void>;
}

interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
  close?(): Promise<void>;
  addListener?(event: 'browserFinished', fn: () => void): Promise<Listener> | Listener;
}

/** @capacitor/app: the Android Back button. */
interface AppPlugin {
  addListener(
    event: 'backButton',
    fn: (event: { readonly canGoBack: boolean }) => void,
  ): Promise<Listener> | Listener;
  exitApp(): Promise<void>;
  addListener(
    event: 'appUrlOpen',
    fn: (event: { readonly url: string }) => void,
  ): Promise<Listener> | Listener;
}

/** The app's own plugin (NavigationPolicyPlugin.java): a document in the phone's viewer. */
interface DocumentPlugin {
  openDocument(options: { url: string; fileName: string }): Promise<{ opened: boolean }>;
}

/** The app's own plugin (NavigationPolicyPlugin.swift): the iPhone's auth browser. */
interface AuthPlugin {
  authenticate(options: { url: string; callbackScheme: string }): Promise<{ url: string }>;
}

/** What the native side registered: each plugin's REAL methods (Capacitor's JSExport). */
interface PluginHeader {
  readonly name: string;
  readonly methods?: readonly { readonly name: string }[];
}

interface CapacitorGlobal {
  isNativePlatform?(): boolean;
  getPlatform?(): string;
  PluginHeaders?: readonly PluginHeader[];
  Plugins?: {
    PushNotifications?: PushNotificationsPlugin;
    Browser?: BrowserPlugin;
    NavigationPolicy?: Partial<DocumentPlugin & AuthPlugin>;
    App?: AppPlugin;
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

export function appPlugin(): AppPlugin | null {
  return capacitor()?.Plugins?.App ?? null;
}

export function browserPlugin(): BrowserPlugin | null {
  return capacitor()?.Plugins?.Browser ?? null;
}

/**
 * The phone's document viewer, or `null` outside the app.
 *
 * ⚠ Not a feature check. Capacitor's plugin proxy answers with a function for
 *   any method name, so an app built before 2026-11-04 (no `openDocument` in
 *   Java) gets one too, and its call rejects. The caller treats a rejection
 *   as "use the browser", which is what such an app did before.
 */
export function documentPlugin(): DocumentPlugin | null {
  const plugin = capacitor()?.Plugins?.NavigationPolicy;
  return typeof plugin?.openDocument === 'function' ? (plugin as DocumentPlugin) : null;
}

/**
 * Whether THIS build's native side has the method. Unlike the plugin proxy
 * (which answers for any name, see `documentPlugin`), the headers list only
 * what the native code registered - so an app from the store before a method
 * shipped says no, and its page can leave the feature out.
 */
export function hasNativeMethod(plugin: string, method: string): boolean {
  const header = capacitor()?.PluginHeaders?.find((h) => h.name === plugin);
  return header?.methods?.some((m) => m.name === method) === true;
}

/** The iPhone's auth browser, or `null`: not an iPhone, or a build without it. */
export function authPlugin(): AuthPlugin | null {
  if (nativePlatform() !== 'ios' || !hasNativeMethod('NavigationPolicy', 'authenticate')) {
    return null;
  }
  return (capacitor()?.Plugins?.NavigationPolicy as AuthPlugin | undefined) ?? null;
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
