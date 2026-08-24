/**
 * Google Drive as a knowledge source: files, folders, and staying in sync.
 *
 * A folder source is a standing subscription to a subtree, so the cases that
 * matter are not "did the first import work" but everything that happens
 * afterwards: a file appears, a file changes, a file is dragged out, the share
 * is revoked, Google throttles us, the tick and a Sync now button collide.
 *
 * The whole Drive API is faked at the fetch boundary, including pagination and
 * 429s, because those are exactly the behaviours that only show up against real
 * Google and would otherwise only be discovered in production.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.CHANNEL_ENCRYPTION_KEY =
    "248b2b86ff1b58bb208e102890ba28f2dd0c5c7dbc45fb81ae3d28531044ef37";
  process.env.GOOGLE_CLIENT_ID = "client-under-test";
  process.env.GOOGLE_CLIENT_SECRET = "secret-under-test";
  // No real waiting in the retry path.
  process.env.DRIVE_RETRY_BASE_MS = "0";
});

// ─── The fake Drive ─────────────────────────────────────────

interface FakeNode {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  driveId?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  content?: string;
}

const FOLDER = "application/vnd.google-apps.folder";
const GDOC = "application/vnd.google-apps.document";
const GSHEET = "application/vnd.google-apps.spreadsheet";

const drive = {
  nodes: new Map<string, FakeNode>(),
  sharedDrives: [] as Array<{ id: string; name: string }>,
  /** Children returned per page, so every listing exercises nextPageToken. */
  pageSize: 2,
  /** Access tokens Google currently accepts. */
  validTokens: new Set<string>(["at_1"]),
  /** Refresh tokens Google still honours. Empty set models a revoked grant. */
  validRefreshTokens: new Set<string>(["rt_1"]),
  /** Return 429 for this many upcoming list calls before succeeding. */
  throttleCalls: 0,
  calls: [] as string[],
  refreshCount: 0,
};

function addNode(n: Partial<FakeNode> & { id: string; name: string; mimeType: string; parents: string[] }): FakeNode {
  const node: FakeNode = {
    modifiedTime: "2026-01-01T00:00:00.000Z",
    content: `content of ${n.id}`,
    ...n,
  };
  drive.nodes.set(node.id, node);
  return node;
}

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fileResource(n: FakeNode) {
  return {
    id: n.id,
    name: n.name,
    mimeType: n.mimeType,
    modifiedTime: n.modifiedTime,
    size: n.size,
    md5Checksum: n.md5Checksum,
    driveId: n.driveId,
  };
}

async function fakeFetch(input: any, init?: any): Promise<Response> {
  const url = String(input);
  drive.calls.push(url);

  // ── token refresh ──
  if (url === "https://oauth2.googleapis.com/token") {
    drive.refreshCount++;
    const body = new URLSearchParams(String(init?.body || ""));
    const rt = body.get("refresh_token") || "";
    if (!drive.validRefreshTokens.has(rt)) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    const fresh = `at_${drive.validTokens.size + 1}`;
    drive.validTokens.add(fresh);
    return json({ access_token: fresh, expires_in: 3600 });
  }

  const token = String(init?.headers?.Authorization || "").replace("Bearer ", "");
  if (!drive.validTokens.has(token)) return json({ error: "unauthorized" }, 401);

  const parsed = new URL(url);

  // ── shared drives ──
  if (parsed.pathname === "/drive/v3/drives") {
    return json({ drives: drive.sharedDrives });
  }

  // ── list ──
  if (parsed.pathname === "/drive/v3/files") {
    if (drive.throttleCalls > 0) {
      drive.throttleCalls--;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    const q = parsed.searchParams.get("q") || "";
    const parent = /'([^']+)' in parents/.exec(q)?.[1] || "";
    const all = [...drive.nodes.values()].filter((n) => n.parents.includes(parent));
    const offset = Number(parsed.searchParams.get("pageToken") || 0);
    const page = all.slice(offset, offset + drive.pageSize);
    const nextOffset = offset + drive.pageSize;
    return json({
      files: page.map(fileResource),
      nextPageToken: nextOffset < all.length ? String(nextOffset) : undefined,
    });
  }

  // ── export / download / metadata ──
  const exportMatch = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(parsed.pathname);
  if (exportMatch) {
    const node = drive.nodes.get(exportMatch[1]);
    if (!node) return json({ error: "not found" }, 404);
    return new Response(node.content || "");
  }

  const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(parsed.pathname);
  if (fileMatch) {
    const node = drive.nodes.get(fileMatch[1]);
    if (!node) return json({ error: "not found" }, 404);
    if (parsed.searchParams.get("alt") === "media") return new Response(node.content || "");
    return json({ ...fileResource(node), trashed: false });
  }

  return json({ error: `unhandled ${url}` }, 500);
}

