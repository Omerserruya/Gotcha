'use client';

import { redeemAppSignIn } from '@/api/client/app-sign-in';
import { appPath } from '@/lib/base-path';

import { appPlugin, authPlugin, browserPlugin, hasNativeMethod, nativePlatform } from './native';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ "CONTINUE WITH GOOGLE" INSIDE THE APP (Omer, 2026-11-24)
 * ════════════════════════════════════════════════════════════════════════════
 * Google refuses an embedded WebView, so the sign-in runs in the phone's own
 * auth browser and comes back on the app's scheme with a code the WebView
 * trades for the session (the server's side: `auth/app-handoff.ts`).
 *
 *   iPhone   NavigationPolicy.authenticate - ASWebAuthenticationSession,
 *            ephemeral (no Safari cookies), which itself catches gotcha://.
 *   Android  @capacitor/browser (Custom Tabs) out, @capacitor/app's
 *            appUrlOpen back: gotcha:// is the app's own intent filter.
 *
 * ★ Only in a build that registered it (Capacitor's PluginHeaders): iOS
 *   `authenticate`, Android the `appGoogleSignIn` marker. The store and
 *   closed-test builds before them show no Google at all (the Supervisor,
 *   2026-11-24: nothing changes for real users until walked on a phone).
 * ★ The verifier stays in this function: only its S256 leaves the app.
 */

export type AppGoogleOutcome = 'signed_in' | 'cancelled' | 'failed';

const RETURN_PREFIX = 'gotcha://auth/done';
/** After the tab closes, how long a late appUrlOpen may still arrive. */
const LATE_RETURN_MS = 1500;

export function appGoogleAvailable(): boolean {
  const platform = nativePlatform();
  if (platform === 'ios') return authPlugin() !== null;
  if (platform === 'android') {
    // A build that carries the marker (NavigationPolicyPlugin.java): never the
    // store or closed-test builds before it was walked on a phone.
    if (!hasNativeMethod('NavigationPolicy', 'appGoogleSignIn')) return false;
    const browser = browserPlugin();
    return (
      browser !== null &&
      typeof browser.addListener === 'function' &&
      typeof appPlugin()?.addListener === 'function'
    );
  }
  return false;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function makeVerifier(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** The code on gotcha://auth/done?code=…, or `null` for any other URL. */
export function codeFrom(url: string): string | null {
  if (!url.startsWith(RETURN_PREFIX)) return null;
  try {
    return new URL(url).searchParams.get('code');
  } catch {
    return null;
  }
}

/** The auth browser's answer: the return URL, or `null` when the person closed it. */
async function iosTrip(url: string): Promise<string | null> {
  const plugin = authPlugin();
  if (!plugin) throw new Error('unavailable');
  try {
    return (await plugin.authenticate({ url, callbackScheme: 'gotcha' })).url;
  } catch (cause) {
    if (cause instanceof Error && /cancel/i.test(cause.message)) return null;
    throw cause;
  }
}

function androidTrip(url: string): Promise<string | null> {
  const browser = browserPlugin();
  const app = appPlugin();
  if (!browser?.addListener || !app) return Promise.reject(new Error('unavailable'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const listeners: { remove(): Promise<void> | void }[] = [];
    let late: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (late) clearTimeout(late);
      for (const listener of listeners) void listener.remove();
      resolve(value);
    };
    void (async () => {
      listeners.push(
        await app.addListener('appUrlOpen', (event) => {
          if (!event.url.startsWith(RETURN_PREFIX)) return;
          finish(event.url);
          void browser.close?.().catch(() => undefined);
        }),
      );
      listeners.push(
        await browser.addListener!('browserFinished', () => {
          // The tab closes as the app comes back: give the return a moment.
          late = setTimeout(() => finish(null), LATE_RETURN_MS);
        }),
      );
      await browser.open({ url });
    })().catch((cause: unknown) => {
      if (settled) return;
      settled = true;
      for (const listener of listeners) void listener.remove();
      reject(cause);
    });
  });
}

/**
 * The whole trip: out to Google, back with a code, the code traded for the
 * session inside the WebView. `signed_in` means the cookies are set; the
 * caller goes on to the app.
 */
export async function signInWithGoogleInApp(locale: string): Promise<AppGoogleOutcome> {
  try {
    const { verifier, challenge } = await makeVerifier();
    const start = new URL(appPath('/api/bff/app-sign-in/start'), window.location.origin);
    start.searchParams.set('challenge', challenge);
    start.searchParams.set('locale', locale);

    const back =
      nativePlatform() === 'ios'
        ? await iosTrip(start.toString())
        : await androidTrip(start.toString());
    if (back === null) return 'cancelled';
    const code = codeFrom(back);
    if (!code) return 'failed';

    return (await redeemAppSignIn(code, verifier)) ? 'signed_in' : 'failed';
  } catch {
    return 'failed';
  }
}
