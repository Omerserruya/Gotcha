// Display-masking for protected customer identifiers in PICKER lists.
//
// Search results are a selection surface: the agent needs enough signal to
// pick the right person, not the full identifier. Full values are returned
// only by the detail endpoint, after an explicit selection (both behind the
// same customer-read permission - this is defense-in-depth, not the gate).

/** +9725•••••41 - country prefix + last two digits stay readable. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const p = String(phone);
  if (p.length <= 6) return p[0] + "•".repeat(Math.max(1, p.length - 1));
  return p.slice(0, 4) + "•".repeat(Math.max(2, p.length - 6)) + p.slice(-2);
}

/** o•••@gmail.com - first character of the local part + full domain. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = String(email);
  const at = e.indexOf("@");
  if (at <= 0) return "•••";
  return e[0] + "•••" + e.slice(at);
}