// ─── Store doubles ──────────────────────────────────────────

interface StoredDoc {
  id: string;
  tenantId: string;
  knowledgeBaseId: string;
  sourceType: string;
  sourceUrl: string;
  title: string;
  metadata: any;
}

const store = {
  docs: [] as StoredDoc[],
  integrationConfigs: new Map<string, any>(),
  qdrantDeletes: [] as string[],
  audits: [] as any[],
  redis: new Map<string, string>(),
  nextDocId: 1,
};

const mocks = vi.hoisted(() => ({ prismaMock: {} as any }));

vi.mock("@chatcenter/shared", async () => {
  const actual = await vi.importActual<any>("@chatcenter/shared");
  return {
    ...actual,
    prisma: mocks.prismaMock,
    getRedis: () => ({
      // Enough of SET key val EX n NX to model the lock honestly: the second
      // caller must be refused, not queued.
      set: async (k: string, v: string, ..._rest: any[]) => {
        if (store.redis.has(k)) return null;
        store.redis.set(k, v);
        return "OK";
      },
      get: async (k: string) => store.redis.get(k) ?? null,
      del: async (k: string) => (store.redis.delete(k) ? 1 : 0),
    }),
  };
});

vi.mock("../services/qdrant.service", () => ({
  deleteByDocumentId: async (id: string) => { store.qdrantDeletes.push(id); },
}));

vi.mock("../services/audit.service", () => ({
  logAudit: async (event: any) => { store.audits.push(event); },
}));

vi.mock("../services/file-parser.service", () => ({
  parseFile: async (buffer: Buffer) => buffer.toString("utf8"),
}));

vi.mock("../services/embedding.service", () => ({
  upsertSyncedDocument: async (params: any) => {
    const existing = store.docs.find(
      (d) =>
        d.tenantId === params.tenantId &&
        d.knowledgeBaseId === params.knowledgeBaseId &&
        d.sourceUrl === params.sourceUrl,
    );
    const metadata = { ...(params.metadata || {}), syncChangeKey: params.changeKey };
    if (existing) {
      if (existing.metadata.syncChangeKey && existing.metadata.syncChangeKey === params.changeKey) {
        // Still refresh which source claims it, the way a real re-sync would.
        existing.metadata = metadata;
        return "skipped";
      }
      existing.title = params.title;
      existing.metadata = metadata;
      return "updated";
    }
    store.docs.push({
      id: `doc_${store.nextDocId++}`,
      tenantId: params.tenantId,
      knowledgeBaseId: params.knowledgeBaseId,
      sourceType: params.sourceType,
      sourceUrl: params.sourceUrl,
      title: params.title,
      metadata,
    });
    return "created";
  },
}));

import {
  syncIntegration,
  syncFiles,
  listFiles,
  listSharedDrives,
  scanFolder,
  normalizeSources,
  sourceKey,
  removeSourceData,
  isSupportedMimeType,
  DriveSource,
} from "../services/google-drive.service";

// ─── Fixtures ───────────────────────────────────────────────

const TENANT = "tenant_a";
const KB = "kb_1";

function integration(overrides: Partial<any> = {}): any {
  return {
    id: "int_1",
    tenantId: TENANT,
    knowledgeBaseId: KB,
    credentials: { accessToken: "at_1", refreshToken: "rt_1" },
    config: {},
    ...overrides,
  };
}

function withSources(sources: Array<Partial<DriveSource>>, overrides: Partial<any> = {}): any {
  return integration({
    config: {
      sources: sources.map((s) => ({
        key: sourceKey((s.kind as any) || "file", s.id!),
        kind: s.kind || "file",
        name: s.name || s.id,
        ...s,
      })),
    },
    ...overrides,
  });
}

function docTitles(): string[] {
  return store.docs.map((d) => d.title).sort();
}

