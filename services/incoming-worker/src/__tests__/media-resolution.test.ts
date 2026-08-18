import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Turning a WhatsApp media id into a file on disk and a name a human can read.
 *
 * Two separate names are in play and conflating them is a security bug in one
 * direction and a usability bug in the other. The file on disk must be a UUID -
 * the sender picks the other name and it is written straight to a path. The
 * name shown in the inbox must be the sender's - a download called
 * "9f3c1e....pdf" tells the agent nothing about which attachment it is.
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("axios", () => ({ default: { get, post: vi.fn() } }));

const { writeFileSync, mkdirSync } = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock("fs", () => ({ default: { writeFileSync, mkdirSync }, writeFileSync, mkdirSync }));

vi.mock("@chatcenter/shared", () => ({
  // The uploads write probe runs at module load. Stubbed as writable so these
  // tests exercise their own subject rather than the storage check.
  probeUploadsDir: () => ({ ok: true, dir: "/tmp/uploads" }),
  describeUploadsProbe: () => "uploads ok",
  classifyMediaFailure: (err: any) =>
    err?.code === "EACCES" || err?.code === "EPERM" || err?.code === "EROFS"
      ? "storage_unwritable"
      : "download_failed",
  reportOperationalFailure: () => {},
  ERROR_CODES: new Proxy({}, { get: (_t, k) => String(k) }),
  prisma: { tenant: { findUnique: vi.fn() }, message: { findFirst: vi.fn() } },
  createWorker: vi.fn(),
  analyticsQueue: { add: vi.fn() },
  outgoingMessageQueue: { add: vi.fn() },
  publishEvent: vi.fn(),
  decryptCredentials: vi.fn(),
  metaGraphBaseUrl: (legacy?: string) => legacy || "https://graph.facebook.com/v24.0",
  readDurableSetting: async () => null,
  writeDurableSetting: async () => undefined,
  settingCacheKey: (t: string, k: string) => `tenant:${t}:${k}`,
  shopifyApiVersion: () => "2026-07",
  checkShopifyResponseVersion: () => ({ ok: true, served: "2026-07" }),
  stripeVersionHeader: () => ({ "Stripe-Version": "2026-02-25.clover" }),
  resolveContactByChannelId: vi.fn(),
}));
vi.mock("../services/whatsapp-approval-inbound.service", () => ({ handleApprovalButtonReply: vi.fn() }));
vi.mock("../services/comment-trigger.service", () => ({ processCommentTrigger: vi.fn() }));

import { resolveWhatsAppMedia } from "../workers/incoming.worker";

/** Meta's two-step download: metadata call, then the CDN fetch. */
function mockDownload(contentType: string) {
  get.mockReset();
  get.mockImplementation(async (url: string) => {
    if (url.includes("http") && url.includes("cdn")) {
      return { data: Buffer.from("filebytes"), headers: { "content-type": contentType } };
    }
    return { data: { url: "https://cdn.example/file" } };
  });
}

function savedPath() {
  return String(writeFileSync.mock.calls[0][0]);
}

describe("resolveWhatsAppMedia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDownload("application/pdf");
  });

  it("stores under a UUID but reports the sender's name for display", async () => {
    const res = await resolveWhatsAppMedia("MEDIA_1", "tok", "document", {
      fileName: "Invoice 2026-08.pdf",
      mimeType: "application/pdf",
    });

    expect(res!.displayName).toBe("Invoice 2026-08.pdf");
    // Never the sender's name on disk.
    expect(savedPath()).not.toContain("Invoice");
    expect(res!.localUrl).toMatch(/^\/api\/uploads\/[0-9a-f-]+\.pdf$/);
  });

  it("takes the extension from the sender's filename first", async () => {
    // The download's content-type is frequently generic; the filename is not.
    mockDownload("application/octet-stream");

    const res = await resolveWhatsAppMedia("MEDIA_2", "tok", "document", { fileName: "report.xlsx" });

    expect(res!.localUrl.endsWith(".xlsx")).toBe(true);
  });

  it("falls back to the MIME the channel declared", async () => {
    mockDownload("application/octet-stream");

    const res = await resolveWhatsAppMedia("MEDIA_3", "tok", "audio", { mimeType: "audio/ogg; codecs=opus" });

    expect(res!.localUrl.endsWith(".ogg")).toBe(true);
  });

  it("falls back to the download's content-type when nothing was declared", async () => {
    mockDownload("image/png");

    const res = await resolveWhatsAppMedia("MEDIA_4", "tok", "image");

    expect(res!.localUrl.endsWith(".png")).toBe(true);
  });

  it("never lets a sender's filename escape the uploads directory", async () => {
    const res = await resolveWhatsAppMedia("MEDIA_5", "tok", "document", { fileName: "../../etc/passwd" });

    expect(savedPath()).not.toContain("..");
    expect(res!.displayName).not.toContain("/");
  });

  it("returns null rather than throwing when the media is already expired", async () => {
    // Meta drops media after a few days. The message must still persist.
    get.mockReset();
    get.mockRejectedValue(new Error("404 not found"));

    await expect(resolveWhatsAppMedia("GONE", "tok", "image")).resolves.toBeNull();
  });
});
