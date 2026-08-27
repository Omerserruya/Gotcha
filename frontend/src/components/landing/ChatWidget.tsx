"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { rendersMarketing } from "@/lib/marketing-origin";
import { isUnder, samePath, useAppPathname } from "@/lib/pathname";

/**
 * The embedded chat widget, for the MARKETING CONTENT pages only.
 *
 * Two questions decide whether the launcher is on screen, and they are not the
 * same question:
 *
 *  1. Is this the marketing HOST? One static export is served under two
 *     hostnames, so that cannot be answered at build time - it comes from the
 *     origin the browser actually loaded. rendersMarketing() is the same test
 *     `/` uses to decide landing page vs application root, and it fails OPEN:
 *     unset (dev, single-host) means the widget still shows, so we can see it
 *     locally. On app.gotcha.co.il it is false and nothing is injected.
 *
 *  2. Is this a marketing page a visitor is READING? The landing page, pricing
 *     and the Trust Center are: someone browsing them may well want to ask
 *     something. /early-access is not - it is a form, and the launcher is fixed
 *     to the bottom corner where the form's own Next/Submit button lives. It
 *     covered the button outright, so the widget we put there to help people
 *     get started was stopping them from getting started.
 *
 * Question 2 has to keep being asked after the first answer. This is a single
 * page app: clicking "Get Early Access" from the landing page never reloads, so
 * a widget already on screen simply stays there. The loader script also refuses
 * to run twice (`window.__gotchaWebchatLoaded`), and the widget it mounts has no
 * teardown call - it is a script pasted on customer sites that we cannot change
 * from here. So the launcher is loaded once and then SHOWN or HIDDEN by path,
 * via a rule on the host element the loader appends to <body>.
 */

/**
 * Marketing pages the launcher belongs on.
 *
 * "/" is listed as an exact match, not a prefix - isUnder("/anything", "/") is
 * true, which would put the widget on every page in the product.
 */
const CHAT_ROOTS = ["/en", "/he", "/pricing", "/legal"];

export function chatWidgetAllowed(pathname: string | null | undefined): boolean {
  return samePath(pathname, "/") || CHAT_ROOTS.some((p) => isUnder(pathname, p));
}

/**
 * The loader mounts `#gotcha-chat-root` on <body>, outside React's tree, so it
 * is hidden with a stylesheet rule rather than by unmounting anything. A class
 * on <html> also works no matter WHEN the widget finishes mounting - it is
 * async, and on a fast click-through it lands after the route already changed.
 */
const HIDE_CLASS = "gotcha-chat-hidden";
const HIDE_STYLE_ID = "gotcha-chat-visibility";
const HIDE_CSS = `html.${HIDE_CLASS} #gotcha-chat-root{display:none !important;}`;

export default function ChatWidget() {
  const pathname = useAppPathname();
  const allowed = chatWidgetAllowed(pathname);

  useEffect(() => {
    if (!document.getElementById(HIDE_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = HIDE_STYLE_ID;
      style.textContent = HIDE_CSS;
      document.head.appendChild(style);
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (allowed) root.classList.remove(HIDE_CLASS);
    else root.classList.add(HIDE_CLASS);
    return () => root.classList.remove(HIDE_CLASS);
  }, [allowed]);

  // The origin check runs in an effect rather than during render because the
  // export is prerendered on the server, where there is no window and every
  // host looks alike; a first paint that guessed would inject the widget into
  // the app host's HTML before the correction.
  const [onMarketingHost, setOnMarketingHost] = useState(false);
  useEffect(() => {
    setOnMarketingHost(rendersMarketing(window.location.origin));
  }, []);

  // Injected on the first allowed page and never removed: once loaded it is
  // only ever hidden. Re-injecting would be a no-op anyway.
  if (!onMarketingHost || !allowed) return null;

  return (
    <Script
      id="chatcenter-widget"
      strategy="afterInteractive"
      dangerouslySetInnerHTML={{
        __html: `
      window.__chatcenter = {
  widgetId: "widget_23381a52eb57270a647b8ca1",
  apiUrl: "https://app.gotcha.co.il",
};
      var s = document.createElement("script");
      s.src = "https://app.gotcha.co.il/widget/chatcenter-widget.js";
      s.async = true;
      document.head.appendChild(s);
    `,
      }}
    />
  );
}
