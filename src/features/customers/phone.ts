/**
 * A phone-keyed handle as a person reads it: `972545680665` → `+972 54 568 0665`.
 *
 * Grouped only where the plan is known - Israel (972, nine national digits)
 * and NANP (1, ten). Any other country code gets its `+` and stays one run:
 * without the numbering plan, a grouping would be a guess about where the
 * country code ends.
 *
 * Only for channels keyed by phone. An Instagram or email handle is returned
 * as it came.
 */
const PHONE_CHANNELS = new Set(['WHATSAPP', 'VOICE', 'SMS']);

export function displayHandle(channel: string, externalId: string): string {
  if (!PHONE_CHANNELS.has(channel.toUpperCase())) return externalId;
  const digits = externalId.replace(/^\+/, '');
  if (!/^\d{8,15}$/.test(digits)) return externalId;
  const il = /^972(\d{2})(\d{3})(\d{4})$/.exec(digits);
  if (il) return `+972 ${il[1]} ${il[2]} ${il[3]}`;
  const us = /^1(\d{3})(\d{3})(\d{4})$/.exec(digits);
  if (us) return `+1 ${us[1]} ${us[2]} ${us[3]}`;
  return `+${digits}`;
}
