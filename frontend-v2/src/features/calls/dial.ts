/* Pure: the dialer (server) and the transfer panel (client) both use these. */

/**
 * A number typed or pasted as itself: a leading + and 8-15 digits once
 * spaces, dashes and brackets are dropped. The server validates E.164 again.
 */
export function pastedNumber(query: string): string | null {
  const digits = query.replace(/[\s\-()]/g, '');
  return /^\+\d{8,15}$/.test(digits) ? digits : null;
}

/**
 * A stored phone as the server dials it. Contacts keep the country-code
 * digits without the `+` (`972524189930`, as WhatsApp sends them); the
 * route accepts E.164 only (`validateE164`: `^\+[1-9]\d{6,14}$`).
 */
export function dialable(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[\s\-().]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  if (/^[1-9]\d{6,14}$/.test(digits)) return `+${digits}`;
  return null;
}
