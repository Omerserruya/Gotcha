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
  // One line per outcome: the reason and a count, never a token or an id.
  const say = (outcome: string) => console.log(`[wa-numbers] waba lookup: ${outcome}`);
  if (!accessToken || !app.id || !app.secret) {
    say(`skipped reason=${!accessToken ? "no_token" : "no_app_credentials"}`);
    return null;
  }
  const base = metaGraphBaseUrl(process.env.FACEBOOK_API_URL);
  try {
    const debug = await axios.get(`${base}/debug_token`, {
      params: { input_token: accessToken },
      headers: { Authorization: `Bearer ${app.id}|${app.secret}` },
    });
    const scopes: any[] = debug.data?.data?.granular_scopes ?? [];
    const management = scopes.filter((s) => s?.scope === "whatsapp_business_management");
    const ids = [
      ...new Set(
        management
          .flatMap((s) => (Array.isArray(s?.target_ids) ? s.target_ids : []))
          .map(String),
      ),
    ];
    if (ids.length !== 1) {
      // No management scope at all, or one without target_ids (a token over
      // "all assets" lists none), is a different fact from several WABAs.
      const reason = ids.length > 1 ? "several_wabas" : management.length === 0 ? "no_management_scope" : "scope_without_targets";
      say(`none stored reason=${reason} wabas=${ids.length} scopes=${scopes.length}`);
      return null;
    }
    const waba = await axios.get(`${base}/${encodeURIComponent(ids[0])}`, {
      params: { fields: "name" },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const name = typeof waba.data?.name === "string" ? waba.data.name.trim() : "";
    if (!name) {
      say("none stored reason=waba_without_name wabas=1");
      return null;
    }
    say("stored wabas=1");
    return { wabaId: ids[0], wabaName: name };
  } catch (err: any) {
    const step = err?.config?.url?.includes("/debug_token") ? "debug_token" : "waba_name";
    say(`none stored reason=${step}_failed status=${err?.response?.status ?? "none"}`);
    return null;
  }
}
