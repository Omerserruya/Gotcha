/**
 * The Google Drive knowledge routes.
 *
 * Everything here is about the contract at the edge rather than the sync
 * itself: what the consent URL asks Google for, what a client is allowed to
 * post, whether one tenant can reach another's integration, and the one that
 * costs a customer real data if it defaults wrong - what "Disconnect" deletes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.hoisted(() => {
  process.env.CHANNEL_ENCRYPTION_KEY =
    "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
  process.env.GOOGLE_CLIENT_ID = "client-under-test";
  process.env.GOOGLE_CLIENT_SECRET = "secret-under-test";
  process.env.GOOGLE_REDIRECT_URI = "https://dev.example.test/api/knowledge/oauth/google-drive/callback";
  process.env.APP_PUBLIC_URL = "https://dev.example.test";
});

const state = {
  integrations: [] as any[],
  updates: [] as any[],
  deletes: [] as string[],
  syncCalls: [] as any[],
  removeCalls: [] as any[],
  /** Next syncIntegration return; null models the lock being held. */
  syncResult: null as any,
  removedCount: 0,
};

const mocks = vi.hoisted(() => ({ prismaMock: {} as any }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: mocks.prismaMock,
    authenticate: (req: any, _res: any, next: any) => { req.userId = "user_1"; next(); },
    resolveTenant: (req: any, _res: any, next: any) => {
      req.tenantId = req.headers["x-test-tenant"] || "tenant_a";
      next();
    },
    requireActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requireOnboardingOrActiveTenant: () => (_req: any, _res: any, next: any) => next(),
    requireRole: () => (_req: any, _res: any, next: any) => next(),
    mintOAuthState: () => ({ state: "st_1", jti: "st_1" }),
  };
});

vi.mock("../services/google-drive.service", async () => {
  const actual = await vi.importActual<any>("../services/google-drive.service");
  return {
    ...actual,
    syncIntegration: async (integration: any, opts: any) => {
      state.syncCalls.push({ id: integration.id, opts });
      return state.syncResult;
    },
    removeSourceData: async (integration: any, predicate: any) => {
      state.removeCalls.push({ id: integration.id, predicate });
      return state.removedCount;
    },
  };
});

import knowledgeOAuthRouter from "../routes/knowledge-oauth";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/knowledge", knowledgeOAuthRouter);
  return a;
}

function driveIntegration(overrides: Partial<any> = {}): any {
  return {
    id: "int_1",
    tenantId: "tenant_a",
    knowledgeBaseId: "kb_1",
    provider: "google_drive",
    credentials: { accessToken: "at_1", refreshToken: "rt_1" },
    config: {},
    ...overrides,
  };
}

beforeEach(() => {
  state.integrations = [driveIntegration()];
  state.updates = [];
  state.deletes = [];
  state.syncCalls = [];
  state.removeCalls = [];
  state.removedCount = 0;
  state.syncResult = {
    counts: { imported: 1, updated: 0, skipped: 0, removed: 0, failed: 0, unsupported: 0 },
    sources: [{ key: "folder:F", state: "synced", counts: {} }],
  };

  mocks.prismaMock.knowledgeIntegration = {
    findFirst: async ({ where }: any) =>
      state.integrations.find(
        (i) =>
          (!where.id || i.id === where.id) &&
          (!where.tenantId || i.tenantId === where.tenantId) &&
          (!where.provider || i.provider === where.provider) &&
          (!where.knowledgeBaseId || i.knowledgeBaseId === where.knowledgeBaseId),
      ) || null,
    update: async ({ where, data }: any) => {
      state.updates.push({ id: where.id, data });
      const row = state.integrations.find((i) => i.id === where.id);
      if (row && data.config) row.config = data.config;
      return row;
    },
    delete: async ({ where }: any) => { state.deletes.push(where.id); return {}; },
    create: async ({ data }: any) => data,
  };
  mocks.prismaMock.knowledgeBase = { findFirst: async () => ({ id: "kb_1" }) };
});

// ─── Consent URL ────────────────────────────────────────────

async function consentUrl(query = ""): Promise<URL> {
  const res = await request(app()).get(`/api/knowledge/oauth/google-drive/init?kbId=kb_1${query}`);
  expect(res.status).toBe(200);
  return new URL(res.body.url);
}

