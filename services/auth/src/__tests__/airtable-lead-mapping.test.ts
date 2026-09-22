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
    expect(f["flddUtbE8MeCoRE1J"]).toBe("ליד חדש");
  });

  it("asks Airtable to typecast, so a status it has never seen is created", async () => {
    await send();
    expect(body.typecast).toBe(true);
  });

  it("names the business by its domain, without www", async () => {
    expect((await send({ website: "https://www.shop.co.il/thanks" }))["fldHm0AuBoLT3Q1yg"]).toBe("shop.co.il");
  });

  it("completes a bare host into a real URL", async () => {
    expect((await send({ website: "shop.co.il" }))["fldMiRvyj3GjP5d1V"]).toBe("https://shop.co.il/");
  });

  it("REFUSES an industry label as a website", async () => {
    // The /early-access form's picker, arriving in the same column.
    const f = await send({ website: "אופנה" });
    expect(f["fldMiRvyj3GjP5d1V"]).toBeUndefined();
    // …and the primary column falls back to the person rather than the label.
    expect(f["fldHm0AuBoLT3Q1yg"]).toBe("דני");
  });

  it("refuses anything without a dot in the host", async () => {
    for (const bad of ["localhost", "shop", "  ", "אופנה וטקסטיל"]) {
      expect((await send({ website: bad }))["fldMiRvyj3GjP5d1V"]).toBeUndefined();
    }
  });

  it("carries the contact details a person would actually use", async () => {
    const f = await send();
    expect(f["fldRp9VS2IeeNHwZp"]).toBe("דני");
    expect(f["fldvnWKHrK8XDyEyO"]).toBe("050-1234567");
    expect(f["fldhziOcTa8zJ9pLu"]).toBe("danny@shop.co.il");
    expect(f["fldB2b7KMiVgCM8CY"]).toContain("050-1234567");
    expect(f["fldB2b7KMiVgCM8CY"]).toContain("danny@shop.co.il");
  });

  it("omits an empty email rather than writing a blank", async () => {
    const f = await send({ email: "" });
    expect(f["fldhziOcTa8zJ9pLu"]).toBeUndefined();
    expect(f["fldB2b7KMiVgCM8CY"]).toBe("טלפון: 050-1234567");
  });

  it("records the campaign and says the lead came to us", async () => {
    const f = await send();
    expect(f["fldXmYJIsN9EXKvbD"]).toBe("campaign-one-dollar-offer");
    expect(f["fldZ9xPhI06W636cQ"]).toContain("הם פנו אלינו");
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
