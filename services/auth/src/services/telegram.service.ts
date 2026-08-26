/**
 * Telegram transport. The lead message itself is built in
 * lead-alert.service.ts, which renders the same fields for every channel -
 * this file used to carry its own field list, and that is how the phone
 * number ended up missing from the alert while sitting in the database.
 */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

function isConfigured(): boolean {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

export async function sendTelegramNotification(message: string): Promise<void> {
  if (!isConfigured()) {
    console.log("[TELEGRAM] Not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID required). Skipping.");
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[TELEGRAM] API error ${res.status}: ${body}`);
    }
  } catch (err: any) {
    console.error("[TELEGRAM] Failed to send notification:", err.message);
  }
}