describe("the Drive consent URL", () => {
  it("asks for drive.readonly and nothing else", async () => {
    state.integrations = [];
    const url = await consentUrl();
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.readonly");
  });

  it("never asks for drive.file", async () => {
    // drive.file is per-file and granted at pick time, so it cannot reach a
    // file added to the folder tomorrow. Requesting it alongside readonly would
    // add a permission that buys nothing.
    state.integrations = [];
    const scope = (await consentUrl()).searchParams.get("scope")!;
    expect(scope).not.toContain("drive.file");
    expect(scope.split(" ")).toHaveLength(1);
  });

  it("requests offline access so the folder can keep syncing", async () => {
    state.integrations = [];
    expect((await consentUrl()).searchParams.get("access_type")).toBe("offline");
  });

  it("forces consent on a first connect, because that is the only way to get a refresh token", async () => {
    state.integrations = [];
    expect((await consentUrl()).searchParams.get("prompt")).toBe("consent");
  });

  it("stays quiet when a usable refresh token is already stored", async () => {
    expect((await consentUrl()).searchParams.get("prompt")).toBeNull();
  });

  it("forces consent again on an explicit reconnect", async () => {
    expect((await consentUrl("&reconnect=1")).searchParams.get("prompt")).toBe("consent");
  });

  it("forces consent when the stored credentials have no refresh token", async () => {
    state.integrations = [driveIntegration({ credentials: { accessToken: "at_1" } })];
    expect((await consentUrl()).searchParams.get("prompt")).toBe("consent");
  });

  it("reads an encrypted credential blob rather than treating it as a first connect", async () => {
    const { encryptCredentials } = await vi.importActual<any>("@chatcenter/shared");
    state.integrations = [
      driveIntegration({ credentials: encryptCredentials({ accessToken: "at_1", refreshToken: "rt_1" }) }),
    ];
    expect((await consentUrl()).searchParams.get("prompt")).toBeNull();
  });
});

// ─── Importing a selection ──────────────────────────────────

