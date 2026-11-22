/**
 * The custom-app emails' wording is Omer's (2026-11-22). The mail transport is a double (no SMTP, no live
 * mail); the install link is never written to the notification log.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ mails: [] as any[], logs: [] as any[] }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: async (m: any) => { H.mails.push(m); return { messageId: "m" }; } }) } }));
vi.mock("@chatcenter/shared", async (orig) => ({
  ...(await orig<any>()),
  prisma: { notificationLog: { create: async (a: any) => { H.logs.push(a.data); return {}; } } },
  resolveAppPublicUrl: () => "https://app.gotcha.co.il",
}));

import { sendShopifyCustomAppEmail } from "../services/notification.service";

const LINK = "https://admin.shopify.com/oauth/install_custom_app?client_id=c&signature=s";
beforeEach(() => { H.mails = []; H.logs = []; process.env.SMTP_HOST = "smtp.test"; process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p"; });

describe("the merchant's install link email", () => {
  it("★ Hebrew: Omer's text, the link, the expiry; the link kept out of the log", async () => {
    await sendShopifyCustomAppEmail({ kind: "install_link", tenantId: "T", tenantName: "אקמה", shopDomain: "s.myshopify.com", to: "a@b.co", locale: "he", installLink: LINK, expiresAt: "2026-11-29T20:00:00Z" });
    const m = H.mails[0];
    expect(m.subject).toBe("קישור להתקנת GOTCHA בחנות s.myshopify.com");
    expect(m.text).toContain("הכנו עבורכם אפליקציית GOTCHA ייעודית לחנות s.myshopify.com. כדי לחבר את החנות, פתחו את הקישור הבא כשאתם מחוברים לחשבון ה-Shopify של החנות, ואשרו את ההתקנה:");
    expect(m.text).toContain(LINK);
    expect(m.text).toContain("והחנות תחובר לסביבת העבודה אקמה.");
    expect(m.text).toContain("אם הקישור פג תוקף, השיבו למייל הזה ונשלח קישור חדש.");
    expect(m.html).toMatch(/admin\.shopify\.com\/oauth\/install_custom_app/);
    expect(JSON.stringify(H.logs)).not.toContain("signature=s");
    expect(H.logs[0]).toMatchObject({ type: "shopify_custom_app_install_link", recipient: "a@b.co" });
  });
  it("English: the matching text", async () => {
    await sendShopifyCustomAppEmail({ kind: "install_link", tenantId: "T", tenantName: "Acme", shopDomain: "s.myshopify.com", to: "a@b.co", locale: "en", installLink: LINK, expiresAt: "2026-11-29T20:00:00Z" });
    expect(H.mails[0].subject).toBe("Your GOTCHA install link for s.myshopify.com");
    expect(H.mails[0].text).toContain("We have set up a dedicated GOTCHA app for your store s.myshopify.com. To connect it, open the link below while signed in to the store's Shopify account, and approve the installation:");
  });
});

describe("the internal notice", () => {
  it("names the workspace, the shop and the console", async () => {
    await sendShopifyCustomAppEmail({ kind: "request_notice", tenantId: "T", tenantName: "Acme", shopDomain: "s.myshopify.com", to: "ops@gotcha.co.il", requestedAt: "2026-11-22T20:00:00Z", consoleUrl: "https://app.gotcha.co.il/system/shopify-custom-apps" });
    expect(H.mails[0].subject).toBe("Shopify store waiting for a custom app: s.myshopify.com");
    expect(H.mails[0].text).toContain("Workspace Acme (T) asked to connect s.myshopify.com on 2026-11-22T20:00:00Z.");
    expect(H.mails[0].text).toContain("https://app.gotcha.co.il/system/shopify-custom-apps");
  });
});
