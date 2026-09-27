/**
 * The campaign lead, on its way into Airtable.
 *
 * One column carries two different things, and that is the whole reason this
 * file exists. The endpoint stores the campaign form's WEBSITE and the
 * /early-access form's INDUSTRY picker in the same `company` column, and
 * Airtable's `אתר החברה` is a URL field. `new URL("https://אופנה")` parses
 * perfectly happily, so the naive check would write "fashion" into a URL
 * column and nobody would notice until someone clicked it.
 *
 * No network: the module is only reached with no token configured, so the
 * request is never built. What is asserted is the mapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ORIGINAL = { ...process.env };

async function load() {
  vi.resetModules();
  return import("../services/airtable-lead.service");
}

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("AIRTABLE_LEADS_")) delete process.env[k];
  }
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

const lead = (over: Record<string, unknown> = {}) => ({
  firstName: "דני",
  email: "danny@shop.co.il",
  phone: "050-1234567",
  website: "shop.co.il",
  source: "campaign-one-dollar-offer",
  createdAt: new Date("2026-09-22T09:00:00.000Z"),
  ...over,
});

describe("with nothing configured", () => {
  it("does not reach the network and does not throw", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);
    const { createAirtableLead } = await load();
    await expect(createAirtableLead(lead() as never)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("configured: what actually gets sent", () => {
  let body: any;

  async function send(over: Record<string, unknown> = {}) {
    process.env.AIRTABLE_LEADS_TOKEN = "tok";
    process.env.AIRTABLE_LEADS_BASE_ID = "appTEST";
    process.env.AIRTABLE_LEADS_TABLE_ID = "tblTEST";
    vi.spyOn(globalThis, "fetch" as never).mockImplementation((async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => "" } as never;
    }) as never);
    const { createAirtableLead } = await load();
    await createAirtableLead(lead(over) as never);
    return body.records[0].fields;
  }

  it("arrives as a NEW LEAD, which is what the team sorts on", async () => {
    const f = await send();
    expect(f["fld0KzX63oeGFsJBw"]).toBe("ליד חדש");
  });

  it("asks Airtable to typecast, so a status it has never seen is created", async () => {
    await send();
    expect(body.typecast).toBe(true);
  });

  it("names the business by its domain, without www", async () => {
    expect((await send({ website: "https://www.shop.co.il/thanks" }))["fldAnGljXRu1xA4aQ"]).toBe("shop.co.il");
  });

  it("completes a bare host into a real URL", async () => {
    expect((await send({ website: "shop.co.il" }))["fldKcYLzZZi32LT1U"]).toBe("https://shop.co.il/");
  });

  it("REFUSES an industry label as a website", async () => {
    // The /early-access form's picker, arriving in the same column.
    const f = await send({ website: "אופנה" });
    expect(f["fldKcYLzZZi32LT1U"]).toBeUndefined();
    // …and the primary column falls back to the person rather than the label.
    expect(f["fldAnGljXRu1xA4aQ"]).toBe("דני");
  });

  it("refuses anything without a dot in the host", async () => {
    for (const bad of ["localhost", "shop", "  ", "אופנה וטקסטיל"]) {
      expect((await send({ website: bad }))["fldKcYLzZZi32LT1U"]).toBeUndefined();
    }
  });

  it("carries the contact details into their own typed columns", async () => {
    const f = await send();
    expect(f["fldySEpYt19xUZs7M"]).toBe("דני");
    expect(f["fldwz2dpeb10qlCoO"]).toBe("050-1234567");
    expect(f["fldzaWt13VONYYpJ6"]).toBe("danny@shop.co.il");
  });

  it("omits an empty email rather than writing a blank", async () => {
    const f = await send({ email: "" });
    expect(f["fldzaWt13VONYYpJ6"]).toBeUndefined();
    expect(f["fldeqBqwuYta8Aq1A"]).toContain("טלפון: 050-1234567");
  });

  it("leaves the team's own working columns untouched", async () => {
    // אחראי, משימה, תאריך לביצוע, הביע עניין, סיבת פסילה, תיאור, הערות.
    // A machine has nothing true to say in these the moment a lead arrives.
    const f = await send();
    for (const working of [
      "fld8kHBPGsQoOUk4s",
      "fld2pXAxcwIFUermQ",
      "fldqRNtzbf3S5AiGA",
      "flduBaaawRQiDi9wz",
      "fldpBUogN6qbIgAxz",
      "fldqjeHrTjUtQ3kc8",
      "fldhEzgx4d2q2996X",
    ]) {
      expect(f[working]).toBeUndefined();
    }
  });

  it("records which page the lead came from", async () => {
    const f = await send();
    expect(f["fldhrUOcKtpq0dz7C"]).toBe("campaign-one-dollar-offer");
    expect(f["fldeqBqwuYta8Aq1A"]).toContain("מקור: campaign-one-dollar-offer");
  });

  it("swallows a rejection - a full base must never fail a signup", async () => {
    process.env.AIRTABLE_LEADS_TOKEN = "tok";
    process.env.AIRTABLE_LEADS_BASE_ID = "appTEST";
    process.env.AIRTABLE_LEADS_TABLE_ID = "tblTEST";
    vi.spyOn(globalThis, "fetch" as never).mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => "This base is or will be over its record limits",
    } as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createAirtableLead } = await load();
    await expect(createAirtableLead(lead() as never)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0][0])).toContain("422");
  });
});