beforeEach(() => {
  vi.stubGlobal("fetch", fakeFetch as any);

  drive.nodes.clear();
  drive.sharedDrives = [];
  drive.pageSize = 2;
  drive.validTokens = new Set(["at_1"]);
  drive.validRefreshTokens = new Set(["rt_1"]);
  drive.throttleCalls = 0;
  drive.calls = [];
  drive.refreshCount = 0;

  store.docs = [];
  store.integrationConfigs.clear();
  store.qdrantDeletes = [];
  store.audits = [];
  store.redis.clear();
  store.nextDocId = 1;

  mocks.prismaMock.knowledgeIntegration = {
    update: async ({ where, data }: any) => {
      if (data.config) store.integrationConfigs.set(where.id, data.config);
      return { id: where.id, ...data };
    },
    findFirst: async () => null,
  };
  mocks.prismaMock.knowledgeDocument = {
    findMany: async ({ where }: any) =>
      store.docs
        .filter(
          (d) =>
            d.tenantId === where.tenantId &&
            d.knowledgeBaseId === where.knowledgeBaseId &&
            d.sourceType === where.sourceType,
        )
        .map((d) => ({ id: d.id, metadata: d.metadata })),
    delete: async ({ where }: any) => {
      const i = store.docs.findIndex((d) => d.id === where.id);
      if (i >= 0) store.docs.splice(i, 1);
      return {};
    },
  };
});

// ─── 1-2. Files ─────────────────────────────────────────────

describe("selecting files", () => {
  it("imports one file", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });

    const run = await syncIntegration(withSources([{ id: "f1", kind: "file", name: "Handbook" }]));

    expect(run!.counts.imported).toBe(1);
    expect(docTitles()).toEqual(["Handbook"]);
  });

  it("imports several files in one selection", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    addNode({ id: "f2", name: "Pricing", mimeType: "application/pdf", parents: ["root"] });
    addNode({ id: "f3", name: "Notes", mimeType: "text/plain", parents: ["root"] });

    const run = await syncIntegration(
      withSources([
        { id: "f1", kind: "file", name: "Handbook" },
        { id: "f2", kind: "file", name: "Pricing" },
        { id: "f3", kind: "file", name: "Notes" },
      ]),
    );

    expect(run!.counts.imported).toBe(3);
    expect(docTitles()).toEqual(["Handbook", "Notes", "Pricing"]);
  });

  it("does not let a file source be swept up by folder cleanup", async () => {
    // A standalone file carries no folder tag, which is what keeps a folder's
    // reconciliation from claiming (and deleting) it.
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    await syncIntegration(withSources([{ id: "f1", kind: "file" }]));

    expect(store.docs[0].metadata.driveFolderSourceId).toBeNull();
  });
});

// ─── 3-4. Folders ───────────────────────────────────────────

describe("selecting a folder", () => {
  beforeEach(() => {
    addNode({ id: "F", name: "Policies", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "F1", name: "Refunds", mimeType: FOLDER, parents: ["F"] });
    addNode({ id: "F1a", name: "Deep", mimeType: FOLDER, parents: ["F1"] });
    addNode({ id: "a", name: "Top", mimeType: GDOC, parents: ["F"] });
    addNode({ id: "b", name: "Refund policy", mimeType: "application/pdf", parents: ["F1"] });
    addNode({ id: "c", name: "Buried", mimeType: "text/plain", parents: ["F1a"] });
  });

  it("imports every supported file in the folder", async () => {
    const run = await syncIntegration(withSources([{ id: "F", kind: "folder", name: "Policies" }]));
    expect(run!.counts.imported).toBe(3);
  });

  it("walks sub-folders recursively", async () => {
    await syncIntegration(withSources([{ id: "F", kind: "folder" }]));
    expect(docTitles()).toEqual(["Buried", "Refund policy", "Top"]);
  });

  it("tags each document with the folder that claims it", async () => {
    await syncIntegration(withSources([{ id: "F", kind: "folder" }]));
    expect(store.docs.every((d) => d.metadata.driveFolderSourceId === "F")).toBe(true);
  });

  it("records how many files the folder holds", async () => {
    const run = await syncIntegration(withSources([{ id: "F", kind: "folder" }]));
    expect(run!.sources[0].fileCount).toBe(3);
    expect(run!.sources[0].state).toBe("synced");
  });

  it("does not walk the same folder twice when it has two parents", async () => {
    // Drive allows multi-parenting, and the classic failure is an infinite walk.
    const shared = drive.nodes.get("F1")!;
    shared.parents = ["F", "F1a"];

    const run = await syncIntegration(withSources([{ id: "F", kind: "folder" }]));
    expect(run!.counts.imported).toBe(3);
    expect(docTitles()).toEqual(["Buried", "Refund policy", "Top"]);
  });

  it("stops at the configured depth instead of descending forever", async () => {
    process.env.DRIVE_MAX_FOLDER_DEPTH = "1";
    try {
      const run = await syncIntegration(withSources([{ id: "F", kind: "folder" }]));
      // Depth 0 = F, depth 1 = F1. F1a sits one level too deep.
      expect(docTitles()).toEqual(["Refund policy", "Top"]);
      expect(run!.sources[0].state).toBe("partial");
      expect(run!.sources[0].error).toMatch(/deeper than 1/i);
    } finally {
      delete process.env.DRIVE_MAX_FOLDER_DEPTH;
    }
  });

  it("reports the file count when a limit truncates the import", async () => {
    process.env.DRIVE_MAX_FILES_PER_SOURCE = "2";
    try {
      const run = await syncIntegration(withSources([{ id: "F", kind: "folder" }]));
      expect(run!.counts.imported).toBe(2);
      expect(run!.sources[0].error).toMatch(/only the first 2/i);
    } finally {
      delete process.env.DRIVE_MAX_FILES_PER_SOURCE;
    }
  });
});

