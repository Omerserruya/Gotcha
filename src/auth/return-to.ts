/**
 * Where the visitor is, as the proxy saw it — the path without the mount
 * (`/v2`) and with the query — so a server render that finds the session over
 * can send them to sign-in and back here afterwards.
 */
export const RETURN_TO_HEADER = 'x-gotcha-return-to';
