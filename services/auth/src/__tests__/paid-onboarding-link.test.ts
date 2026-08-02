/**
 * The link in the paid-onboarding email.
 *
 * This exists because that link shipped pointing at `/onboarding/paid`, a route
 * that was never built, so every paid tenant's admin received an email whose
 * only call to action was a 404. Nothing anywhere asserted the URL, and the
 * string appeared exactly once in the repo, so there was nothing to disagree
 * with it.
 *
 * The test is deliberately about the CONTRACT between three parts that are
 * changed by different people at different times: the email builds a URL, a
 * Next.js route has to exist at that path, and the checkout API needs both a
 * reference and a token to answer. A change to any one of them alone breaks
 * the flow silently, in an email nobody on the team receives.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";

const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "test" }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

vi.mock("@chatcenter/shared", () => ({
  // Durable tenant settings (business hours, auto-greeting, SLA). Exhaustive
  // mocks of this barrel must supply them or the read path throws instead of
  // returning "not configured". Default: nothing configured.
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  // Version pins now live in shared modules, so exhaustive mocks of this
  // barrel must supply them. Returning the real defaults keeps any URL the
  // code builds meaningful instead of "undefined/...".
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  prisma: { notificationLog: { create: vi.fn().mockResolvedValue({}) } },
  publishEvent: vi.fn().mockResolvedValue(undefined),
  ensureIdentity: vi.fn(),
  createRecoveryLink: vi.fn(),
  findIdentityBySubject: vi.fn(),
  // The app's public origin is resolved through shared rather than inlined at
  // each call site, so an exhaustive mock of this barrel has to supply it.
  // Mirrors the real behaviour closely enough for the link assertions below
  // (which set FRONTEND_URL and expect it honoured), without pulling in the
  // production guard that throws when it is unset.
  resolveAppPublicUrl: (env: NodeJS.ProcessEnv = process.env) =>
    (env.FRONTEND_URL || env.DASHBOARD_URL || "http://localhost:3000").replace(/\/+$/, ""),
}));

import { sendPaidOnboardingEmail } from "../services/notification.service";

const ARGS = {
  tenantId: "t1",
  adminEmail: "dana@acme.com",
  adminName: "Dana",
  tenantName: "Acme",
  adminUserId: "u1",
  continuationToken: "QzZMWoLsZ-ztuf7BdZfg867oPLlpHzU5",
  checkoutReference: "chk_abc123",
  linkExpiresAt: new Date("2026-08-01T12:00:00.000Z"),
  planName: "Growth",
  amount: "499",
  currency: "USD",
  includedCredits: 20000,
};

/** Every URL the sent email actually contains. */
function sentUrls(): string[] {
  const call = sendMail.mock.calls.at(-1)?.[0];
  const body = `${call?.html ?? ""}\n${call?.text ?? ""}`;
  return [...body.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
}

function continuationUrl(): URL {
  // Matched on the checkout PATH, not on "token=". The email may now also
  // carry an Authentik setup link, whose query contains `flow_token=` and
  // would satisfy a looser match - picking the credential link and asserting
  // checkout properties against it.
  const found = sentUrls()
    .map((u) => u.replace(/&amp;/g, "&"))
    .find((u) => {
      try {
        return new URL(u).pathname === "/checkout";
      } catch {
        return false;
      }
    });
  if (!found) throw new Error("no continuation URL in the email");
  return new URL(found);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SMTP_HOST = "smtp.test";
  process.env.SMTP_USER = "u";
  process.env.SMTP_PASS = "p";
  process.env.FRONTEND_URL = "https://dev.gotcha.co.il";
});

describe("the paid onboarding link", () => {
  it("points at a route that exists in the frontend app", async () => {
    // The check that would have caught the original bug. Reading the route
    // tree rather than hard-coding the path means renaming the page fails
    // here instead of in somebody's inbox.
    await sendPaidOnboardingEmail({ ...ARGS });

    const url = continuationUrl();
    const appDir = path.resolve(__dirname, "../../../../frontend/src/app");
    const segments = url.pathname.split("/").filter(Boolean);
    const routeDir = path.join(appDir, ...segments);

    expect(
      fs.existsSync(path.join(routeDir, "page.tsx")),
      `email links to ${url.pathname} but ${path.relative(appDir, routeDir)}/page.tsx does not exist`,
    ).toBe(true);
  });

  it("carries BOTH the checkout reference and the token", async () => {
    // The token authorizes action on a checkout the caller already names, so
    // a link with only one of the two lands on a page that cannot ask the
    // server anything.
    await sendPaidOnboardingEmail({ ...ARGS });

    const url = continuationUrl();
    expect(url.searchParams.get("ref")).toBe("chk_abc123");
    expect(url.searchParams.get("token")).toBe(ARGS.continuationToken);
  });

  it("honours FRONTEND_URL", async () => {
    process.env.FRONTEND_URL = "https://app.example.com";
    await sendPaidOnboardingEmail({ ...ARGS });
    expect(continuationUrl().origin).toBe("https://app.example.com");
  });

  it("escapes a token containing URL-significant characters", async () => {
    // Tokens are random base64url today, but a generator change must not
    // silently truncate the query string.
    await sendPaidOnboardingEmail({ ...ARGS, continuationToken: "a+b/c=d&e" });
    expect(continuationUrl().searchParams.get("token")).toBe("a+b/c=d&e");
  });

  it("puts the same link in the HTML and the plain-text part", async () => {
    // A text-only mail client must not get a different destination.
    await sendPaidOnboardingEmail({ ...ARGS });
    const call = sendMail.mock.calls.at(-1)?.[0];
    const inHtml = [...String(call.html).matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/&amp;/g, "&"));
    const inText = [...String(call.text).matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
    const link = inText.find((u) => u.includes("token="));
    expect(link).toBeTruthy();
    expect(inHtml).toContain(link);
  });

  it("never puts the raw token in the notification log", async () => {
    // The log is queryable by support; the token is a bearer credential for
    // a payment.
    const { prisma } = await import("@chatcenter/shared");
    await sendPaidOnboardingEmail({ ...ARGS });
    const logged = JSON.stringify((prisma.notificationLog.create as any).mock.calls.at(-1)?.[0]?.data?.metadata ?? {});
    expect(logged).not.toContain(ARGS.continuationToken);
  });
});
