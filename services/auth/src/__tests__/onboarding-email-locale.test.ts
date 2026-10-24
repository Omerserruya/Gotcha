/**
 * The welcome email of a console-created workspace (2026-10-24, Omer's walk on
 * omer-onb-1): it was English only and listed the old wizard's steps. It now
 * speaks the workspace's language and describes onboarding v2's four steps.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  // A configured transport, so the send reaches the mocked nodemailer.
  process.env.SMTP_HOST = "smtp.test"; process.env.SMTP_USER = "u"; process.env.SMTP_PASS = "p";
  return { locale: "he" as string | null, logs: [] as any[] };
});
const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "test" }));

vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock("../services/setup-link.service", () => ({
  issueSetupLink: async () => ({ url: "https://app.example.test/setup/tok_SECRET", token: "tok_SECRET", id: "l1", expiresAt: new Date() }),
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
    notificationLog: { create: async (a: any) => { H.logs.push(a.data); return {}; } },
    tenant: { findUnique: async () => (H.locale === null ? null : { defaultLocale: H.locale }) },
  },
  publishEvent: vi.fn().mockResolvedValue(undefined),
  ensureIdentity: vi.fn(),
  createRecoveryLink: vi.fn(),
  findIdentityBySubject: vi.fn(),
  resolveAppPublicUrl: () => "https://app.example.test",
}));

import { onboardingEmailHtml, sendOnboardingEmail, emailLocale } from "../services/notification.service";

const NBH = "‑"; // the UI's non-breaking hyphen before a Latin word
const sent = () => sendMail.mock.calls.at(-1)![0];

beforeEach(() => { H.locale = "he"; H.logs = []; sendMail.mockClear(); });

describe("the copy", () => {
  const he = onboardingEmailHtml("עומר", "חנות", "https://x/setup", "he");
  const en = onboardingEmailHtml("Omer", "Shop", "https://x/setup", "en");

  it("Hebrew: RTL, the four v2 steps, GOTCHA as the subject, the UI's hyphen", () => {
    expect(he).toContain('dir="rtl"');
    for (const step of ["לומדים את האתר", "מחברים מערכות", "מחברים ערוצים", "בודקים ועולים לאוויר"]) expect(he).toContain(step);
    expect(he).toContain("GOTCHA מוכנה להכיר את העסק. היא קוראת, אתם מאשרים.");
    expect(he).toContain("GOTCHA קוראת את המדיניות");
    expect(he).toContain(`ה${NBH}CRM`);
    expect(he).toContain(`ב${NBH}GOTCHA`);
    expect(he).toContain("בוחרים סיסמה ומתחילים");
    expect(he).not.toContain("־"); // no maqaf
    expect(he).not.toMatch(/העובד (קורא|עונה|מוכן)/); // no gendered verb after "the employee"
  });

  it("English: the four v2 steps, your AI employee, a password link", () => {
    for (const step of ["Learning your site", "Connect systems", "Connect channels", "Check and go live"]) expect(en).toContain(step);
    expect(en).toContain("your AI employee");
    expect(en).toContain("Set your password and start");
  });

  it.each([["he"], ["en"]])("%s: no old-wizard promises, no 'no login' claim, no em or en dash", (l) => {
    const html = onboardingEmailHtml("A", "B", "https://x/setup", l);
    for (const bad of ["No login required", "departments", "–", "—", "&mdash;", "&ndash;"]) expect(html).not.toContain(bad);
  });

  it("only 'he...' is Hebrew; anything else is English", () => {
    expect(emailLocale("he")).toBe("he");
    expect(emailLocale("he-IL")).toBe("he");
    expect(emailLocale("en")).toBe("en");
    expect(emailLocale(null)).toBe("en");
  });
});

describe("the send", () => {
  it("a passed locale wins", async () => {
    await sendOnboardingEmail("T", "a@example.invalid", "A", "Shop", "shop", "u1", "en");
    expect(sent().subject).toBe("Set up Shop on GOTCHA.");
  });

  it("★ no locale (a resend): the tenant's stored one", async () => {
    H.locale = "he";
    await sendOnboardingEmail("T", "a@example.invalid", "עומר", "חנות", "shop", "u1");
    expect(sent().subject).toBe("מקימים את חנות ב-GOTCHA.");
    expect(sent().text).toContain("GOTCHA קוראת את האתר ומראה לכם מה למדה.");
    expect(sent().text).not.toContain("־");
  });

  it("an unreadable tenant still sends, in English", async () => {
    H.locale = null;
    await sendOnboardingEmail("T", "a@example.invalid", "A", "Shop", "shop", "u1");
    expect(sent().subject).toBe("Set up Shop on GOTCHA.");
  });

  it("the setup link is in the email, never in the logged body", async () => {
    await sendOnboardingEmail("T", "a@example.invalid", "A", "Shop", "shop", "u1", "he");
    expect(sent().text).toContain("tok_SECRET");
    expect(JSON.stringify(H.logs)).not.toContain("tok_SECRET");
  });
});
