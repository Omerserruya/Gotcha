/**
 * The email a sign-up gets when its address already has an account
 * (2026-11-22). The words are Omer's approved wording; a changed word fails
 * here. It carries nothing the public form sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ sent: [] as any[], logs: [] as any[], sendFails: false }));

// No test may reach a real mail server: the transport is a recorder, and the
// host below does not exist, so even an unmocked transport could send nothing.
process.env.SMTP_HOST = "smtp.invalid";
process.env.SMTP_USER = "nobody";
process.env.SMTP_PASS = "nothing";
vi.mock("nodemailer", () => {
  const createTransport = () => ({
    sendMail: async (m: any) => { if (H.sendFails) throw new Error("smtp down"); H.sent.push(m); },
  });
  return { default: { createTransport }, createTransport };
});

vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    prisma: { notificationLog: { create: async (q: any) => { H.logs.push(q.data); } } },
    resolveAppPublicUrl: () => "https://app.example.test",
  };
});

import { signInHintEmail, sendSignInHintEmail } from "../services/notification.service";

const LINK = "https://app.example.test";

beforeEach(() => {
  H.sent = []; H.logs = []; H.sendFails = false;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("the sign-in hint, word for word", () => {
  it("English", () => {
    const m = signInHintEmail(LINK, "en");
    expect(m.subject).toBe("You already have a GOTCHA account");
    expect(m.text).toBe(
      [
        "Someone asked to open a GOTCHA account with this email address, and you already have one.",
        "",
        "Sign in here: https://app.example.test",
        "",
        "If the request did not come from you, you can ignore this email.",
      ].join("\n"),
    );
    expect(m.html).toContain("Someone asked to open a GOTCHA account with this email address, and you already have one.");
    expect(m.html).toContain("Sign in here");
    expect(m.html).toContain('href="https://app.example.test"');
    expect(m.html).toContain("If the request did not come from you, you can ignore this email.");
  });

  it("Hebrew, right to left", () => {
    const m = signInHintEmail(LINK, "he");
    expect(m.subject).toBe("כבר יש לך חשבון ב-GOTCHA");
    expect(m.text).toBe(
      [
        "התקבלה בקשה לפתוח חשבון GOTCHA עם כתובת האימייל הזו, וכבר יש לך חשבון.",
        "",
        "כניסה: https://app.example.test",
        "",
        "אם הבקשה לא הגיעה ממך, אפשר להתעלם מהמייל הזה.",
      ].join("\n"),
    );
    expect(m.html).toContain("התקבלה בקשה לפתוח חשבון GOTCHA עם כתובת האימייל הזו, וכבר יש לך חשבון.");
    expect(m.html).toContain("אם הבקשה לא הגיעה ממך, אפשר להתעלם מהמייל הזה.");
    expect(m.html).toContain('href="https://app.example.test"');
    expect(m.html).toMatch(/dir="rtl"/);
  });

  it.each([[undefined], [""], ["fr"]])("a language given as %j reads as English", (locale) => {
    expect(signInHintEmail(LINK, locale as any).subject).toBe("You already have a GOTCHA account");
  });

  it("no dash that is not a hyphen, in either language", () => {
    for (const l of ["en", "he"]) {
      const m = signInHintEmail(LINK, l);
      for (const dash of [String.fromCharCode(0x2013), String.fromCharCode(0x2014)]) expect(m.subject + m.text).not.toContain(dash);
    }
  });
});

describe("sending it", () => {
  it("goes to the address, with the app's own address as the link, and is logged under the organization", async () => {
    await sendSignInHintEmail("dana@acme.co.il", "he", "t_old");
    expect(H.sent).toHaveLength(1);
    expect(H.sent[0].to).toBe("dana@acme.co.il");
    expect(H.sent[0].subject).toBe("כבר יש לך חשבון ב-GOTCHA");
    expect(H.sent[0].text).toContain("כניסה: https://app.example.test");
    expect(H.logs).toHaveLength(1);
    expect(H.logs[0]).toMatchObject({
      tenantId: "t_old",
      channel: "email",
      type: "self_signup_sign_in_hint",
      recipient: "dana@acme.co.il",
      status: "sent",
    });
  });

  it("a person in no organization: sent, and no log row (the log is kept per organization)", async () => {
    await sendSignInHintEmail("dana@acme.co.il", "en", null);
    expect(H.sent).toHaveLength(1);
    expect(H.sent[0].subject).toBe("You already have a GOTCHA account");
    expect(H.logs).toEqual([]);
  });

  it("a send that fails is logged as failed and thrown to the caller", async () => {
    H.sendFails = true;
    await expect(sendSignInHintEmail("dana@acme.co.il", "en", "t_old")).rejects.toThrow("smtp down");
    expect(H.logs).toHaveLength(1);
    expect(H.logs[0]).toMatchObject({ status: "failed", error: "smtp down" });
  });
});
