/**
 * A contact's erasure removes the stored files the person's messages named
 * (data-retention-policy follow-up (a), 2026-11-15), unless the workspace still
 * names them: one broadcast's media is the same file in every recipient's
 * message, and erasing one recipient must not take it from the others.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const H = vi.hoisted(() => ({ named: new Set<string>(), fail: false }));
vi.mock("@chatcenter/shared", () => {
  const counter = (field: string) => ({
    count: async (a: any) => {
      if (H.fail) throw new Error("db down");
      return H.named.has(`${field}:${a.where[field].contains}`) ? 1 : 0;
    },
  });
  return {
    prisma: {
      message: counter("mediaUrl"),
      scheduledMessage: counter("mediaUrl"),
      broadcast: counter("headerMediaUrl"),
      contact: counter("avatarUrl"),
      conversation: counter("customerAvatarUrl"),
    },
  };
});

import { uploadNameOf, removeUnnamedUploads } from "../lib/erase-uploads";

const A = "0f8fad5b-d9cb-469f-a165-70867728950e.jpg";
const B = "7c9e6679-7425-40de-944b-e07fc1f90ae7.pdf";
const SHARED = "6ba7b810-9dad-11d1-80b4-00c04fd430c8.jpg";
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "erase-"));
  for (const f of [A, B, SHARED]) fs.writeFileSync(path.join(dir, f), "x");
  H.named = new Set(); H.fail = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the stored name a URL carries", () => {
  it("our uploads, with or without a host and a query; a widget image; nothing else", () => {
    expect(uploadNameOf(`/api/uploads/${A}`)).toBe(A);
    expect(uploadNameOf(`https://app.gotcha.co.il/api/uploads/${B}?sig=1`)).toBe(B);
    expect(uploadNameOf("/api/uploads/widget/3f2504e0-4f89-11d3-9a0c-0305e82c3301.png")).toBe("widget/3f2504e0-4f89-11d3-9a0c-0305e82c3301.png");
    expect(uploadNameOf("https://pps.whatsapp.net/v/x.jpg")).toBeNull();
    expect(uploadNameOf("/api/uploads/../etc/passwd")).toBeNull();
    expect(uploadNameOf(null)).toBeNull();
  });
});

describe("removing the erased person's files", () => {
  it("removes what nothing else names, keeps a broadcast's file still in other recipients' messages", async () => {
    H.named.add(`mediaUrl:${SHARED}`);
    const r = await removeUnnamedUploads("T", [A, B, SHARED, A], dir);
    expect(r).toMatchObject({ removed: 2, missing: 0, kept: [SHARED], left: [] });
    expect(fs.readdirSync(dir)).toEqual([SHARED]);
  });
  it("still named as an avatar or a broadcast header: kept", async () => {
    H.named.add(`avatarUrl:${A}`);
    H.named.add(`headerMediaUrl:${B}`);
    const r = await removeUnnamedUploads("T", [A, B], dir);
    expect(r.kept.sort()).toEqual([A, B].sort());
    expect(fs.readdirSync(dir).sort()).toEqual([A, B, SHARED].sort());
  });
  it("a file already gone is counted, not an error; an unreadable check keeps the file", async () => {
    fs.unlinkSync(path.join(dir, A));
    expect((await removeUnnamedUploads("T", [A], dir)).missing).toBe(1);
    H.fail = true;
    const r = await removeUnnamedUploads("T", [B], dir);
    expect(r.left).toEqual([B]);
    expect(fs.existsSync(path.join(dir, B))).toBe(true);
  });
});

describe("the erasure route", () => {
  it("reads the names before the delete and removes them after it commits, inside the historical scope", () => {
    const src = readFileSync(join(__dirname, "../routes/gdpr-contacts.ts"), "utf8");
    const collect = src.indexOf("const fileNames = [");
    const tx = src.indexOf("const deleted = await prisma.$transaction(");
    const remove = src.indexOf("const files = await removeUnnamedUploads(req.tenantId!, fileNames);");
    expect(collect).toBeGreaterThan(0);
    expect(tx).toBeGreaterThan(collect);
    expect(remove).toBeGreaterThan(tx);
    expect(src.slice(src.indexOf("const counts = await withHistoricalRecords("), remove)).toContain("withHistoricalRecords");
    expect(src).toContain("uploadsLeftBehind: files.left");
  });
});