// ─── 5. Shared Drives ───────────────────────────────────────

describe("Shared Drives", () => {
  it("lists the drives the user can reach", async () => {
    drive.sharedDrives = [{ id: "D1", name: "Company" }, { id: "D2", name: "Legal" }];
    const drives = await listSharedDrives(integration());
    expect(drives.map((d) => d.name)).toEqual(["Company", "Legal"]);
  });

  it("scopes the query to one Shared Drive rather than sweeping all of them", async () => {
    addNode({ id: "SD_F", name: "Contracts", mimeType: FOLDER, parents: ["D1"], driveId: "D1" });
    await listFiles(integration(), undefined, "D1");

    const listCall = drive.calls.find((c) => c.includes("/drive/v3/files?"))!;
    expect(listCall).toContain("driveId=D1");
    expect(listCall).toContain("corpora=drive");
    expect(listCall).toContain("supportsAllDrives=true");
    expect(listCall).toContain("includeItemsFromAllDrives=true");
  });

  it("imports a file the user only has Reader access to inside a Shared Drive", async () => {
    // Reader access is indistinguishable from here: the file lists and reads,
    // and nothing in the sync path ever attempts a write.
    addNode({ id: "sd1", name: "Master agreement", mimeType: "application/pdf", parents: ["D1"], driveId: "D1" });

    const run = await syncIntegration(
      withSources([{ id: "sd1", kind: "file", name: "Master agreement", driveId: "D1" }]),
    );

    expect(run!.counts.imported).toBe(1);
  });

  it("imports a folder inside a Shared Drive, recursively", async () => {
    addNode({ id: "SDF", name: "Contracts", mimeType: FOLDER, parents: ["D1"], driveId: "D1" });
    addNode({ id: "SDF1", name: "2026", mimeType: FOLDER, parents: ["SDF"], driveId: "D1" });
    addNode({ id: "sd1", name: "MSA", mimeType: "application/pdf", parents: ["SDF"], driveId: "D1" });
    addNode({ id: "sd2", name: "SOW", mimeType: "application/pdf", parents: ["SDF1"], driveId: "D1" });

    const run = await syncIntegration(
      withSources([{ id: "SDF", kind: "folder", name: "Contracts", driveId: "D1" }]),
    );

    expect(run!.counts.imported).toBe(2);
    expect(docTitles()).toEqual(["MSA", "SOW"]);
    // Every listing in the walk stayed scoped to the drive.
    const listCalls = drive.calls.filter((c) => c.includes("/drive/v3/files?"));
    expect(listCalls.every((c) => c.includes("driveId=D1"))).toBe(true);
  });
});

// ─── 6-8. Staying in sync ───────────────────────────────────

