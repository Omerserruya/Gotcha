/**
 * A WhatsApp number as Meta shows it: display_phone_number, verified_name and
 * quality_rating, read with the account's own token. One read-only Graph GET,
 * never a write to Meta.
 *
 * Shared by the 6-hourly channel check (incoming-worker) and the on-demand
 * "refresh from Meta" (auth), so the two cannot store the number differently
 * (2026-10-09).
 */
import axios from "axios";
import { metaGraphBaseUrl } from "./meta-graph-version";

export interface WhatsAppNumberDetails {
  displayPhoneNumber?: string;
  verifiedName?: string;
  qualityRating?: string;
}

/** Null when the read fails (logged) or Meta returns none of the three. */
export async function whatsappNumberDetails(
  phoneNumberId: string,
  accessToken: string,
): Promise<WhatsAppNumberDetails | null> {
  try {
    const r = await axios.get(`${metaGraphBaseUrl(process.env.FACEBOOK_API_URL)}/${encodeURIComponent(phoneNumberId)}`, {
      params: { fields: "display_phone_number,verified_name,quality_rating" },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const d = r.data ?? {};
    const out: WhatsAppNumberDetails = {};
    if (typeof d.display_phone_number === "string" && d.display_phone_number) out.displayPhoneNumber = d.display_phone_number;
    if (typeof d.verified_name === "string" && d.verified_name) out.verifiedName = d.verified_name;
    if (typeof d.quality_rating === "string" && d.quality_rating) out.qualityRating = d.quality_rating;
    return Object.keys(out).length ? out : null;
  } catch (err: any) {
    console.warn(`[whatsapp-number] could not read number ${phoneNumberId}:`, err?.response?.data?.error?.message ?? err?.message);
    return null;
  }
}

/** The stored platformMeta with the fresh details merged in, nothing else erased. */
export function withWhatsAppNumberDetails(prev: unknown, details: WhatsAppNumberDetails): Record<string, unknown> {
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {};
  return { ...base, ...details };
}
