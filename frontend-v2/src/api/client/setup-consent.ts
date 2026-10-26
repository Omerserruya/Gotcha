'use client';

import {
  readSetupAccept,
  type SetupAcceptBody,
  type SetupAcceptOutcome,
} from '../contracts/setup-consent';

/**
 * The first-password consent, sent from the browser.
 *
 * ★ Not a server action and not the BFF: the record's evidence is the
 *   person's own address and user agent, and through our Node the server
 *   would see the container's. Same reason as `flow-executor`: a client for
 *   a route the gateway answers, outside `HttpClient`.
 *
 * ⚠ The gateway's root, not `appPath`: `/api/auth/*` is services/auth on the
 *   origin, as the email's own link (`/api/auth/setup/:token`) is.
 */
const acceptUrl = (token: string) => `/api/auth/setup/${encodeURIComponent(token)}/accept`;

export async function acceptSetupTerms(
  token: string,
  body: SetupAcceptBody,
): Promise<SetupAcceptOutcome> {
  try {
    const response = await fetch(acceptUrl(token), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // A body that is not JSON is read by its status alone.
    }
    return readSetupAccept(response.status, json);
  } catch {
    return { kind: 'unreachable' };
  }
}
