import { describe, it, expect, vi } from "vitest";

// The worker imports @chatcenter/shared (prisma/createWorker/crypto). We only
// exercise the pure token-exchange helper here, so stub the shared surface it
// pulls in at module load.
vi.mock("@chatcenter/shared", () => ({
  prisma: { channelAccount: { findMany: vi.fn(), update: vi.fn() } },
  createWorker: vi.fn(),
  channelHealthQueue: { add: vi.fn() },
  decryptCredentials: (x: unknown) => x,
  encryptCredentials: (x: unknown) => x,
}));

import { refreshOutlookAccessToken } from "../workers/channel-health.worker";

const CREDS = {
  refreshToken: "rt-abc",
  clientId: "client-1",
  clientSecret: "secret-1",
  tenantIdAzure: "tenant-xyz",
};

describe("refreshOutlookAccessToken", () => {
  it("returns null when refresh credentials are incomplete (no silent bad call)", async () => {
    const post = vi.fn();
    expect(await refreshOutlookAccessToken({}, post)).toBeNull();
    expect(await refreshOutlookAccessToken({ refreshToken: "x" }, post)).toBeNull();
    expect(await refreshOutlookAccessToken({ refreshToken: "x", clientId: "c" }, post)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("posts the refresh_token grant to the account's Azure tenant with the Graph scopes", async () => {
    const post = vi.fn().mockResolvedValue({ data: { access_token: "at-new", expires_in: 3600 } });
    const result = await refreshOutlookAccessToken(CREDS, post);

    expect(result).toEqual({ accessToken: "at-new", refreshToken: undefined, expiresIn: 3600 });
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe("https://login.microsoftonline.com/tenant-xyz/oauth2/v2.0/token");
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=rt-abc");
    expect(body).toContain("client_id=client-1");
    // scope must include offline_access so the next refresh token keeps coming.
    expect(decodeURIComponent(body)).toContain("offline_access");
    expect((config as any).headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });

  it("falls back to the 'common' tenant when none is stored", async () => {
    const post = vi.fn().mockResolvedValue({ data: { access_token: "at", expires_in: 100 } });
    await refreshOutlookAccessToken({ refreshToken: "r", clientId: "c", clientSecret: "s" }, post);
    expect(post.mock.calls[0][0]).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
  });

  it("captures a rotated refresh token and defaults expiry to 3600s", async () => {
    const post = vi.fn().mockResolvedValue({ data: { access_token: "at2", refresh_token: "rt-rotated" } });
    const result = await refreshOutlookAccessToken(CREDS, post);
    expect(result).toEqual({ accessToken: "at2", refreshToken: "rt-rotated", expiresIn: 3600 });
  });

  it("returns null when the token endpoint yields no access_token (treated as failure upstream)", async () => {
    const post = vi.fn().mockResolvedValue({ data: { error: "invalid_grant" } });
    expect(await refreshOutlookAccessToken(CREDS, post)).toBeNull();
  });
});
