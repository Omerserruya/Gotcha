"use client";

/**
 * The App Router's last resort, and the only place a render error in the root
 * layout can be caught.
 *
 * Without this file a React rendering failure unmounts the tree and shows
 * Next.js's built-in error page - the user sees a blank screen and Sentry sees
 * nothing, because the error never reaches window.onerror. "React rendering" is
 * one of the surfaces gotcha-frontend is meant to cover, and this is what makes
 * that true rather than assumed.
 *
 * global-error replaces the root layout, so it must render its own <html> and
 * <body>, and it cannot use the app's i18n or theme providers - they live in the
 * tree that just failed. The copy is deliberately plain for that reason.
 */
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // A no-op unless the SDK was initialised, which only happens in a real
    // production bundle (see sentry.client.config.ts).
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "Inter, system-ui, sans-serif",
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          margin: 0,
          color: "#1e1b4b",
        }}
      >
        <div style={{ maxWidth: 460, padding: "0 24px", textAlign: "center" }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 10 }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, color: "#475569", marginBottom: 22 }}>
            The page could not be displayed. Trying again usually works. If it keeps
            happening, our team has already been notified.
          </p>
          <button
            onClick={reset}
            style={{
              background: "#7c5cfc",
              color: "#fff",
              border: 0,
              borderRadius: 999,
              padding: "10px 22px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
