'use client';

import { useEffect, useRef } from 'react';
import { useConsent } from '@/lib/consent';

/**
 * The Meta pixel, loaded only after someone says yes.
 *
 * Three things about this site make the snippet Meta hands you wrong here.
 *
 * It cannot load on arrival. The cookie notice asks before anything
 * non-essential runs, and the Cookie Policy says so in both languages. So the
 * script is injected when `consent.marketing` turns true and never before -
 * not hidden behind `fbq('consent', 'revoke')`, which still downloads the
 * script and still lets Meta see the request.
 *
 * It cannot fire PageView once. The landing switches all 34 of its pages
 * through pushState, so a visitor who reads four pages sends one PageView and
 * three nothings. Every address change sends another.
 *
 * And it cannot be undone by unloading. There is no way to un-ring that bell in
 * the browser, so turning the switch back off stops further events and the
 * cookies are cleared by the browser controls the policy points at. A reload
 * after revoking is a page with no pixel on it at all.
 */

/** From Meta Events Manager. Public by nature - it is in the page either way. */
const PIXEL_ID = '1366778975443279';

const SCRIPT_ID = 'meta-pixel';

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void; queue?: unknown[]; loaded?: boolean; version?: string; push?: unknown };
    _fbq?: unknown;
  }
}

/** Meta's own bootstrap, with the queue that buffers calls made before it loads. */
function installStub() {
  if (window.fbq) return;
  const n: any = function (...args: unknown[]) {
    n.callMethod ? n.callMethod.apply(n, args) : n.queue.push(args);
  };
  n.push = n;
  n.loaded = true;
  n.version = '2.0';
  n.queue = [];
  window.fbq = n;
  window._fbq = n;
}

export default function MetaPixel() {
  const { consent } = useConsent();
  const allowed = consent?.marketing === true;

  // The address the pixel has already reported, so a re-render is not a page view.
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (!allowed) return;

    if (!document.getElementById(SCRIPT_ID)) {
      installStub();
      const s = document.createElement('script');
      s.id = SCRIPT_ID;
      s.async = true;
      s.src = 'https://connect.facebook.net/en_US/fbevents.js';
      document.head.appendChild(s);
      window.fbq?.('init', PIXEL_ID);
    }

    const send = () => {
      const here = window.location.pathname + window.location.search;
      if (here === reported.current) return;
      reported.current = here;
      window.fbq?.('track', 'PageView');
    };

    send();

    // The design navigates with pushState, which fires no event of its own, so
    // the two history methods are wrapped. popstate covers Back and Forward.
    const wrap = (name: 'pushState' | 'replaceState') => {
      const original = history[name];
      const patched = function (this: History, ...args: Parameters<History['pushState']>) {
        const out = original.apply(this, args);
        send();
        return out;
      };
      history[name] = patched as History[typeof name];
      return () => { history[name] = original; };
    };

    const undo = [wrap('pushState'), wrap('replaceState')];
    window.addEventListener('popstate', send);

    return () => {
      undo.forEach((f) => f());
      window.removeEventListener('popstate', send);
    };
  }, [allowed]);

  return null;
}
