import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock jose so we test verifyIdToken's own logic (nonce binding, subject,
// audience wiring) without a live JWKS.
const jwtVerify = vi.fn();
vi.mock("jose", () => ({
  createRemoteJWKSet: () => ({}),
  jwtVerify: (...a: any[]) => jwtVerify(...a),
}));

import { verifyIdToken, __resetJwtCaches } from "../jwt";

beforeEach(() => {
  jwtVerify.mockReset();
  __resetJwtCaches();
  process.env.OIDC_ISSUER = "https://auth-dev.gotcha.co.il/application/o/gotcha/";
  process.env.OIDC_JWKS_URI = "http://authentik-server:9000/application/o/gotcha/jwks/";
});

describe("verifyIdToken", () => {
  it("returns the subject/email/name when the nonce matches", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "sub-123", nonce: "N", email: "a@b.co", name: "A" } });
    const v = await verifyIdToken("id.jwt", { nonce: "N", clientId: "gotcha-app" });
    expect(v).toEqual({ subject: "sub-123", email: "a@b.co", name: "A" });
    // audience is wired to the client id.
    expect(jwtVerify.mock.calls[0][2]).toMatchObject({ audience: "gotcha-app", algorithms: ["RS256"] });
  });

  it("throws on a nonce mismatch (replay defence)", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "sub-123", nonce: "OTHER" } });
    await expect(verifyIdToken("id.jwt", { nonce: "N", clientId: "gotcha-app" })).rejects.toThrow(/nonce mismatch/);
  });

  it("throws when the id_token has no subject", async () => {
    jwtVerify.mockResolvedValue({ payload: { nonce: "N" } });
    await expect(verifyIdToken("id.jwt", { nonce: "N", clientId: "gotcha-app" })).rejects.toThrow(/no subject/);
  });

  it("requires a clientId (audience)", async () => {
    await expect(verifyIdToken("id.jwt", { nonce: "N", clientId: "" })).rejects.toThrow(/clientId/);
  });
});
