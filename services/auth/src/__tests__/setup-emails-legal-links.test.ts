/**
 * The two emails a new organisation gets carry working Terms and Privacy links,
 * in its language (2026-10-26, Omer: "ותוודא שזה במייל שנשלח").
 *
 * What was wrong before: the links were <app>/legal/<slug>, two redirects from
 * the Trust Center and always on the ENGLISH page; the plain-text half of a
 * Hebrew email ended on an English consent line; and the setup-link resend was
 * English only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  process.env.SMTP_HOST = "smtp.test"; process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p";
  return { locale: "he" as string | null };
});
const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "test" }));

vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock("../services/setup-link.service", () => ({
  issueSetupLink: async () => ({ url: "https://app.example.test/api/auth/setup/tok_SECRET", token: "tok_SECRET", id: "l1", expiresAt: new Date() }),
}));
vi.mock("@chatcenter/shared", async () => ({
  ...(await vi.importActual<any>("../../../../packages/shared/src/lib/email/brand-email")),
  NOTIFICATIONS_EMAIL_QUEUE_NAME: "notifications-email",
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: {
    notificationLog: { create: async () => ({}) },
    tenant: { findUnique: async () => (H.locale === null ? null : { defaultLocale: H.locale }) },
    user: { findUnique: async () => ({ email: "dana@acme.com", name: "Dana", tenantId: "t1", tenant: { name: "Acme" } }) },
  },
  publishEvent: vi.fn().mockResolvedValue(undefined),
  ensureIdentity: vi.fn(),
  createRecoveryLink: vi.fn(),
  findIdentityBySubject: vi.fn(),
  resolveAppPublicUrl: () => "https://app.example.test",
}));

import { onboardingEmailHtml, setupLinkEmail, sendOnboardingEmail, sendSetupLinkEmail } from "../services/notification.service";

const EN = { terms: "https://trust.gotcha.co.il/terms-of-service", privacy: "https://trust.gotcha.co.il/privacy-policy" };
const HE = { terms: "https://trust.gotcha.co.il/he/terms-of-service", privacy: "https://trust.gotcha.co.il/he/privacy-policy" };
const sent = () => sendMail.mock.calls.at(-1)![0];
const linked = (html: string, url: string) => html.includes(`href="${url}"`);

beforeEach(() => { H.locale = "he"; delete process.env.TRUST_PUBLIC_URL; sendMail.mockClear(); });

describe("the welcome email of a console-created workspace", () => {
  it("Hebrew links the Hebrew Terms and Privacy Policy", () => {
    const html = onboardingEmailHtml("עומר", "חנות", "https://x/setup", "he");
    expect(linked(html, HE.terms)).toBe(true);
    expect(linked(html, HE.privacy)).toBe(true);
    expect(html).toContain("תנאי השירות");
    expect(html).not.toContain("/legal/");
  });

  it("English links the English ones", () => {
    const html = onboardingEmailHtml("Omer", "Shop", "https://x/setup", "en");
    expect(linked(html, EN.terms)).toBe(true);
    expect(linked(html, EN.privacy)).toBe(true);
  });

  it("the plain-text half of a Hebrew send ends on the Hebrew line, with the Hebrew links", async () => {
    await sendOnboardingEmail("t1", "a@b.c", "עומר", "חנות", "chanut", "u1", "he");
    const { text } = sent();
    expect(text).toContain("מדיניות הפרטיות");
    expect(text).toContain(HE.terms);
    expect(text).toContain(HE.privacy);
    expect(text).not.toContain("Terms of Service");
  });

  it("and an English send, the English one", async () => {
    await sendOnboardingEmail("t1", "a@b.c", "Omer", "Shop", "shop", "u1", "en");
    expect(sent().text).toContain(EN.terms);
  });
});

describe("the welcome email says what is true of the link", () => {
  // It is multi-use for 48 hours (setup-link.service markSetupLinkUsed), not single-use.
  it("valid for 48 hours, never \"works once\"", async () => {
    for (const lang of ["he", "en"]) {
      await sendOnboardingEmail("t1", "a@b.c", "Dana", "Acme", "acme", "u1", lang);
      const { html, text } = sent();
      for (const body of [html, text]) {
        expect(body).not.toMatch(/חד-פעמי|works once/);
        expect(body).toMatch(lang === "he" ? /הקישור בתוקף (<strong[^>]*>)?48 שעות/ : /valid for (<strong[^>]*>)?48 hours/);
      }
    }
  });
});

describe("the setup-link resend", () => {
  it("speaks Hebrew for a Hebrew workspace, RTL, neutral, no maqaf", () => {
    const { subject, html, text } = setupLinkEmail("דנה", "אקמה", "https://x/setup", "he");
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("הנה קישור חדש.");
    expect(html).toContain("בוחרים סיסמה");
    expect(subject).toContain("GOTCHA");
    expect(text).toContain("https://x/setup");
    expect(html).not.toContain("־");
    expect(linked(html, HE.terms)).toBe(true);
    expect(linked(html, HE.privacy)).toBe(true);
  });

  it("English for an English one, with the English documents", () => {
    const { html } = setupLinkEmail("Dana", "Acme", "https://x/setup", "en");
    expect(html).toContain("Here is a fresh link.");
    expect(linked(html, EN.terms)).toBe(true);
    expect(linked(html, EN.privacy)).toBe(true);
  });

  it("the send follows the workspace's stored locale, in both halves", async () => {
    H.locale = "he";
    await sendSetupLinkEmail("u1");
    expect(sent().html).toContain('dir="rtl"');
    expect(sent().text).toContain(HE.privacy);
    H.locale = "en";
    await sendSetupLinkEmail("u1");
    expect(sent().html).toContain("Here is a fresh link.");
    expect(sent().text).toContain(EN.privacy);
  });

  it("an unreadable locale still sends, in English", async () => {
    H.locale = null;
    await sendSetupLinkEmail("u1");
    expect(sent().text).toContain(EN.terms);
  });
});