describe("keeping a folder in sync", () => {
  function seedFolder() {
    addNode({ id: "F", name: "Policies", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "a", name: "Alpha", mimeType: GDOC, parents: ["F"] });
    addNode({ id: "b", name: "Beta", mimeType: GDOC, parents: ["F"] });
  }

  it("picks up a file added after the first sync", async () => {
    seedFolder();
    const int = withSources([{ id: "F", kind: "folder" }]);
    await syncIntegration(int);

    addNode({ id: "c", name: "Gamma", mimeType: GDOC, parents: ["F"] });
    const second = await syncIntegration(int);

    expect(second!.counts.imported).toBe(1);
    expect(second!.counts.skipped).toBe(2);
    expect(docTitles()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("re-processes a file whose content changed", async () => {
    seedFolder();
    const int = withSources([{ id: "F", kind: "folder" }]);
    await syncIntegration(int);

    const node = drive.nodes.get("a")!;
    node.modifiedTime = "2026-06-01T00:00:00.000Z";
    node.name = "Alpha v2";
    const second = await syncIntegration(int);

    expect(second!.counts.updated).toBe(1);
    expect(second!.counts.skipped).toBe(1);
    expect(docTitles()).toEqual(["Alpha v2", "Beta"]);
  });

  it("leaves an unchanged file alone rather than re-embedding it", async () => {
    seedFolder();
    const int = withSources([{ id: "F", kind: "folder" }]);
    await syncIntegration(int);
    const second = await syncIntegration(int);

    expect(second!.counts.skipped).toBe(2);
    expect(second!.counts.updated).toBe(0);
  });

  it("removes the knowledge derived from a deleted file", async () => {
    seedFolder();
    const int = withSources([{ id: "F", kind: "folder" }]);
    await syncIntegration(int);

    drive.nodes.delete("b");
    const second = await syncIntegration(int);

    expect(second!.counts.removed).toBe(1);
    expect(docTitles()).toEqual(["Alpha"]);
    expect(store.qdrantDeletes).toHaveLength(1);
  });

  it("removes the knowledge derived from a file moved out of the folder", async () => {
    // Moved out looks exactly like deleted from the folder's point of view, and
    // must behave the same way, or the AI keeps quoting a document the business
    // deliberately filed elsewhere.
    seedFolder();
    const int = withSources([{ id: "F", kind: "folder" }]);
    await syncIntegration(int);

    drive.nodes.get("b")!.parents = ["root"];
    const second = await syncIntegration(int);

    expect(second!.counts.removed).toBe(1);
    expect(docTitles()).toEqual(["Alpha"]);
  });

  it("never deletes off a truncated listing", async () => {
    // The dangerous case: a limit hides half the folder, and "not seen" must
    // not be read as "deleted".
    seedFolder();
    addNode({ id: "c", name: "Gamma", mimeType: GDOC, parents: ["F"] });
    const int = withSources([{ id: "F", kind: "folder" }]);
    await syncIntegration(int);
    expect(store.docs).toHaveLength(3);

    process.env.DRIVE_MAX_FILES_PER_SOURCE = "1";
    try {
      const second = await syncIntegration(int);
      expect(second!.counts.removed).toBe(0);
      expect(store.docs).toHaveLength(3);
    } finally {
      delete process.env.DRIVE_MAX_FILES_PER_SOURCE;
    }
  });

  it("keeps documents from other folders out of one folder's cleanup", async () => {
    seedFolder();
    addNode({ id: "G", name: "Other", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "z", name: "Zeta", mimeType: GDOC, parents: ["G"] });

    const int = withSources([{ id: "F", kind: "folder" }, { id: "G", kind: "folder" }]);
    await syncIntegration(int);
    expect(store.docs).toHaveLength(3);

    drive.nodes.delete("a");
    const second = await syncIntegration(int);

    expect(second!.counts.removed).toBe(1);
    expect(docTitles()).toEqual(["Beta", "Zeta"]);
  });
});

// ─── 9. Unsupported files ───────────────────────────────────

describe("unsupported content", () => {
  it("skips a file type nothing can read, and says so", async () => {
    addNode({ id: "F", name: "Mixed", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "ok", name: "Readable", mimeType: GDOC, parents: ["F"] });
    addNode({ id: "no", name: "clip.mp4", mimeType: "video/mp4", parents: ["F"] });

    const run = await syncIntegration(withSources([{ id: "F", kind: "folder" }]));

    expect(run!.counts.imported).toBe(1);
    expect(docTitles()).toEqual(["Readable"]);
  });

  it("marks a directly-selected unsupported file rather than failing silently", async () => {
    addNode({ id: "no", name: "clip.mp4", mimeType: "video/mp4", parents: ["root"] });

    const run = await syncIntegration(withSources([{ id: "no", kind: "file" }]));

    expect(run!.counts.unsupported).toBe(1);
    expect(run!.sources[0].state).toBe("partial");
    expect(run!.sources[0].error).toMatch(/not supported/i);
  });

  it("exports Sheets and Slides through formats the pipeline already reads", () => {
    expect(isSupportedMimeType(GSHEET)).toBe(true);
    expect(isSupportedMimeType("application/vnd.google-apps.presentation")).toBe(true);
    expect(isSupportedMimeType("video/mp4")).toBe(false);
  });

  it("imports a Google Sheet as text", async () => {
    addNode({ id: "s1", name: "Price list", mimeType: GSHEET, parents: ["root"], content: "sku,price\na,1" });

    const run = await syncIntegration(withSources([{ id: "s1", kind: "file" }]));

    expect(run!.counts.imported).toBe(1);
    const exportCall = drive.calls.find((c) => c.includes("/export?"))!;
    expect(exportCall).toContain(encodeURIComponent("text/csv"));
  });
});

// ─── 10. Pagination ─────────────────────────────────────────

describe("pagination", () => {
  it("follows nextPageToken to the end of a large folder", async () => {
    addNode({ id: "F", name: "Big", mimeType: FOLDER, parents: ["root"] });
    for (let i = 0; i < 7; i++) {
      addNode({ id: `p${i}`, name: `Doc ${i}`, mimeType: GDOC, parents: ["F"] });
    }
    drive.pageSize = 2;

    const scan = await scanFolder(integration(), "F");

    expect(scan.files).toHaveLength(7);
    expect(scan.truncated).toBe(false);
  });

  it("pages the picker listing too, so a long folder is not silently cut off", async () => {
    for (let i = 0; i < 5; i++) {
      addNode({ id: `r${i}`, name: `Doc ${i}`, mimeType: GDOC, parents: ["root"] });
    }
    const files = await listFiles(integration());
    expect(files).toHaveLength(5);
  });
});

// ─── 11. Rate limits ────────────────────────────────────────

describe("rate limits", () => {
  it("retries a 429 instead of dropping the folder", async () => {
    addNode({ id: "F", name: "Policies", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "a", name: "Alpha", mimeType: GDOC, parents: ["F"] });
    drive.throttleCalls = 3;

    const run = await syncIntegration(withSources([{ id: "F", kind: "folder" }]));

    expect(run!.counts.imported).toBe(1);
    expect(drive.throttleCalls).toBe(0);
  });

  it("gives up after the retry budget rather than looping forever", async () => {
    process.env.DRIVE_MAX_RETRIES = "1";
    try {
      addNode({ id: "F", name: "Policies", mimeType: FOLDER, parents: ["root"] });
      addNode({ id: "a", name: "Alpha", mimeType: GDOC, parents: ["F"] });
      drive.throttleCalls = 50;

      const run = await syncIntegration(withSources([{ id: "F", kind: "folder" }]));

      expect(run!.sources[0].state).toBe("failed");
      // The important half: a failed listing deleted nothing.
      expect(run!.counts.removed).toBe(0);
    } finally {
      delete process.env.DRIVE_MAX_RETRIES;
    }
  });
});

// ─── 12-13. Tokens ──────────────────────────────────────────

describe("tokens", () => {
  it("refreshes an expired access token and carries on", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    drive.validTokens = new Set(); // the stored access token is stale

    const run = await syncIntegration(withSources([{ id: "f1", kind: "file" }]));

    expect(drive.refreshCount).toBe(1);
    expect(run!.counts.imported).toBe(1);
  });

  it("stores the refreshed token encrypted, never as readable JSON", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    drive.validTokens = new Set();

    let written: any;
    mocks.prismaMock.knowledgeIntegration.update = async ({ where, data }: any) => {
      if (data.credentials) written = data.credentials;
      if (data.config) store.integrationConfigs.set(where.id, data.config);
      return {};
    };

    await syncIntegration(withSources([{ id: "f1", kind: "file" }]));

    expect(typeof written).toBe("string");
    expect(written).not.toContain("rt_1");
    const { decryptCredentials } = await vi.importActual<any>("@chatcenter/shared");
    expect(decryptCredentials(written).refreshToken).toBe("rt_1");
  });

  it("reads credentials that were stored encrypted", async () => {
    const { encryptCredentials } = await vi.importActual<any>("@chatcenter/shared");
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });

    const int = withSources([{ id: "f1", kind: "file" }]);
    int.credentials = encryptCredentials({ accessToken: "at_1", refreshToken: "rt_1" });

    const run = await syncIntegration(int);
    expect(run!.counts.imported).toBe(1);
  });

  it("marks a revoked grant as action required and stops trying", async () => {
    addNode({ id: "f1", name: "A", mimeType: GDOC, parents: ["root"] });
    addNode({ id: "f2", name: "B", mimeType: GDOC, parents: ["root"] });
    drive.validTokens = new Set();
    drive.validRefreshTokens = new Set(); // user revoked GOTCHA in their Google account

    const run = await syncIntegration(
      withSources([{ id: "f1", kind: "file" }, { id: "f2", kind: "file" }]),
    );

    expect(run!.sources.every((s) => s.state === "action_required")).toBe(true);
    // One refresh attempt, not one per source and not a retry loop.
    expect(drive.refreshCount).toBe(1);
    // A revoked grant is not evidence that anything was deleted in Drive.
    expect(run!.counts.removed).toBe(0);
  });

  it("leaves already-imported knowledge in place when access is revoked", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    const int = withSources([{ id: "f1", kind: "file" }]);
    await syncIntegration(int);
    expect(store.docs).toHaveLength(1);

    drive.validTokens = new Set();
    drive.validRefreshTokens = new Set();
    await syncIntegration(int);

    expect(store.docs).toHaveLength(1);
  });

  it("treats a source that vanished as action required, not as a reason to delete", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    const int = withSources([{ id: "f1", kind: "file" }]);
    await syncIntegration(int);

    drive.nodes.delete("f1");
    const second = await syncIntegration(int);

    expect(second!.sources[0].state).toBe("action_required");
    expect(store.docs).toHaveLength(1);
  });
});

