/**
 * The Google connect intent's cookie, by name only - so the proxy can see
 * that a connect is under way without the sealing code (google-sign-in.ts is
 * server-only and holds the key).
 *
 * Path `/`, not `/api/auth`: the proxy reads its PRESENCE on `/sign-in`, where
 * the sign-out lands, to add the `?connect=google` hint when it moves the
 * person to the sign-in origin. The provider's post-logout address cannot
 * carry that hint itself (it must equal a registered URI). Only the callback
 * reads its CONTENT.
 */
export const CONNECT_COOKIE = 'gotcha_google_connect';
export const CONNECT_COOKIE_PATH = '/';
