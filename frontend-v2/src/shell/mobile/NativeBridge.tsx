'use client';

import { useEffect, useRef } from 'react';

import { z } from 'zod';

import { browserApi } from '@/api/client/browser-api';
import { inboxEndpoints } from '@/api/endpoints/registry';
import { useRouter } from '@/i18n/navigation';
import { requestBack } from '@/lib/back-request';

import { outsideUrl, signedFileOf } from './link-policy';
import { mobileLinkFrom } from './mobile-paths';
import {
  appPlugin,
  browserPlugin,
  documentPlugin,
  nativePlatform,
  pushPlugin,
  storePushToken,
  storedPushToken,
  type PushAction,
} from './native';
import { registerPushDevice } from './push-actions';

/** `media-link`'s answer, unwrapped: only the path is used. */
const mediaLinkSchema = z.object({ url: z.string().startsWith('/api/media/s/') });

/**
 * What only the app does: push, and leaving the app for the website.
 *
 * Renders nothing, and in a browser does nothing at all (`nativePlatform()`
 * is null there), so the phone's browser and the app share every screen.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ PERMISSION IS ASKED ON THE FIRST START, ONCE
 * ════════════════════════════════════════════════════════════════════════════
 * An agent installs this app to be told when a customer writes; asking later,
 * behind a setting, is asking after the first message was missed. iOS shows
 * its prompt once per install whatever we do, so asking again on a refusal is
 * a no-op there, and the bridge does not try.
 *
 * ★★ REGISTERED ON EVERY START, NOT ONCE
 * The token can rotate, and the phone can now belong to somebody else's
 * session. The platform's registration is an upsert by token, so repeating it
 * is how both are corrected.
 */
export function NativeBridge() {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    const platform = nativePlatform();
    const push = pushPlugin();
    if (platform === null || push === null) return;

    let cancelled = false;
    const listeners: { remove(): Promise<void> | void }[] = [];

    const openFrom = (action: PushAction) => {
      const link = mobileLinkFrom(action.notification.data?.link);
      // `/m/inbox/<id>` and friends only; the locale is the router's.
      if (link !== null) routerRef.current.push(link as '/m/inbox');
    };

    void (async () => {
      listeners.push(
        await push.addListener('registration', (token) => {
          storePushToken(token.value);
          void registerPushDevice(token.value, platform);
        }),
        await push.addListener('registrationError', () => {
          // Nothing to show: the screens work without push, and the next start retries.
        }),
        await push.addListener('pushNotificationActionPerformed', openFrom),
      );
      if (cancelled) return;
      let state = (await push.checkPermissions()).receive;
      if (state === 'prompt' || state === 'prompt-with-rationale') {
        state = (await push.requestPermissions()).receive;
      }
      if (!cancelled && state === 'granted') await push.register();
    })().catch(() => undefined);

    return () => {
      cancelled = true;
      for (const listener of listeners) void listener.remove();
    };
  }, []);

  /*
   * ★ ANDROID'S BACK BUTTON CLOSES WHAT IS OPEN FIRST (supervisor, 2026-11-04):
   *   the photo viewer. Listening replaces Capacitor's own Back, so with
   *   nothing open this does what it did - back a page, or leave the app on
   *   the first one.
   */
  /*
   * ★ ANDROID ONLY, AND NEVER `.then` ON WHAT addListener RETURNS: on iOS the
   *   bridge hands back the listener itself, not a promise, so `.then` threw
   *   inside this effect and the whole inbox fell to the error page (Omer,
   *   2026-11-05). iPhones have no Back button anyway.
   */
  useEffect(() => {
    const app = appPlugin();
    if (app === null || nativePlatform() !== 'android') return;
    let handle: { remove(): void | Promise<void> } | null = null;
    let cancelled = false;
    void Promise.resolve()
      .then(() =>
        app.addListener('backButton', ({ canGoBack }) => {
          if (requestBack()) return;
          if (canGoBack) window.history.back();
          else void app.exitApp();
        }),
      )
      .then((listener) => {
        if (cancelled) void listener.remove();
        else handle = listener;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, []);

  /*
   * ════════════════════════════════════════════════════════════════════════
   * ★★ A LINK OUT OF THE APP OPENS THE WEBSITE, NOT A DESKTOP PAGE IN A PHONE
   * ════════════════════════════════════════════════════════════════════════
   * Settings, Studio, a customer's own link in a message: inside the app they
   * would load the desktop frame in a 390px WebView with no way back. In the
   * system browser they are the website, signed in there separately, and the
   * app is still where it was when the person comes back.
   */
  useEffect(() => {
    if (nativePlatform() === null) return;
    const browser = browserPlugin();
    if (browser === null) return;

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      /*
       * ★ A document (a PDF) opens in the phone's own viewer, which has no
       *   GOTCHA login: the logged-in URL answered 401 (Omer, 2026-11-04).
       *   So it goes out as a five-minute signed link.
       */
      const file = signedFileOf(anchor);
      if (file !== null) {
        event.preventDefault();
        const fallback = anchor.href;
        const fileName = anchor.getAttribute('download') || 'document';
        void browserApi
          .get({
            endpoint: inboxEndpoints.mediaLink(file.conversationId, file.messageId),
            payload: mediaLinkSchema,
          })
          .then(async (link) => {
            const signed = new URL(link.url, window.location.origin).href;
            /*
             * ★ In the phone's own viewer, not the browser, which only
             *   downloaded it (Omer, 2026-11-04). An older app, or no viewer
             *   for the type: the browser, as before.
             */
            const viewer = documentPlugin();
            if (viewer !== null) {
              try {
                await viewer.openDocument({ url: signed, fileName });
                return;
              } catch {
                // fall through to the browser
              }
            }
            await browser.open({ url: signed });
          })
          .catch(() => browser.open({ url: fallback }));
        return;
      }
      const outside = outsideUrl(anchor, window.location);
      if (outside === null) return;
      event.preventDefault();
      void browser.open({ url: outside });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  return null;
}

/** For sign-out: the token this phone registered, if any. */
export { storedPushToken };
