/**
 * 04's "Add a customer" — the pure half (Omer, 2026-10-04): a person by name
 * and phone, created as the WhatsApp identity they will write from.
 *
 * ★ The id is Meta's `wa_id` FORM — digits, no "+" (`972541234567`) — because
 *   that is what the inbound path stores (`ensure-contact`: externalId = the
 *   sender's wa_id, phone = the same). "+972…" would be a second contact the
 *   moment that person writes.
 */

/** "054-123 4567", "+972 54 1234567", "00972541234567" → "972541234567"; unparseable → null. */
export function whatsappIdOf(raw: string): string | null {
  const text = raw.trim();
  if (!/^[+\d][\d\s\-().]*$/.test(text)) return null;
  let digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) {
    // international as written
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    // Israeli national form: 05x… / 0x… → 9725x… / 972x…
    digits = `972${digits.slice(1)}`;
  } else if (!digits.startsWith('972')) {
    return null;
  }
  if (digits.startsWith('972')) {
    // 972 + 8 (landline) or 9 (mobile) digits, never a leading 0 after the code.
    return /^972[1-9]\d{7,8}$/.test(digits) ? digits : null;
  }
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

export function emailProblem(raw: string): boolean {
  const text = raw.trim();
  return text !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}
