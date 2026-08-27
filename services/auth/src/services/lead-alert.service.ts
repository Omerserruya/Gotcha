/**
 * "A lead just came in" - the message, and everywhere it goes.
 *
 * The fields are defined ONCE here and rendered per channel, because the bug
 * this replaces was exactly the other thing: Telegram had its own hand-written
 * field list, and the phone number - the one detail you need to act on a lead
 * within the minute - was not in it. Anyone adding a field to the form has one
 * place to add it, and both channels get it.
 *
 * Two channels, both optional and both non-blocking. A signup must never fail,
 * or even wait, because a notification did.
 */

import { sendTelegramNotification } from "./telegram.service";
import { sendWhatsAppAlert } from "./whatsapp-alert.service";

export interface LeadAlert {
  firstName: string;
  /** The real address, or "" for a phone-first lead from the landing CTA. */
  email: string;
  phone?: string | null;
  /** Industry on the full form, which is what the landing CTA puts here too. */
  company?: string | null;
  role?: string | null;
  companySize?: string | null;
  frustration?: string | null;
  source: string;
  createdAt: Date;
}

/** Label/value pairs, in the order a human wants to read them. */
function fields(lead: LeadAlert): Array<[string, string]> {
  const out: Array<[string, string]> = [["Name", lead.firstName]];

  // Contact first: these are the two things someone acts on.
  if (lead.email) out.push(["Email", lead.email]);
  if (lead.phone) out.push(["Phone", lead.phone]);

  if (lead.company) out.push(["Industry", lead.company]);
  if (lead.role) out.push(["Role", lead.role]);
  if (lead.companySize) out.push(["Team size", lead.companySize]);
  if (lead.frustration) out.push(["Pain", lead.frustration]);
  out.push(["Source", lead.source]);
  out.push(["Time", lead.createdAt.toISOString().replace("T", " ").substring(0, 19) + " UTC"]);
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Telegram's HTML parse mode. */
export function formatNewLeadMessage(lead: LeadAlert): string {
  return [
    "🚀 <b>New Early Access Signup</b>",
    "",
    ...fields(lead).map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(v)}`),
  ].join("\n");
}

/**
 * WhatsApp text. `*bold*` is WhatsApp's own markup, not Markdown - the same
 * asterisk syntax the outbound worker uses for agent replies.
 */
export function formatNewLeadWhatsApp(lead: LeadAlert): string {
  return [
    "🚀 *New Early Access Signup*",
    "",
    ...fields(lead).map(([k, v]) => `*${k}:* ${v}`),
  ].join("\n");
}

/**
 * Fan out to every configured alert channel.
 *
 * Never rejects: the caller is a public signup handler, and a lead that reached
 * the database is a success whether or not the team's chat heard about it.
 */
export async function notifyNewLead(lead: LeadAlert): Promise<void> {
  await Promise.allSettled([
    sendTelegramNotification(formatNewLeadMessage(lead)),
    sendWhatsAppAlert(formatNewLeadWhatsApp(lead)),
  ]);
}
