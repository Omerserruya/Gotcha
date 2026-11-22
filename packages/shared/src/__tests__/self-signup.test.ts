/**
 * Self sign-up: the platform settings, the origin mark, and email domains
 * (2026-11-22).
 *
 * What these pin is which way each reader fails:
 *  - the SETTINGS read leniently and closed: anything unreadable is "off" with
 *    the default numbers, so a damaged row never opens sign-up;
 *  - what an OPERATOR sends is read strictly: nothing is clamped;
 *  - the origin MARK is read strictly: a mark that cannot be read is not a
 *    mark, so its organization is never asked for a card by mistake;
 *  - a domain anyone can open a mailbox at is never a domain to join by.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  system: { id: "t_system" } as { id: string } | null,
  tenantLookups: [] as any[],
  rows: {} as Record<string, string>,
  writes: [] as any[],
}));
vi.mock("../lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: async (args: any) => { H.tenantLookups.push(args); return H.system; } },
  },
  withCrossTenantAccess: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../lib/durable-settings", () => ({
  readDurableSetting: async (tenantId: string, key: string) => H.rows[`${tenantId}/${key}`] ?? null,
  writeDurableSetting: async (tenantId: string, key: string, value: string, updatedBy?: string) => {
    H.writes.push({ tenantId, key, value, updatedBy });
    H.rows[`${tenantId}/${key}`] = value;
  },
}));

import {
  SELF_SIGNUP_DEFAULTS, SELF_SIGNUP_BOUNDS, SELF_SIGNUP_SETTINGS_KEY, SELF_SIGNUP_ORIGIN_KEY,
  parseSelfSignupSettings, validateSelfSignupSettings, selfSignupEnvEnabled,
  readSelfSignupSettings, writeSelfSignupSettings, selfSignupState,
  newSelfSignupOrigin, parseSelfSignupOrigin, cardDueAt, cardIsDue,
  emailDomain, isPublicEmailDomain, JOIN_BY_DOMAIN_KEY, parseJoinByDomain,
} from "../lib/self-signup";

const GOOD = { enabled: true, trialDays: 21, cardRequiredAfterDays: 7, trialCredits: 2000 };

beforeEach(() => {
  H.system = { id: "t_system" }; H.tenantLookups = []; H.rows = {}; H.writes = [];
});

describe("the defaults", () => {
  it("are closed, 14 days, a card after 14 days, 5000 credits", () => {
    expect(SELF_SIGNUP_DEFAULTS).toEqual({ enabled: false, trialDays: 14, cardRequiredAfterDays: 14, trialCredits: 5000 });
  });
  it("the bounds the console may offer", () => {
    expect(SELF_SIGNUP_BOUNDS).toEqual({
      trialDays: { min: 1, max: 60 },
      cardRequiredAfterDays: { min: 1, max: 60 },
      trialCredits: { min: 500, max: 20000 },
    });
  });
  it("the platform row and the origin mark never share a key", () => {
    expect(SELF_SIGNUP_SETTINGS_KEY).toBe("selfSignup");
    expect(SELF_SIGNUP_ORIGIN_KEY).toBe("selfSignupOrigin");
  });
});

describe("the stored settings, read leniently and closed", () => {
  it.each([
    ["no row", null],
    ["an empty string", ""],
    ["not JSON", "{enabled"],
    ["a JSON string", '"on"'],
    ["a list", "[true,14,14,5000]"],
    ["null", "null"],
  ])("%s reads as the defaults", (_n, raw) => {
    expect(parseSelfSignupSettings(raw)).toEqual(SELF_SIGNUP_DEFAULTS);
  });

  it("a complete row is read as saved", () => {
    expect(parseSelfSignupSettings(JSON.stringify(GOOD))).toEqual(GOOD);
  });

  it.each([["true"], [1], ["on"], [null], [{}]])("enabled %j is not on", (v) => {
    expect(parseSelfSignupSettings(JSON.stringify({ ...GOOD, enabled: v })).enabled).toBe(false);
  });

  it("a number out of bounds gives that field's default and keeps the rest", () => {
    expect(parseSelfSignupSettings(JSON.stringify({ ...GOOD, trialCredits: 1_000_000 }))).toEqual({ ...GOOD, trialCredits: 5000 });
    expect(parseSelfSignupSettings(JSON.stringify({ ...GOOD, trialDays: 0 }))).toEqual({ ...GOOD, trialDays: 14 });
    expect(parseSelfSignupSettings(JSON.stringify({ ...GOOD, cardRequiredAfterDays: 2.5 }))).toEqual({ ...GOOD, cardRequiredAfterDays: 14 });
    expect(parseSelfSignupSettings(JSON.stringify({ ...GOOD, trialDays: "21" }))).toEqual({ ...GOOD, trialDays: 14 });
  });
});

describe("what an operator sends, read strictly", () => {
  it("a complete body is taken as typed, and nothing else rides along", () => {
    expect(validateSelfSignupSettings({ ...GOOD, envEnabled: true, bounds: {} })).toEqual({ ok: true, value: GOOD });
  });

  it.each([
    ["trialDays", 1], ["trialDays", 60],
    ["cardRequiredAfterDays", 1], ["cardRequiredAfterDays", 60],
    ["trialCredits", 500], ["trialCredits", 20000],
  ])("%s = %d is on the edge and accepted", (field, v) => {
    expect(validateSelfSignupSettings({ ...GOOD, [field]: v })).toEqual({ ok: true, value: { ...GOOD, [field]: v } });
  });

  it.each([
    ["trialDays", 0], ["trialDays", 61],
    ["cardRequiredAfterDays", 0], ["cardRequiredAfterDays", 61],
    ["trialCredits", 499], ["trialCredits", 20001], ["trialCredits", -5000],
  ])("%s = %d is out of range, and is not clamped", (field, v) => {
    expect(validateSelfSignupSettings({ ...GOOD, [field]: v })).toEqual({ ok: false, fields: { [field]: "out_of_range" } });
  });

  it.each([["14"], [14.5], [true], [Number.NaN], [[14]]])("a number sent as %j is invalid", (v) => {
    expect(validateSelfSignupSettings({ ...GOOD, trialDays: v })).toEqual({ ok: false, fields: { trialDays: "invalid" } });
  });

  it.each([["true"], [1], [0]])("enabled sent as %j is invalid", (v) => {
    expect(validateSelfSignupSettings({ ...GOOD, enabled: v })).toEqual({ ok: false, fields: { enabled: "invalid" } });
  });

  it("every missing field is named, so a partial save cannot reset the others", () => {
    expect(validateSelfSignupSettings({ enabled: true })).toEqual({
      ok: false, fields: { trialDays: "required", cardRequiredAfterDays: "required", trialCredits: "required" },
    });
    expect(validateSelfSignupSettings({ trialDays: 14, cardRequiredAfterDays: 14, trialCredits: null })).toEqual({
      ok: false, fields: { enabled: "required", trialCredits: "required" },
    });
  });

  it.each([[null], [undefined], ["x"], [7]])("a body of %j names all four", (body) => {
    const r = validateSelfSignupSettings(body);
    expect(r.ok).toBe(false);
    expect(Object.keys((r as any).fields).sort()).toEqual(["cardRequiredAfterDays", "enabled", "trialCredits", "trialDays"]);
  });
});

describe("the deployment's own switch", () => {
  it.each([["on"], ["ON"], [" on "]])("SELF_SIGNUP=%j is on", (v) => {
    expect(selfSignupEnvEnabled({ SELF_SIGNUP: v })).toBe(true);
  });
  it.each([[undefined], [""], ["off"], ["true"], ["1"], ["yes"], ["only"]])("SELF_SIGNUP=%j is off", (v) => {
    expect(selfSignupEnvEnabled({ SELF_SIGNUP: v })).toBe(false);
  });
});

describe("where the settings live", () => {
  it("on the System organization, found by its slug", async () => {
    H.rows["t_system/selfSignup"] = JSON.stringify(GOOD);
    expect(await readSelfSignupSettings()).toEqual(GOOD);
    expect(H.tenantLookups).toEqual([{ where: { slug: "system" }, select: { id: true } }]);
  });

  it("no row yet: the defaults", async () => {
    expect(await readSelfSignupSettings()).toEqual(SELF_SIGNUP_DEFAULTS);
  });

  it("no System organization: the defaults, and a save says it did not save", async () => {
    H.system = null;
    H.rows["t_system/selfSignup"] = JSON.stringify(GOOD);
    expect(await readSelfSignupSettings()).toEqual(SELF_SIGNUP_DEFAULTS);
    expect(await writeSelfSignupSettings(GOOD, "sa1")).toBe(false);
    expect(H.writes).toEqual([]);
  });

  it("a save writes the four fields under the System organization, with who saved", async () => {
    expect(await writeSelfSignupSettings(GOOD, "sa1")).toBe(true);
    expect(H.writes).toEqual([{ tenantId: "t_system", key: "selfSignup", value: JSON.stringify(GOOD), updatedBy: "sa1" }]);
    expect(await readSelfSignupSettings()).toEqual(GOOD);
  });

  it("another organization's row with the same key is not the platform's", async () => {
    H.rows["t_other/selfSignup"] = JSON.stringify(GOOD);
    expect(await readSelfSignupSettings()).toEqual(SELF_SIGNUP_DEFAULTS);
  });
});

describe("open needs both the deployment and the setting", () => {
  it.each([
    ["on", true, true],
    ["on", false, false],
    ["off", true, false],
    [undefined, true, false],
    [undefined, false, false],
  ])("SELF_SIGNUP=%j, enabled=%j: open=%j", async (env, enabled, open) => {
    H.rows["t_system/selfSignup"] = JSON.stringify({ ...GOOD, enabled });
    const s = await selfSignupState({ SELF_SIGNUP: env as string | undefined });
    expect(s.open).toBe(open);
    expect(s.envEnabled).toBe(env === "on");
    expect(s.trialDays).toBe(21);
  });
});

describe("the origin mark", () => {
  const NOW = new Date("2026-11-22T10:00:00.000Z");
  const mark = newSelfSignupOrigin(GOOD, NOW);

  it("a new mark is the day and the numbers in force on it", () => {
    expect(mark).toEqual({ at: "2026-11-22T10:00:00.000Z", trialDays: 21, cardRequiredAfterDays: 7, trialCredits: 2000 });
  });

  it("reads back the same from a string or from the stored object", () => {
    expect(parseSelfSignupOrigin(JSON.stringify(mark))).toEqual(mark);
    expect(parseSelfSignupOrigin(mark)).toEqual(mark);
  });

  it.each([
    ["nothing", null],
    ["an empty string", ""],
    ["not JSON", "{at"],
    ["a list", [mark]],
    ["no date", { cardRequiredAfterDays: 7 }],
    ["a date that is not a date", { ...mark, at: "yesterday" }],
    ["no days", { at: mark.at }],
    ["zero days", { ...mark, cardRequiredAfterDays: 0 }],
    ["negative days", { ...mark, cardRequiredAfterDays: -3 }],
    ["half a day", { ...mark, cardRequiredAfterDays: 0.5 }],
    ["a day and a half", { ...mark, cardRequiredAfterDays: 1.5 }],
    ["days as text", { ...mark, cardRequiredAfterDays: "7" }],
    ["the platform settings row", GOOD],
  ])("%s is not a mark", (_n, raw) => {
    expect(parseSelfSignupOrigin(raw)).toBeNull();
  });

  it("keeps a card block with a status the sweep may replace", () => {
    for (const priorStatus of ["ACTIVE", "PENDING_ONBOARDING", "PENDING_ADMIN_SETUP"]) {
      const withBlock = { ...mark, cardBlock: { at: "2026-11-29T10:00:00.000Z", priorStatus } };
      expect(parseSelfSignupOrigin(withBlock)?.cardBlock).toEqual({ at: "2026-11-29T10:00:00.000Z", priorStatus });
    }
  });

  it.each([["SUSPENDED"], ["PENDING_PAYMENT"], ["CANCELLED"], [""], [undefined]])(
    "a card block naming %j as the status to put back is dropped",
    (priorStatus) => {
      const parsed = parseSelfSignupOrigin({ ...mark, cardBlock: { at: "2026-11-29T10:00:00.000Z", priorStatus } });
      expect(parsed).not.toBeNull();
      expect(parsed?.cardBlock).toBeUndefined();
    },
  );

  it("keeps when a card last restored it", () => {
    expect(parseSelfSignupOrigin({ ...mark, cardRestoredAt: "2026-12-01T08:00:00.000Z" })?.cardRestoredAt).toBe("2026-12-01T08:00:00.000Z");
  });

  it("a card is due from the exact moment, by the mark's own days", () => {
    expect(cardDueAt(mark).toISOString()).toBe("2026-11-29T10:00:00.000Z");
    expect(cardIsDue(mark, new Date("2026-11-29T09:59:59.999Z"))).toBe(false);
    expect(cardIsDue(mark, new Date("2026-11-29T10:00:00.000Z"))).toBe(true);
    expect(cardIsDue(mark, new Date("2027-01-01T00:00:00.000Z"))).toBe(true);
    expect(cardIsDue(mark, NOW)).toBe(false);
  });

  it("the due moment follows the mark, not today's platform numbers", () => {
    const old = newSelfSignupOrigin({ ...GOOD, cardRequiredAfterDays: 30 }, NOW);
    expect(cardDueAt(old).toISOString()).toBe("2026-12-22T10:00:00.000Z");
  });
});

describe("the domain of an email address", () => {
  it.each([
    ["dana@acme-flowers.co.il", "acme-flowers.co.il"],
    ["Dana@ACME.com", "acme.com"],
    ["dana@mail.acme.com", "mail.acme.com"],
    ["  dana@acme.com ", "acme.com"],
    ["dana@acme.com.", "acme.com"],
    ['"a@b"@acme.com', "acme.com"],
    ["dana+shop@acme.io", "acme.io"],
  ])("%s is %s", (email, domain) => {
    expect(emailDomain(email)).toBe(domain);
  });

  it.each([
    [""], ["dana"], ["dana@"], ["@acme.com"], ["dana@localhost"], ["dana@-acme.com"], ["dana@acme-.com"],
    ["dana@acme..com"], ["dana@acme com"], ["dana@acme.com/x"], ["dana@*.com"], [null], [undefined], [7],
  ])("%j has no domain to join by", (email) => {
    expect(emailDomain(email)).toBeNull();
  });
});

describe("a domain anyone can open a mailbox at", () => {
  it.each([
    ["gmail.com"], ["googlemail.com"], ["outlook.com"], ["outlook.co.il"], ["hotmail.com"], ["hotmail.co.il"], ["hotmail.fr"],
    ["live.com"], ["live.co.uk"], ["yahoo.com"], ["yahoo.co.uk"], ["yahoo.com.au"], ["icloud.com"], ["me.com"],
    ["walla.co.il"], ["walla.com"], ["012.net.il"], ["bezeqint.net"], ["netvision.net.il"], ["zahav.net.il"],
    ["nana10.co.il"], ["proton.me"], ["protonmail.com"], ["aol.com"], ["gmx.de"], ["yandex.ru"], ["mail.ru"],
    ["GMAIL.COM"], [" gmail.com "], ["gmail.com."], ["mail.yahoo.com"], ["smtp.gmail.com"],
  ])("%s is public", (d) => {
    expect(isPublicEmailDomain(d)).toBe(true);
  });

  it.each([
    ["acme.com"], ["acme-flowers.co.il"], ["gotcha.co.il"], ["live.example.com"], ["outlook-partners.com"],
    ["mygmail.com"], ["gmail.acme.com"], ["yahoo.example.org"], ["me.company.com"], ["walla-shop.co.il"],
    ["livenation.com"], ["proton.energy.com"], ["aol.consulting.com"],
  ])("%s is a company's own", (d) => {
    expect(isPublicEmailDomain(d)).toBe(false);
  });

  it.each([[""], [null], [undefined], [7]])("%j is not a domain at all", (d) => {
    expect(isPublicEmailDomain(d)).toBe(false);
  });
});

describe("an organization's join-by-domain setting, read strictly", () => {
  const AT = "2026-11-22T16:00:00.000Z";

  it("lives under its own key", () => {
    expect(JOIN_BY_DOMAIN_KEY).toBe("joinByDomain");
  });

  it("a stored object reads back as it was written", () => {
    expect(parseJoinByDomain({ domain: "acme-flowers.co.il", enabledBy: "u_dana", enabledAt: AT })).toEqual({
      domain: "acme-flowers.co.il", enabledBy: "u_dana", enabledAt: AT,
    });
  });

  it("the cached string form reads the same", () => {
    expect(parseJoinByDomain(JSON.stringify({ domain: "acme-flowers.co.il", enabledBy: "u_dana", enabledAt: AT }))).toEqual({
      domain: "acme-flowers.co.il", enabledBy: "u_dana", enabledAt: AT,
    });
  });

  it.each([["ACME-Flowers.CO.IL"], [" acme-flowers.co.il "], ["acme-flowers.co.il."]])("%j is the same domain, in one form", (domain) => {
    expect(parseJoinByDomain({ domain, enabledBy: "u1", enabledAt: AT })!.domain).toBe("acme-flowers.co.il");
  });

  it.each([["gmail.com"], ["GMAIL.com"], ["walla.co.il"], ["outlook.com"], ["mail.yahoo.com"]])(
    "%s: a public mail domain is never a setting, whoever wrote the row",
    (domain) => {
      expect(parseJoinByDomain({ domain, enabledBy: "u1", enabledAt: AT })).toBeNull();
    },
  );

  it.each([
    [null], [undefined], [""], ["acme-flowers.co.il"], ["{not json"], [7], [true], [[]], [["acme-flowers.co.il"]], [{}],
    [{ domain: "" }], [{ domain: 7 }], [{ domain: null }], [{ domain: "acme" }], [{ domain: "dana@acme-flowers.co.il" }],
    [{ domain: "acme flowers.co.il" }], [{ enabledBy: "u1", enabledAt: AT }],
  ])("%j is no setting", (raw) => {
    expect(parseJoinByDomain(raw)).toBeNull();
  });

  it("who and when are kept only when they are text", () => {
    expect(parseJoinByDomain({ domain: "acme-flowers.co.il" })).toEqual({ domain: "acme-flowers.co.il", enabledBy: null, enabledAt: "" });
    expect(parseJoinByDomain({ domain: "acme-flowers.co.il", enabledBy: 7, enabledAt: 9 })).toEqual({ domain: "acme-flowers.co.il", enabledBy: null, enabledAt: "" });
    expect(parseJoinByDomain({ domain: "acme-flowers.co.il", enabledBy: "", enabledAt: AT })).toEqual({ domain: "acme-flowers.co.il", enabledBy: null, enabledAt: AT });
  });
});
