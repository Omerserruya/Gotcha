/**
 * Where the card session's id waits while the person is on the provider's
 * page - sessionStorage, never the URL (the return path carries none).
 * Shared by the button that starts it and the page that confirms it.
 */
export const CARD_SESSION_KEY = 'gotcha.billing.cardSession';