describe("POST /drive/sync", () => {
  it("accepts a folder selection", async () => {
    const res = await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync")
      .send({ sources: [{ id: "F", kind: "folder", name: "Policies" }] });

    expect(res.status).toBe(200);
    expect(state.syncCalls[0].opts.onlyKeys).toEqual(["folder:F"]);
    const saved = state.updates[0].data.config.sources;
    expect(saved).toEqual([
      expect.objectContaining({ key: "folder:F", kind: "folder", id: "F", name: "Policies" }),
    ]);
  });

  it("accepts several files at once", async () => {
    const res = await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync")
      .send({ sources: [{ id: "a", kind: "file" }, { id: "b", kind: "file" }] });

    expect(res.status).toBe(200);
    expect(state.syncCalls[0].opts.onlyKeys).toEqual(["file:a", "file:b"]);
  });

  it("refuses a batch that mixes a folder with loose files", async () => {
    // Ambiguous about what the folder's cleanup owns. Two imports, not a guess.
    const res = await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync")
      .send({ sources: [{ id: "F", kind: "folder" }, { id: "a", kind: "file" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/separately/i);
    expect(state.syncCalls).toHaveLength(0);
  });

  it("still accepts the pre-folder fileIds body", async () => {
    const res = await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync")
      .send({ fileIds: ["a", "b"] });

    expect(res.status).toBe(200);
    expect(state.syncCalls[0].opts.onlyKeys).toEqual(["file:a", "file:b"]);
  });

  it("ignores a sync state posted by the client", async () => {
    // Otherwise a browser could hand itself a green "Synced" badge for a folder
    // that was never read.
    await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync")
      .send({ sources: [{ id: "F", kind: "folder", syncState: "synced", lastError: null }] });

    expect(state.updates[0].data.config.sources[0].syncState).toBeUndefined();
  });

  it("keeps the state of sources that were already connected", async () => {
    state.integrations = [
      driveIntegration({
        config: {
          sources: [
            { key: "folder:OLD", kind: "folder", id: "OLD", name: "Old", syncState: "synced", paused: true },
          ],
        },
      }),
    ];

    await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync")
      .send({ sources: [{ id: "F", kind: "folder", name: "New" }] });

    const saved = state.updates[0].data.config.sources;
    expect(saved).toHaveLength(2);
    expect(saved.find((s: any) => s.id === "OLD")).toMatchObject({ syncState: "synced", paused: true });
  });

  it("reports a busy source instead of starting a second walk", async () => {
    state.syncResult = null;
    const res = await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync")
      .send({ sources: [{ id: "F", kind: "folder" }] });

    expect(res.status).toBe(409);
  });

  it("rejects an empty selection", async () => {
    const res = await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync")
      .send({ sources: [] });
    expect(res.status).toBe(400);
  });

  it("does not reach another tenant's integration", async () => {
    const res = await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync")
      .set("x-test-tenant", "tenant_b")
      .send({ sources: [{ id: "F", kind: "folder" }] });

    expect(res.status).toBe(404);
    expect(state.syncCalls).toHaveLength(0);
  });
});

// ─── Sync now, pause, sources ───────────────────────────────

describe("managing a connected source", () => {
  beforeEach(() => {
    state.integrations = [
      driveIntegration({
        config: {
          sources: [
            { key: "folder:F", kind: "folder", id: "F", name: "Policies", syncState: "synced", fileCount: 12 },
          ],
        },
      }),
    ];
  });

  it("lists the connected sources with their status", async () => {
    const res = await request(app()).get("/api/knowledge/integrations/int_1/drive/sources");
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ key: "folder:F", syncState: "synced", fileCount: 12 });
  });

  it("runs Sync now for one source", async () => {
    const res = await request(app())
      .post("/api/knowledge/integrations/int_1/drive/sync-now")
      .send({ sourceKey: "folder:F" });

    expect(res.status).toBe(200);
    expect(state.syncCalls[0].opts.onlyKeys).toEqual(["folder:F"]);
  });

  it("runs Sync now for everything when no source is named", async () => {
    await request(app()).post("/api/knowledge/integrations/int_1/drive/sync-now").send({});
    expect(state.syncCalls[0].opts.onlyKeys).toBeUndefined();
  });

  it("pauses a source", async () => {
    const res = await request(app())
      .patch("/api/knowledge/integrations/int_1/drive/sources/folder%3AF")
      .send({ paused: true });

    expect(res.status).toBe(200);
    expect(state.updates[0].data.config.sources[0]).toMatchObject({ paused: true, syncState: "paused" });
  });

  it("resumes a source", async () => {
    await request(app())
      .patch("/api/knowledge/integrations/int_1/drive/sources/folder%3AF")
      .send({ paused: false });

    expect(state.updates[0].data.config.sources[0]).toMatchObject({ paused: false, syncState: "pending" });
  });

  it("does not pause another tenant's source", async () => {
    const res = await request(app())
      .patch("/api/knowledge/integrations/int_1/drive/sources/folder%3AF")
      .set("x-test-tenant", "tenant_b")
      .send({ paused: true });

    expect(res.status).toBe(404);
    expect(state.updates).toHaveLength(0);
  });

  it("removes a source and keeps its documents by default", async () => {
    const res = await request(app()).delete("/api/knowledge/integrations/int_1/drive/sources/folder%3AF");

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(0);
    expect(state.removeCalls).toHaveLength(0);
    expect(state.updates[0].data.config.sources).toEqual([]);
  });

  it("removes a source and its documents when asked", async () => {
    state.removedCount = 12;
    const res = await request(app()).delete(
      "/api/knowledge/integrations/int_1/drive/sources/folder%3AF?removeData=1",
    );

    expect(res.body.data.removed).toBe(12);
    // The predicate must scope to this folder, not to everything.
    const { predicate } = state.removeCalls[0];
    expect(predicate({ driveFolderSourceId: "F" })).toBe(true);
    expect(predicate({ driveFolderSourceId: "OTHER" })).toBe(false);
    expect(predicate({ driveFileId: "loose" })).toBe(false);
  });
});

// ─── Disconnect ─────────────────────────────────────────────

describe("DELETE /integrations/:intId", () => {
  it("keeps the imported knowledge by default", async () => {
    const res = await request(app()).delete("/api/knowledge/integrations/int_1");

    expect(res.status).toBe(200);
    expect(state.removeCalls).toHaveLength(0);
    expect(state.deletes).toEqual(["int_1"]);
  });

  it("removes the imported knowledge only when explicitly asked", async () => {
    state.removedCount = 7;
    const res = await request(app()).delete("/api/knowledge/integrations/int_1?removeData=1");

    expect(res.body.data.removed).toBe(7);
    expect(state.removeCalls).toHaveLength(1);
    expect(state.deletes).toEqual(["int_1"]);
  });

  it("does not disconnect another tenant's integration", async () => {
    const res = await request(app())
      .delete("/api/knowledge/integrations/int_1?removeData=1")
      .set("x-test-tenant", "tenant_b");

    expect(res.status).toBe(404);
    expect(state.deletes).toEqual([]);
    expect(state.removeCalls).toHaveLength(0);
  });
});

// ─── Token exposure ─────────────────────────────────────────

describe("token handling", () => {
  it("never returns credentials in the integrations listing", async () => {
    const listed: any[] = [];
    mocks.prismaMock.knowledgeIntegration.findMany = async ({ select }: any) => {
      // The route's own projection is the guard; assert it does not ask for
      // credentials in the first place.
      expect(select.credentials).toBeUndefined();
      return listed;
    };

    const res = await request(app()).get("/api/knowledge/kb/kb_1/integrations");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("rt_1");
  });

  it("keeps credentials out of the source listing", async () => {
    state.integrations = [
      driveIntegration({ config: { sources: [{ key: "file:a", kind: "file", id: "a", name: "A" }] } }),
    ];
    const res = await request(app()).get("/api/knowledge/integrations/int_1/drive/sources");
    expect(JSON.stringify(res.body)).not.toContain("rt_1");
    expect(JSON.stringify(res.body)).not.toContain("at_1");
  });
});
