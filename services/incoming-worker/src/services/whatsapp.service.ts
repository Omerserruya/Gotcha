import axios from "axios";
import { metaGraphBaseUrl } from "@chatcenter/shared";

const WA_API_URL = metaGraphBaseUrl(process.env.WHATSAPP_API_URL);

export async function sendWhatsAppMessage(phoneNumberId: string, accessToken: string, to: string, text: string): Promise<string | null> {
  try {
    const response = await axios.post(`${WA_API_URL}/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body: text },
    }, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
    return response.data?.messages?.[0]?.id || null;
  } catch (err: any) {
    console.error("WhatsApp send error:", err.response?.data || err.message);
    return null;
  }
}

export async function sendQuickReply(phoneNumberId: string, accessToken: string, to: string, bodyText: string, buttons: Array<{ id: string; title: string }>): Promise<string | null> {
  try {
    const response = await axios.post(`${WA_API_URL}/${phoneNumberId}/messages`, {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: {
        type: "button", body: { text: bodyText },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    }, { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } });
    return response.data?.messages?.[0]?.id || null;
  } catch (err: any) {
    console.error("WhatsApp quick reply error:", err.response?.data || err.message);
    return null;
  }
}
