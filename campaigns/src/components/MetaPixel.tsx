'use client';

import { useEffect, useRef } from 'react';
import { useConsent } from '@/lib/consent';
import { META_PIXEL_ID } from '@/lib/site';

/**
 * The Meta pixel on a campaign page, loaded only after someone says yes.
 *
 * Modelled on landing/src/components/MetaPixel.tsx and deliberately NOT the
 * snippet Meta hands you, for the same reason: the Cookie Policy says, in both
 * languages, that "the pixel is not loaded at all until you turn it on -
 * refusing means the script is never requested, not that it is loaded and told
 * to stay quiet". A campaign host that loaded it on arrival would make that
 * sentence false for the one kind of visitor it was written about.
 *
 * The consent record is the SAME cookie the marketing site writes, shared
 * across `.gotcha.co.il`, so a visitor who already allowed advertising
 * measurement on gotcha.co.il is not asked again and their pixel loads here
 * immediately.
 *
 * TWO DIFFERENCES FROM THE MARKETING SITE'S COPY
 *
 * It does not wrap pushState. That exists there because the marketing site
 * switches 34 pages through the History API behind one document; a campaign is
 * one static page per URL and a navigation away from it is a real navigation.
 * Wrapping history here would be machinery guarding an event that cannot occur.
 *
 * It takes its id from `META_PIXEL_ID` rather than hard-coding one. The
 * marketing site has exactly one pixel and says so; a campaign may be measured
 * by a different ad account, and with no id supplied this renders nothing and
 * requests nothing.
 */

const SCRIPT_ID = 'meta-pixel';

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & {
      callMethod?: (...args: unknown[]) => void;
      queue?: unknown[];
      loaded?: boolean;
      version?: string;
      push?: unknown;
    };
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
  const allowed = consent?.marketing === true && !!META_PIXEL_ID;
  const started = useRef(false);

  useEffect(() => {
    if (!allowed || started.current) return;
    started.current = true;

    if (!document.getElementById(SCRIPT_ID)) {
      // The stub first, so the `init` and `PageView` below are queued rather
      // than dropped while fbevents.js is still in flight.
      installStub();
      const s = document.createElement('script');
      s.id = SCRIPT_ID;
      s.async = true;
      s.src = 'https://connect.facebook.net/en_US/fbevents.js';
      document.head.appendChild(s);
      window.fbq?.('init', META_PIXEL_ID);
    }

    window.fbq?.('track', 'PageView');
  }, [allowed]);

  return null;
}
