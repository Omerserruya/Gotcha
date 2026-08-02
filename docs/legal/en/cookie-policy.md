# GOTCHA Cookie Policy

> This English text is a translation provided for convenience. The Hebrew version of this document is the authoritative one, and in case of any conflict or inconsistency between the versions, the Hebrew version prevails.

Effective date: July 18, 2026

This policy explains how GOTCHA by Omer Serruya, the operator of gotcha.co.il, uses cookies and similar technologies. The short version: the GOTCHA application sets no cookies of its own, our self-hosted sign-in service sets only strictly necessary cookies, and we use no analytics, marketing, or tracking technologies at all.

## 1. Cookies set by GOTCHA

None. The GOTCHA application and website set no cookies. There are no advertising cookies, no analytics cookies, no social media pixels, and no third-party tracking scripts anywhere in the product.

## 2. Cookies set by our sign-in service

Sign-in to GOTCHA is handled by a self-hosted identity service that runs on our own infrastructure, on the sign-in subdomain of gotcha.co.il. When you sign in, that service sets two kinds of strictly necessary cookies:

| Cookie | Purpose | Type | Lifetime |
|---|---|---|---|
| Session cookie | Keeps you signed in to the identity service during your sign-in session | Strictly necessary | Session |
| CSRF protection cookie | Protects sign-in forms against cross-site request forgery | Strictly necessary | Session |

These cookies are essential for authentication and security. They are not used for analytics, advertising, or tracking, and they are not shared with any third party: the identity service is self-hosted, so the cookies never leave our infrastructure.

## 3. Why there is no cookie consent banner

Because the only cookies in use are strictly necessary for signing in securely, and we use no analytics or marketing cookies, applicable cookie rules do not require prior consent for them. That is why you do not see a cookie consent banner on GOTCHA. If we ever introduce non-essential cookies, we will update this policy and ask for consent first.

## 4. Similar technologies: browser storage

Instead of cookies, the GOTCHA application keeps a small number of items in your browser's localStorage and sessionStorage. These stay on your device and are read by the application in your browser; they are not tracking technologies.

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

None of these items are sent to advertisers or analytics providers. The sign-in tokens are credentials for your own session; keep your device secure and sign out on shared computers.

## 5. How to clear cookies and browser storage

- Signing out of GOTCHA ends your application session and invalidates your sign-in session with the identity service.
- You can clear cookies and site data for gotcha.co.il and its subdomains in your browser settings (usually under Privacy or Site Settings, then "Cookies and site data"). This removes the sign-in cookies and all localStorage items listed above.
- Blocking all cookies for the sign-in subdomain will prevent you from signing in, because the session and CSRF cookies are required for authentication to work.

Clearing storage signs you out and resets local preferences such as language and tour progress; it does not delete any data stored on GOTCHA's servers.

## 6. Changes to this policy

If our use of cookies or browser storage changes, we will update this page and its effective date. Material changes will be announced through the platform or by email.

## 7. Contact

Questions about this policy: privacy@gotcha.co.il. General support: support@gotcha.co.il.

Related documents: ./privacy-policy.md

Contact: privacy@gotcha.co.il

Effective date: July 18, 2026