// ─── 14. Concurrency ────────────────────────────────────────

describe("concurrent runs", () => {
  it("lets one run proceed and refuses the other", async () => {
    addNode({ id: "F", name: "Policies", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "a", name: "Alpha", mimeType: GDOC, parents: ["F"] });

    const int = withSources([{ id: "F", kind: "folder" }]);
    const [first, second] = await Promise.all([syncIntegration(int), syncIntegration(int)]);

    const ran = [first, second].filter(Boolean);
    expect(ran).toHaveLength(1);
    expect(docTitles()).toEqual(["Alpha"]);
  });

  it("releases the lock so the next run is not blocked forever", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    const int = withSources([{ id: "f1", kind: "file" }]);

    await syncIntegration(int);
    const second = await syncIntegration(int);

    expect(second).not.toBeNull();
  });

  it("releases the lock even when the run throws", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    const int = withSources([{ id: "f1", kind: "file" }]);

    mocks.prismaMock.knowledgeIntegration.update = async () => { throw new Error("db down"); };
    await expect(syncIntegration(int)).rejects.toThrow("db down");

    mocks.prismaMock.knowledgeIntegration.update = async () => ({});
    expect(await syncIntegration(int)).not.toBeNull();
  });
});

// ─── 15. Tenant isolation ───────────────────────────────────

