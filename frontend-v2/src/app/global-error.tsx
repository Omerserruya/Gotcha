'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * The last resort: the root layout itself failed.
 *
 * It must render its own `<html>` and `<body>`, because the layout that
 * normally provides them is the thing that broke. For the same reason it uses
 * no translations, no design-system component and no provider - every one of
 * those could be the cause, and an error page that throws leaves the user with
 * a blank screen.
 *
 * The copy is English-only by necessity. This is the one place in the product
 * where that is acceptable.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          margin: 0,
        }}
      >
        <main style={{ textAlign: 'center', padding: '2rem' }}>
          <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
          <p style={{ color: '#666', marginBottom: '1rem' }}>
            The application failed to start. We have been notified.
          </p>
          {error.digest ? (
            <p
              style={{ color: '#999', fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem' }}
            >
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ marginTop: '1rem' }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
