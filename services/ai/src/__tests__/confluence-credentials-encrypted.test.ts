/**
 * Confluence tokens are stored encrypted, like Drive's.
 *
 * The callback wrote `{ accessToken, refreshToken, cloudId }` as a plain JSON
 * object into knowledge_integrations.credentials; Drive in the same file went
 * through encryptCredentials. Now both do. Rows written before this (plain
 * objects) must keep working, and the first token refresh rewrites them
 * encrypted - no migration, no reconnect.
 *
 * Real encryptCredentials/decryptCredentials (not doubled): the point is that
 * what is stored is not readable without the key, and what is read back is.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.CHANNEL_ENCRYPTION_KEY = "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
  process.env.CONFLUENCE_CLIENT_ID = "c-client";
  process.env.CONFLUENCE_CLIENT_SECRET = "c-secret";
});

const DB = vi.hoisted(() => ({ updates: [] as any[] }));
vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: { knowledgeIntegration: { update: async (a: any) => { DB.updates.push(a); return {}; } } },
  };
});
vi.mock("../services/embedding.service", () => ({ upsertSyncedDocument: async () => "created" }));

import { encryptCredentials, decryptCredentials, isEncrypted } from "@chatcenter/shared";
import {
  listSpaces,
  readConfluenceCredentials,
  writeConfluenceCredentials,
} from "../services/confluence.service";

const CREDS = { accessToken: "at_live_secret", refreshToken: "rt_secret", cloudId: "cloud-1", expiresAt: 1 };
const integ = (credentials: any) => ({ id: "ki_1", credentials, knowledgeBaseId: "kb_1", tenantId: "t1" });

beforeEach(() => { DB.updates = []; vi.unstubAllGlobals(); });

describe("the stored form", () => {
  it("★ writeConfluenceCredentials produces ciphertext with no token in it", () => {
    const stored = writeConfluenceCredentials(CREDS);
    expect(typeof stored).toBe("string");
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain("at_live_secret");
    expect(stored).not.toContain("rt_secret");
    expect(decryptCredentials(stored)).toEqual(CREDS);
  });
});

describe("reading - both formats", () => {
  it("decrypts the current (encrypted) format", () => {
    expect(readConfluenceCredentials(encryptCredentials(CREDS))).toEqual(CREDS);
  });

  it("★ still reads a legacy plain-object row", () => {
    expect(readConfluenceCredentials(CREDS)).toEqual(CREDS);
  });

  it("refuses a string that is not ciphertext rather than sending garbage as a token", () => {
    expect(() => readConfluenceCredentials("plain-token")).toThrow(/unreadable/);
  });
});

describe("in use", () => {
  it.each([["encrypted", () => encryptCredentials(CREDS)], ["legacy plain", () => ({ ...CREDS })]])(
    "★ a %s row authenticates with the real token",
    async (_label, make) => {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ results: [{ key: "ENG", name: "Eng" }] }) }));
      vi.stubGlobal("fetch", fetchMock);
      const spaces = await listSpaces(integ(make()) as any);
      expect(spaces).toEqual([{ key: "ENG", name: "Eng" }]);
      const [url, init] = fetchMock.mock.calls[0] as any;
      expect(url).toContain("/ex/confluence/cloud-1/");
      expect(init.headers.Authorization).toBe("Bearer at_live_secret");
    },
  );

  it("★ a refresh on a LEGACY row rewrites it encrypted (the estate converges)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("auth.atlassian.com/oauth/token")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 }) };
      }
      const auth = (fetchMock.mock.calls.at(-1) as any)[1]?.headers?.Authorization;
      return auth === "Bearer at_new"
        ? { ok: true, status: 200, json: async () => ({ results: [] }) }
        : { ok: false, status: 401, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const row = integ({ ...CREDS });
    await listSpaces(row as any);

    // The refresh used the legacy row's refresh token...
    const refreshCall = fetchMock.mock.calls.find((c: any) => String(c[0]).includes("oauth/token")) as any;
    expect(JSON.parse(refreshCall[1].body).refresh_token).toBe("rt_secret");
    // ...and what was written back is ciphertext carrying the new tokens.
    const stored = DB.updates[0].data.credentials;
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain("at_new");
    expect(decryptCredentials(stored)).toMatchObject({ accessToken: "at_new", refreshToken: "rt_new", cloudId: "cloud-1" });
  });
});
