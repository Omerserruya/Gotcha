/**
 * The v8 home's lead form, sent where every other lead already goes.
 *
 * POST /api/waitlist on this host: the gateway routes it to auth, which saves a
 * WaitlistEntry and alerts the team (Telegram and Airtable) from
 * lead-alert.service. The body follows services/auth/src/routes/waitlist.ts:
 * firstName is required there; phone is optional to the schema but this form
 * marks it required, as it marks the website; email is optional and sent only
 * when filled, because the schema rejects an empty string as an address.
 *
 * Plain JavaScript (.mjs) so `node --test` can run it with no build step.
 */

export const LEAD_ENDPOINT = '/api/waitlist';

/**
 * The request body for a filled form, or null when a required field is empty.
 * The website goes in both `company` (what the entry stores) and
 * `companyDomain` (what the alert shows as the website), as the route expects.
 */
export function leadFromForm(fields, source) {
  const v = (k) => String((fields && fields[k]) || '').trim();
  const firstName = v('name');
  const phone = v('phone');
  const site = v('site');
  const email = v('mail');
  if (!firstName || !phone || !site) return null;
  const body = { firstName, phone, company: site, companyDomain: site, source };
  if (email) body.email = email;
  return body;
}

/**
 * 'sent' or 'failed'.
 *
 * A 409 is the route saying it already has this email or phone: the person is
 * on the list, so for them it is a success. Anything else that is not 2xx, and
 * a request that never completes, is a failure the form has to show.
 */
export async function sendLead(body, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(LEAD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok || res.status === 409 ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * The one sentence the design has no copy for: its form never had anywhere to
 * send. Flagged for Omer with the rest of the port's decisions.
 */
export const SEND_FAILED = {
  en: "We couldn't send this. Please try again in a moment.",
  he: 'לא הצלחנו לשלוח. נסו שוב בעוד רגע.',
};
