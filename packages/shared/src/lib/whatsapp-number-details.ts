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

/**
 * One read of the number, with the reason kept when it fails (2026-11-22).
 *
 * `refused` is true for exactly one answer from Meta: error code 100 with
 * subcode 33, "Unsupported get request. Object with ID ... does not exist,
 * cannot be loaded due to missing permissions". It means the number is gone
 * from Meta or our app may no longer read it. Every other failure (no network,
 * a timeout, a 5xx, a rate limit, an expired token) says nothing about that
 * and is `refused: false`.
 */
export type WhatsAppNumberRead =
  | { ok: true; details: WhatsAppNumberDetails | null }
  | { ok: false; refused: boolean; message: string };

export async function readWhatsAppNumber(phoneNumberId: string, accessToken: string): Promise<WhatsAppNumberRead> {
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
    return { ok: true, details: Object.keys(out).length ? out : null };
  } catch (err: any) {
    const e = err?.response?.data?.error;
    const message = String(e?.message ?? err?.message ?? "read failed");
    console.warn(`[whatsapp-number] could not read number ${phoneNumberId}:`, message);
    return { ok: false, refused: Number(e?.code) === 100 && Number(e?.error_subcode) === 33, message };
  }
}

/** Null when the read fails (logged) or Meta returns none of the three. */
export async function whatsappNumberDetails(
  phoneNumberId: string,
  accessToken: string,
): Promise<WhatsAppNumberDetails | null> {
  const read = await readWhatsAppNumber(phoneNumberId, accessToken);
  return read.ok ? read.details : null;
}

/** The stored platformMeta with the fresh details merged in, nothing else erased. */
export function withWhatsAppNumberDetails(prev: unknown, details: WhatsAppNumberDetails): Record<string, unknown> {
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {};
  return { ...base, ...details };
}
