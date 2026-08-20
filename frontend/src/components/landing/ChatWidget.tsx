"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { rendersMarketing } from "@/lib/marketing-origin";

/**
 * The embedded chat widget, for the MARKETING pages only.
 *
 * One static export is served under two hostnames, so "only on the landing
 * page" cannot be decided at build time - it has to be answered from the origin
 * the browser actually loaded. rendersMarketing() is the same test `/` already
 * uses to decide whether it is a landing page or an application root, and it
 * fails OPEN: unset (dev, single-host) means the widget still shows, so we can
 * see it locally. On app.gotcha.co.il it is false and nothing is injected.
 *
 * The check runs in an effect rather than during render because the export is
 * prerendered on the server, where there is no window and every host looks
 * alike; a first paint that guessed would inject the widget into the app host's
 * HTML before the correction.
 */
export default function ChatWidget() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(rendersMarketing(window.location.origin));
  }, []);

  if (!show) return null;

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
