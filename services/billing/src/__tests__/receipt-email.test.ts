/**
 * The receipt is ours to send now, which makes three things testable that were
 * previously the payment provider's business: that the designed body actually
 * reaches the queue instead of being re-rendered into a <pre>, that a legal
 * record is not held back by a notification rate limit, and that the Hebrew
 * version is genuinely mirrored rather than Hebrew text in a left-aligned box.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Real email helpers, stubbed prisma: the point is to render the TRUE template
// rather than assert against a mock of it.
//
// Deliberately `importOriginal` and not a deep relative import into
// packages/shared/src. That path compiles here but drags shared's sources into
// this service's TypeScript program, which then fails rootDir - the service
// typechecks its own src, not the monorepo.
vi.mock("@chatcenter/shared", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, prisma: {} };
});

import { sendReceiptEmail, __setEmailQueueForTests, currencyCodeFor } from "../services/receipt-email.service";

type Job = { name: string; data: any; opts: any };
let jobs: Job[] = [];

function queueThatAccepts() {
  return {
    add: async (name: string, data: any, opts: any) => {
      jobs.push({ name, data, opts });
      return { id: "1" };
    },
  } as any;
}

function queueThatRefuses() {
  return {
    add: async () => {
      throw new Error("redis is down");
    },
  } as any;
}

const BASE = {
  to: "buyer@example.com",
  tenantId: "tenant-1",
  billingName: "Acme Ltd",
  billingCountry: "US",
  description: "GOTCHA subscription, monthly renewal",
  net: "3.00",
  vatPercent: 18,
  gross: "3.54",
  currencyId: 5,
  docNumber: "3000",
  docUrl: "https://app.icount.co.il/hash/p_print.php?code=EXAMPLE",
};

beforeEach(() => {
  jobs = [];
  __setEmailQueueForTests(queueThatAccepts());
});

describe("the receipt email", () => {
  it("queues a pre-rendered body, so the designed email survives the pipe", async () => {
    const ok = await sendReceiptEmail(BASE);
    expect(ok).toBe(true);
    expect(jobs).toHaveLength(1);

    const html = jobs[0].data.html as string;
    expect(html).toBeTruthy();
    // The worker only wraps a body in <pre> when it has to render one itself.
    expect(html).not.toContain("<pre");
    expect(html).toContain("You're all set.");
    expect(html).toContain("3.54 ILS");
  });

  it("states the money in the text part too, for clients that refuse HTML", async () => {
    await sendReceiptEmail(BASE);
    expect(jobs[0].data.body).toContain("3.54 ILS");
    expect(jobs[0].data.body).toContain("3000");
    expect(jobs[0].data.subject).toContain("3.54 ILS");
  });

  it("carries the whole breakdown, not just the total", async () => {
    await sendReceiptEmail(BASE);
    const html = jobs[0].data.html as string;
    expect(html).toContain("3.00 ILS");   // subtotal
    expect(html).toContain("0.54 ILS");   // the VAT, derived from gross - net
    expect(html).toContain("VAT (18%)");
  });

  it("is not subject to the notification rate limit", async () => {
    await sendReceiptEmail(BASE);
    // A duplicate receipt is an annoyance. A withheld one is a customer with
    // no proof of payment.
    expect(jobs[0].data.bypassRateLimit).toBe(true);
  });

  it("keys the job by document number, so a retry is the same logical email", async () => {
    await sendReceiptEmail(BASE);
    expect(jobs[0].data.eventId).toBe("receipt:3000");
  });

  it("mirrors for an Israeli billing address", async () => {
    await sendReceiptEmail({ ...BASE, billingCountry: "il" });
    const html = jobs[0].data.html as string;
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("הכל מסודר.");
    expect(html).toContain("מע״מ (18%)");
  });

  it("stays English for a billing address anywhere else", async () => {
    await sendReceiptEmail({ ...BASE, billingCountry: "DE" });
    expect(jobs[0].data.html).toContain('dir="ltr"');
  });

  it("reports a refusing queue rather than throwing at a caller that already took the money", async () => {
    __setEmailQueueForTests(queueThatRefuses());
    const ok = await sendReceiptEmail(BASE);
    // false is what makes the caller fall back to the provider's own send.
    expect(ok).toBe(false);
  });

  it("still sends when no document link came back", async () => {
    const ok = await sendReceiptEmail({ ...BASE, docUrl: null, docNumber: null });
    expect(ok).toBe(true);
    const html = jobs[0].data.html as string;
    // No CTA to offer, but the amount is still the point of the email.
    expect(html).toContain("3.54 ILS");
    expect(jobs[0].data.eventId).toMatch(/^receipt:tenant-1:/);
  });

  it("names the currency it actually charged", () => {
    expect(currencyCodeFor(5)).toBe("ILS");
    expect(currencyCodeFor(2)).toBe("USD");
    // An id we do not recognise must not be labelled with a guess.
    expect(currencyCodeFor(99)).toBe("");
  });
});
