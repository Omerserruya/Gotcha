'use client';

import {
  readSignUpAnswer,
  signUpBody,
  type SignUpForm,
  type SignUpOutcome,
} from '../contracts/self-signup';

/**
 * Self sign-up's submit, sent from the BROWSER.
 *
 * ★★ Not a server action. The route allows five an hour per address
 *   (services/auth signup.ts, `trust proxy` 1), keyed on the request's
 *   client address. Through our Node, every visitor would arrive as the
 *   container's one egress address and share one allowance: on dev the
 *   sign-up page is served by the auth build, which forwards no client
 *   address at all. From the browser, the gateway sees the visitor. This is
 *   the setup screen's consent reason too (`setup-consent.ts`).
 *
 * ⚠ The gateway's root, not `appPath`: `/api/auth/*` is services/auth on the
 *   origin, as the setup link's accept is.
 */
const SIGN_UP_URL = '/api/auth/signup';

export async function submitSignUp(
  form: SignUpForm,
  locale: string,
  capturedText: string,
  website: string,
): Promise<SignUpOutcome> {
  try {
    const response = await fetch(SIGN_UP_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(signUpBody(form, locale, capturedText, website)),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // A body that is not JSON is read by its status alone.
    }
    return readSignUpAnswer(response.status, json);
  } catch {
    return { kind: 'failed' };
  }
}
