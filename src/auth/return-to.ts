/**
 * Where the visitor is, as the proxy saw it - the path without the mount
 * (`/v2`) and with the query - so a server render that finds the session over
 * can send them to sign-in and back here afterwards.
 */
export const RETURN_TO_HEADER = 'x-gotcha-return-to';

/**
 * Set by the proxy when the identity provider refused the refresh: the
 * session ENDED, it was not merely absent. A render that sends the visitor
 * to sign-in passes it on (`?error=ended`), so the screen says why.
 */
export const SESSION_ENDED_HEADER = 'x-gotcha-session-ended';
