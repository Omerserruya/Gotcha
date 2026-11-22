/**
 * One read of a WhatsApp number, with Meta's reason kept (2026-11-22).
 *
 * The case behind it: a business removed GOTCHA from its WhatsApp account at
 * Meta. The token stayed valid, every number read came back
 *   "Unsupported get request. Object with ID '...' does not exist, cannot be
 *    loaded due to missing permissions, or does not support this operation."
 * (code 100, subcode 33) and the channel went on saying CONNECTED.
 *
 * `refused` is that one answer and nothing else: a timeout, a 5xx, a rate
 * limit or an expired token says nothing about whether the number is ours.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ gets: [] as any[], answer: null as any, error: null as any }));
vi.mock("axios", () => ({
  default: {
    get: async (url: string, opts: any) => {
      H.gets.push({ url, opts });
      if (H.error) throw H.error;
      return { data: H.answer };
    },
  },
}));

import { readWhatsAppNumber, whatsappNumberDetails } from "../lib/whatsapp-number-details";

const metaError = (error: Record<string, unknown>, status = 400) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error } } });
const REFUSED_MESSAGE =
  "Unsupported get request. Object with ID '1010938148762991' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api";
const REFUSED = { message: REFUSED_MESSAGE, type: "GraphMethodException", code: 100, error_subcode: 33, fbtrace_id: "A1" };

beforeEach(() => {
  H.gets = []; H.answer = null; H.error = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("readWhatsAppNumber", () => {
  it("a good read: the three details, read with the caller's own token", async () => {
    H.answer = { id: "1010938148762991", display_phone_number: "+972 52-540-1686", verified_name: "GOTCHA Demo", quality_rating: "GREEN" };
    expect(await readWhatsAppNumber("1010938148762991", "tok")).toEqual({
      ok: true,
      details: { displayPhoneNumber: "+972 52-540-1686", verifiedName: "GOTCHA Demo", qualityRating: "GREEN" },
    });
    expect(H.gets).toHaveLength(1);
    expect(H.gets[0].url.endsWith("/1010938148762991")).toBe(true);
    expect(H.gets[0].opts).toEqual({ params: { fields: "display_phone_number,verified_name,quality_rating" }, headers: { Authorization: "Bearer tok" } });
  });

  it("a good read with none of the three is still a good read", async () => {
    H.answer = { id: "1010938148762991" };
    expect(await readWhatsAppNumber("1010938148762991", "tok")).toEqual({ ok: true, details: null });
  });

  it("★ Meta 100/33 is refused, with Meta's own sentence kept", async () => {
    H.error = metaError(REFUSED);
    expect(await readWhatsAppNumber("1010938148762991", "tok")).toEqual({ ok: false, refused: true, message: REFUSED_MESSAGE });
  });

  it("100/33 sent as strings is the same answer", async () => {
    H.error = metaError({ ...REFUSED, code: "100", error_subcode: "33" });
    expect(await readWhatsAppNumber("1010938148762991", "tok")).toMatchObject({ ok: false, refused: true });
  });

  it.each([
    ["an expired token (190)", metaError({ message: "Error validating access token: Session has expired", type: "OAuthException", code: 190, error_subcode: 463 }, 401)],
    ["a rate limit (4)", metaError({ message: "(#4) Application request limit reached", type: "OAuthException", code: 4 })],
    ["a rate limit on the account (80008)", metaError({ message: "There have been too many calls to this WhatsApp Business account", code: 80008 })],
    ["code 100 with no subcode (a bad parameter)", metaError({ message: "(#100) Tried accessing nonexisting field (foo)", type: "OAuthException", code: 100 })],
    ["code 100 with another subcode", metaError({ message: "Invalid parameter", code: 100, error_subcode: 2494010 })],
    ["subcode 33 under another code", metaError({ message: "Permissions error", code: 10, error_subcode: 33 })],
    ["Meta's own outage (code 2)", metaError({ message: "An unexpected error has occurred. Please retry your request later.", code: 2 }, 500)],
    ["an unknown error (code 1)", metaError({ message: "An unknown error occurred", code: 1 }, 500)],
    ["a 502 with an HTML body", Object.assign(new Error("Request failed with status code 502"), { response: { status: 502, data: "<html>Bad Gateway</html>" } })],
    ["a timeout", Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" })],
    ["no network", Object.assign(new Error("getaddrinfo EAI_AGAIN graph.facebook.com"), { code: "EAI_AGAIN" })],
    ["a thrown string", "boom"],
  ])("%s is a failure but NOT refused", async (_name, error) => {
    H.error = error;
    const out = await readWhatsAppNumber("1010938148762991", "tok");
    expect(out).toMatchObject({ ok: false, refused: false });
    expect(typeof (out as any).message).toBe("string");
  });

  it("the failure is logged with the number's id and Meta's sentence, never the token", async () => {
    H.error = metaError(REFUSED);
    await readWhatsAppNumber("1010938148762991", "tok_secret");
    const logged = JSON.stringify((console.warn as any).mock.calls);
    expect(logged).toContain("[whatsapp-number] could not read number 1010938148762991:");
    expect(logged).toContain("Unsupported get request");
    expect(logged).not.toContain("tok_secret");
  });
});

describe("whatsappNumberDetails reads as it always did", () => {
  it("details on a good read", async () => {
    H.answer = { display_phone_number: "+972 52-540-1686" };
    expect(await whatsappNumberDetails("1010938148762991", "tok")).toEqual({ displayPhoneNumber: "+972 52-540-1686" });
  });
  it("null when nothing came back, and null on any failure, refused or not", async () => {
    H.answer = {};
    expect(await whatsappNumberDetails("1010938148762991", "tok")).toBeNull();
    H.error = metaError(REFUSED);
    expect(await whatsappNumberDetails("1010938148762991", "tok")).toBeNull();
    H.error = new Error("timeout");
    expect(await whatsappNumberDetails("1010938148762991", "tok")).toBeNull();
  });
});
