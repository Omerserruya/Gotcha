/**
 * Internal alerts into a WhatsApp GROUP.
 *
 * Why this does not go through GOTCHA's own WhatsApp channel: the Meta Cloud
 * API - the API behind every WABA number in the product - has no concept of a
 * group. It addresses one phone number at a time, and business-initiated
 * messages outside a 24 hour customer window need an approved template. So the
 * official API can tell the team about a lead only by sending each member a
 * separate templated message, which is neither a group nor free.
 *
 * A WhatsApp *group* means a WhatsApp Web bridge. WAHA is the one already
 * running for outbound SDR work, it speaks a two-field HTTP API, and a group is
 * simply a chat id ending in `@g.us`. That is what this posts to.
 *
 * Note this is an INTERNAL alert into a group we are a member of - not cold
 * outreach - so the rate limiting that governs prospecting does not apply here.
 *
 * Entirely optional. With no URL and no chat id configured it logs once and
 * returns, which is the state of every environment that has not been pointed at
 * a bridge - including CI and every developer machine.
 */

const BASE_URL = (process.env.WHATSAPP_ALERT_API_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.WHATSAPP_ALERT_API_KEY || "";
/** Which logged-in WhatsApp account sends. Named explicitly, never defaulted
 *  server-side: a bridge can hold several, and they are different numbers. */
const SESSION = process.env.WHATSAPP_ALERT_SESSION || "";
/** The destination. A group is `<id>@g.us`; a single number is `<msisdn>@c.us`. */
const CHAT_ID = process.env.WHATSAPP_ALERT_CHAT_ID || "";

/** 5s: a notification must never hold a signup request open. */
const TIMEOUT_MS = 5000;

function isConfigured(): boolean {
  return Boolean(BASE_URL && SESSION && CHAT_ID);
}

export async function sendWhatsAppAlert(text: string): Promise<void> {
  if (!isConfigured()) {
    console.log(
      "[WA-ALERT] Not configured (WHATSAPP_ALERT_API_URL, WHATSAPP_ALERT_SESSION, WHATSAPP_ALERT_CHAT_ID required). Skipping.",
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE_URL}/api/sendText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "X-Api-Key": API_KEY } : {}),
      },
      body: JSON.stringify({ session: SESSION, chatId: CHAT_ID, text }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[WA-ALERT] API error ${res.status}: ${body.slice(0, 500)}`);
    }
  } catch (err: any) {
    console.error("[WA-ALERT] Failed to send notification:", err?.message || err);
  } finally {
    clearTimeout(timer);
  }
}
