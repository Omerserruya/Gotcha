/**
 * The lead alert is the only thing that tells a human a lead arrived, and the
 * field it was missing - the phone number - is the one you act on first. These
 * lock the fields in for BOTH channels, and lock in that an unconfigured
 * WhatsApp bridge stays silent rather than throwing into a signup handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const LEAD = {
  firstName: "Dana",
  email: "dana@shop.co.il",
  phone: "052-540-1686",
  company: "E-Commerce",
  role: "founder",
  companySize: "2_10",
  frustration: "Five apps, one customer",
  source: "early-access-form",
  createdAt: new Date("2026-08-25T09:15:00.000Z"),
};

describe("lead alert message", () => {
  it("carries the phone number on Telegram", async () => {
    const { formatNewLeadMessage } = await import("../services/lead-alert.service");
    expect(formatNewLeadMessage(LEAD)).toContain("052-540-1686");
  });

  it("carries the phone number on WhatsApp", async () => {
    const { formatNewLeadWhatsApp } = await import("../services/lead-alert.service");
    expect(formatNewLeadWhatsApp(LEAD)).toContain("052-540-1686");
  });

  it("carries every field the form collects", async () => {
    const { formatNewLeadMessage, formatNewLeadWhatsApp } = await import("../services/lead-alert.service");
    for (const render of [formatNewLeadMessage, formatNewLeadWhatsApp]) {
      const msg = render(LEAD);
      for (const expected of [
        "Dana", "dana@shop.co.il", "052-540-1686",
        "E-Commerce", "founder", "2_10", "Five apps, one customer",
        "early-access-form",
      ]) {
        expect(msg, `${render.name} should include ${expected}`).toContain(expected);
      }
    }
  });

  it("omits the contact rows a phone-first lead does not have", async () => {
    const { formatNewLeadMessage } = await import("../services/lead-alert.service");
    const msg = formatNewLeadMessage({ ...LEAD, email: "", frustration: null, source: "landing-cta" });
    expect(msg).not.toContain("Email:");
    expect(msg).toContain("Phone:");
  });

  it("escapes HTML for Telegram so a lead cannot inject markup", async () => {
    const { formatNewLeadMessage } = await import("../services/lead-alert.service");
    const msg = formatNewLeadMessage({ ...LEAD, firstName: "<b>Dana</b>" });
    expect(msg).toContain("&lt;b&gt;Dana&lt;/b&gt;");
  });

  it("uses WhatsApp's own bold markup, not Markdown", async () => {
    const { formatNewLeadWhatsApp } = await import("../services/lead-alert.service");
    const msg = formatNewLeadWhatsApp(LEAD);
    expect(msg).toContain("*Phone:*");
    expect(msg).not.toContain("**");
  });
});

describe("whatsapp alert transport", () => {
  const ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...ENV };
  });

  it("sends nothing when the bridge is not configured", async () => {
    delete process.env.WHATSAPP_ALERT_API_URL;
    delete process.env.WHATSAPP_ALERT_SESSION;
    delete process.env.WHATSAPP_ALERT_CHAT_ID;
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);

    const { sendWhatsAppAlert } = await import("../services/whatsapp-alert.service");
    await expect(sendWhatsAppAlert("hello")).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts the group chat id to the bridge when it is configured", async () => {
    process.env.WHATSAPP_ALERT_API_URL = "http://waha.local:3000/";
    process.env.WHATSAPP_ALERT_API_KEY = "key_test";
    process.env.WHATSAPP_ALERT_SESSION = "omer-business";
    process.env.WHATSAPP_ALERT_CHAT_ID = "12036300000000000@g.us";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch" as never)
      .mockResolvedValue({ ok: true, text: async () => "" } as never);

    const { sendWhatsAppAlert } = await import("../services/whatsapp-alert.service");
    await sendWhatsAppAlert("new lead");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    // The trailing slash on the configured base must not double up.
    expect(url).toBe("http://waha.local:3000/api/sendText");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("key_test");
    expect(JSON.parse(init.body as string)).toEqual({
      session: "omer-business",
      chatId: "12036300000000000@g.us",
      text: "new lead",
    });
  });

  it("swallows a bridge that is down", async () => {
    process.env.WHATSAPP_ALERT_API_URL = "http://waha.local:3000";
    process.env.WHATSAPP_ALERT_SESSION = "omer-business";
    process.env.WHATSAPP_ALERT_CHAT_ID = "12036300000000000@g.us";
    vi.spyOn(globalThis, "fetch" as never).mockRejectedValue(new Error("ECONNREFUSED") as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { sendWhatsAppAlert } = await import("../services/whatsapp-alert.service");
    await expect(sendWhatsAppAlert("new lead")).resolves.toBeUndefined();
  });
});