describe("tenant isolation", () => {
  it("never reconciles one tenant's documents against another tenant's folder", async () => {
    addNode({ id: "F", name: "Policies", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "a", name: "Alpha", mimeType: GDOC, parents: ["F"] });

    // Same Drive folder id, two different tenants. The ids collide on purpose:
    // that is the shape a cross-tenant deletion bug would take.
    const tenantA = withSources([{ id: "F", kind: "folder" }]);
    const tenantB = withSources([{ id: "F", kind: "folder" }], {
      id: "int_2",
      tenantId: "tenant_b",
      knowledgeBaseId: "kb_2",
    });

    await syncIntegration(tenantA);
    store.redis.clear();
    await syncIntegration(tenantB);
    expect(store.docs).toHaveLength(2);

    drive.nodes.delete("a");
    store.redis.clear();
    const run = await syncIntegration(tenantA);

    expect(run!.counts.removed).toBe(1);
    expect(store.docs).toHaveLength(1);
    expect(store.docs[0].tenantId).toBe("tenant_b");
  });

  it("writes every document under the integration's own tenant", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    await syncIntegration(withSources([{ id: "f1", kind: "file" }], { tenantId: "tenant_b", knowledgeBaseId: "kb_2" }));

    expect(store.docs[0].tenantId).toBe("tenant_b");
    expect(store.docs[0].knowledgeBaseId).toBe("kb_2");
  });
});

// ─── 16. Backwards compatibility ────────────────────────────

