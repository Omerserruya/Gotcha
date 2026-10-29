/**
 * Which WhatsApp Business Account a stored token manages, asked of Meta.
 *
 * For a number added by hand (a pasted token, no Embedded Signup), nothing
 * ever recorded its WABA (2026-10-29). Asked only on an explicit "Refresh from
 * Meta", never on a render, and read-only at Meta: debug_token's granular
 * scopes name the WABAs the token can manage, and GET /{waba}?fields=name
 * names it.
 *
 * Exactly one WABA, named, or null. Several WABAs is a guess we do not make,
 * and any failed call is null too: the caller then leaves the row as it was.
 */
import axios from "axios";
import { metaGraphBaseUrl } from "@chatcenter/shared";

export async function wabaOfToken(
  accessToken: string,
  app: { id: string; secret: string },
): Promise<{ wabaId: string; wabaName: string } | null> {
  if (!accessToken || !app.id || !app.secret) return null;
  const base = metaGraphBaseUrl(process.env.FACEBOOK_API_URL);
  try {
    const debug = await axios.get(`${base}/debug_token`, {
      params: { input_token: accessToken },
      headers: { Authorization: `Bearer ${app.id}|${app.secret}` },
    });
    const scopes: any[] = debug.data?.data?.granular_scopes ?? [];
    const ids = [
      ...new Set(
        scopes
          .filter((s) => s?.scope === "whatsapp_business_management")
          .flatMap((s) => (Array.isArray(s?.target_ids) ? s.target_ids : []))
          .map(String),
      ),
    ];
    if (ids.length !== 1) return null;
    const waba = await axios.get(`${base}/${encodeURIComponent(ids[0])}`, {
      params: { fields: "name" },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const name = typeof waba.data?.name === "string" ? waba.data.name.trim() : "";
    return name ? { wabaId: ids[0], wabaName: name } : null;
  } catch (err: any) {
    console.warn("[wa-numbers] could not resolve the token's WABA:", err?.response?.data?.error?.message ?? err?.message);
    return null;
  }
}
