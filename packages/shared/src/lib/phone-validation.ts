// Server-side E.164 destination validation for outbound calling.
//
// The frontend normalizes with libphonenumber for UX; the SERVER must still
// refuse any destination that is not a plain E.164 number, or a raw API
// caller could hand the telephony provider an arbitrary string. Formatting
// characters (spaces, dashes, dots, parentheses) are tolerated and stripped;
// a leading + followed by 7-15 digits (no leading zero) is required.

export interface E164Validation {
  ok: boolean;
  /** The normalized +digits form when ok. */
  normalized: string | null;
}

export function validateE164(raw: string): E164Validation {
  const stripped = String(raw || "").trim().replace(/[\s\-().]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(stripped)) return { ok: true, normalized: stripped };
  return { ok: false, normalized: null };
}
