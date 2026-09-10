# GOTCHA Cookie Policy

> This English text is a translation provided for convenience. The Hebrew version of this document is the authoritative one, and in case of any conflict or inconsistency between the versions, the Hebrew version prevails.

Effective date: September 9, 2026

This policy explains how GOTCHA by Omer Serruya, the operator of gotcha.co.il, uses cookies and similar technologies. The short version: GOTCHA sets one cookie of its own, which remembers your answer to the cookie question, our self-hosted sign-in service sets only strictly necessary cookies, we use no marketing or tracking technologies at all, and no analytics runs unless you choose to allow it.

## 1. Cookies set by GOTCHA

One, and it exists only to record what you told us.

| Cookie | Purpose | Type | Lifetime |
|---|---|---|---|
| `gotcha_consent` | Remembers your answer to the cookie question, so you are asked once rather than on every visit | Strictly necessary | 6 months |

It is set on gotcha.co.il and shared with our subdomains, so answering the question on one part of the site answers it for all of them. It holds nothing but your answer, the date you gave it and a version number. There is no identifier in it, and it is never sent to a third party.

There are no advertising cookies, no analytics cookies, no social media pixels, and no third-party tracking scripts anywhere in the product.

## 2. Cookies set by our sign-in service

Sign-in to GOTCHA is handled by a self-hosted identity service that runs on our own infrastructure, on the sign-in subdomain of gotcha.co.il. When you sign in, that service sets two kinds of strictly necessary cookies:

| Cookie | Purpose | Type | Lifetime |
|---|---|---|---|
| Session cookie | Keeps you signed in to the identity service during your sign-in session | Strictly necessary | Session |
| CSRF protection cookie | Protects sign-in forms against cross-site request forgery | Strictly necessary | Session |

These cookies are essential for authentication and security. They are not used for analytics, advertising, or tracking, and they are not shared with any third party: the identity service is self-hosted, so the cookies never leave our infrastructure.

## 3. The choice we ask you to make

On your first visit to our website you are asked one question, with two categories.

**Strictly necessary** covers the sign-in cookies described above. They cannot be switched off, and applicable cookie rules do not require prior consent for them, because without them signing in securely does not work.

**Analytics** is optional and off unless you turn it on. No analytics provider is in use today; we ask first so that measuring which pages are useful can never begin without a decision from you. There are no advertising cookies, no social media pixels and no third-party tracking scripts, and no category above asks for consent to any.

Your answer is stored on your own device in the `gotcha_consent` cookie described in section 1, not on our servers. Because that cookie is shared across gotcha.co.il and its subdomains, you are asked once and not again as you move between the website, the Help Center and the Trust Center. You can change your answer at any time by clearing your browser storage for this site, which makes the question appear again, and it expires by itself after six months so that a decision is never treated as permanent. If we ever introduce a category beyond these two, we will update this policy and ask again rather than treat an earlier answer as covering it.

## 4. Similar technologies: browser storage

Beyond the one cookie above, the GOTCHA application keeps a small number of items in your browser's localStorage and sessionStorage. These stay on your device and are read by the application in your browser; they are not tracking technologies.

| Item | Storage | Purpose |
|---|---|---|
| Sign-in tokens (access token, refresh token, token expiry) | localStorage | Keeps you signed in to the application and refreshes your session |
| Sign-in flow values (verifier, state, return path) | sessionStorage | Secures the sign-in redirect; single use, cleared right after sign-in completes |
| Language preference | localStorage | Remembers your interface language (for example English or Hebrew) |
| Workspace selection | localStorage | Remembers which workspace you are working in, when your account belongs to more than one |
| Interface layout and list state | localStorage | Remembers layout choices such as a collapsed sidebar, and which conversations you marked as unread |
| Onboarding and tour progress | localStorage | Remembers where you are in setup and the guided tour |
| Notification and sound preferences | localStorage | Remembers your notification sound settings |
| Voice call preferences and callback state | localStorage and sessionStorage | Remembers per-device voice settings and in-progress call state |
| Assistant calibration preference | localStorage | Remembers a per-device assistant setting |
| Cookie choice | localStorage | A copy of the `gotcha_consent` cookie, kept in case the browser refuses the cookie; the cookie is what is read first |

None of these items are sent to advertisers or analytics providers. The sign-in tokens are credentials for your own session; keep your device secure and sign out on shared computers.

## 5. How to clear cookies and browser storage

- Signing out of GOTCHA ends your application session and invalidates your sign-in session with the identity service.
- You can clear cookies and site data for gotcha.co.il and its subdomains in your browser settings (usually under Privacy or Site Settings, then "Cookies and site data"). This removes the sign-in cookies, the `gotcha_consent` cookie and all localStorage items listed above, and the cookie question will be asked again on your next visit.
- Blocking all cookies for the sign-in subdomain will prevent you from signing in, because the session and CSRF cookies are required for authentication to work.

Clearing storage signs you out and resets local preferences such as language and tour progress; it does not delete any data stored on GOTCHA's servers.

## 6. Changes to this policy

If our use of cookies or browser storage changes, we will update this page and its effective date. Material changes will be announced through the platform or by email.

## 7. Contact

Questions about this policy: privacy@gotcha.co.il. General support: support@gotcha.co.il.

Related documents: ./privacy-policy.md

Contact: privacy@gotcha.co.il

Effective date: September 9, 2026