describe("integrations connected before folder support", () => {
  it("keeps syncing a legacy fileIds selection with no migration", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    addNode({ id: "f2", name: "Pricing", mimeType: "application/pdf", parents: ["root"] });

    const legacy = integration({ config: { fileIds: ["f1", "f2"], autoSync: true } });
    const run = await syncIntegration(legacy);

    expect(run!.counts.imported).toBe(2);
    expect(docTitles()).toEqual(["Handbook", "Pricing"]);
  });

  it("reads a legacy selection as file sources", () => {
    const sources = normalizeSources({ fileIds: ["f1", "f2"] });
    expect(sources.map((s) => s.key)).toEqual(["file:f1", "file:f2"]);
    expect(sources.every((s) => s.kind === "file")).toBe(true);
  });

  it("prefers the structured list once one exists", () => {
    const sources = normalizeSources({
      fileIds: ["old"],
      sources: [{ key: "folder:F", kind: "folder", id: "F", name: "Policies" }],
    });
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe("F");
  });

  it("still honours the original syncFiles entry point", async () => {
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    const counts = await syncFiles(integration(), ["f1"]);
    expect(counts.imported).toBe(1);
  });

  it("recurses when a legacy id turns out to be a folder, as it always did", async () => {
    addNode({ id: "F", name: "Policies", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "a", name: "Alpha", mimeType: GDOC, parents: ["F"] });

    const counts = await syncFiles(integration(), ["F"]);
    expect(counts.imported).toBe(1);
  });
});

// ─── 17-18. Disconnect ──────────────────────────────────────

describe("disconnecting", () => {
  async function seedTwoSources() {
    addNode({ id: "F", name: "Policies", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "a", name: "Alpha", mimeType: GDOC, parents: ["F"] });
    addNode({ id: "f1", name: "Handbook", mimeType: GDOC, parents: ["root"] });
    const int = withSources([{ id: "F", kind: "folder" }, { id: "f1", kind: "file" }]);
    await syncIntegration(int);
    return int;
  }

  it("keeps imported knowledge when only the sync is stopped", async () => {
    const int = await seedTwoSources();
    // Removing the integration row is what the route does; no document call.
    expect(store.docs).toHaveLength(2);
    expect(await removeSourceData(int, () => false)).toBe(0);
    expect(store.docs).toHaveLength(2);
  });

  it("removes everything the integration imported when asked to", async () => {
    const int = await seedTwoSources();
    const removed = await removeSourceData(int, () => true);

    expect(removed).toBe(2);
    expect(store.docs).toHaveLength(0);
    expect(store.qdrantDeletes).toHaveLength(2);
  });

  it("removes only the folder's documents when one source is dropped", async () => {
    const int = await seedTwoSources();
    const removed = await removeSourceData(int, (meta) => meta.driveFolderSourceId === "F");

    expect(removed).toBe(1);
    expect(docTitles()).toEqual(["Handbook"]);
  });

  it("never reaches another integration's documents", async () => {
    const int = await seedTwoSources();
    store.docs.push({
      id: "doc_other",
      tenantId: TENANT,
      knowledgeBaseId: KB,
      sourceType: "google_drive",
      sourceUrl: "https://drive.google.com/file/d/other",
      title: "Someone else's",
      metadata: { integrationId: "int_999", driveFileId: "other" },
    });

    await removeSourceData(int, () => true);
    expect(docTitles()).toEqual(["Someone else's"]);
  });
});

// ─── Paused sources and audit ───────────────────────────────

describe("pausing", () => {
  it("skips a paused source without touching its documents", async () => {
    addNode({ id: "F", name: "Policies", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "a", name: "Alpha", mimeType: GDOC, parents: ["F"] });

    const int = withSources([{ id: "F", kind: "folder" }]);
    await syncIntegration(int);

    int.config.sources[0].paused = true;
    drive.nodes.delete("a");
    const second = await syncIntegration(int);

    expect(second!.sources).toHaveLength(0);
    expect(store.docs).toHaveLength(1);
  });
});

describe("the audit trail", () => {
  it("records the run without copying customer file names into it", async () => {
    addNode({ id: "F", name: "Quarterly revenue", mimeType: FOLDER, parents: ["root"] });
    addNode({ id: "a", name: "Salaries 2026", mimeType: GDOC, parents: ["F"] });

    await syncIntegration(withSources([{ id: "F", kind: "folder" }]), { actorId: "user_1" });

    expect(store.audits).toHaveLength(1);
    const entry = store.audits[0];
    expect(entry.tenantId).toBe(TENANT);
    expect(entry.action).toBe("knowledge.drive.sync");
    expect(entry.metadata.totals.imported).toBe(1);

    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain("Salaries 2026");
    expect(serialised).not.toContain("Quarterly revenue");
    expect(serialised).not.toContain("at_1");
    expect(serialised).not.toContain("rt_1");
  });
});
