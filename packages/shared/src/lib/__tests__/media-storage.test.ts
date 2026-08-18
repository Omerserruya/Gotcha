import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  probeUploadsDir,
  describeUploadsProbe,
  classifyMediaFailure,
} from "../media-storage";

/**
 * The uploads write probe.
 *
 * This module exists because of a real production outage: `/app/uploads` is a
 * Docker named volume, the images never created that path, so Docker created it
 * root-owned while the services run as `node`. Every inbound WhatsApp image,
 * voice note and document failed at writeFileSync with EACCES, the media
 * resolver caught it and returned null, and the agent was told the media was
 * "unavailable". Nothing anywhere said "permission denied".
 *
 * The bug was one line of Dockerfile. Not being able to SEE it was the whole
 * cost, so these tests are about the seeing.
 */

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort; the OS temp dir is cleaned up anyway.
    }
  }
});

function tmpDir(mode?: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-probe-"));
  created.push(dir);
  if (mode !== undefined) fs.chmodSync(dir, mode);
  return dir;
}

describe("the probe proves a write rather than inspecting permissions", () => {
  it("passes on a writable directory and leaves nothing behind", () => {
    const dir = tmpDir();
    const probe = probeUploadsDir(dir);
    expect(probe.ok).toBe(true);
    // The probe file must not survive. An uploads directory slowly filling with
    // probe files across restarts would be a bug introduced by the bug detector.
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("creates the directory when it does not exist yet", () => {
    const dir = path.join(tmpDir(), "nested", "uploads");
    expect(probeUploadsDir(dir).ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("fails on a directory it cannot write to", () => {
    // The production shape: the directory EXISTS and looks healthy. A
    // permission-bit check or an fs.access() would have passed here, which is
    // exactly why the probe writes a real file instead.
    const dir = tmpDir(0o500);
    const probe = probeUploadsDir(dir);

    // Root ignores mode bits entirely, so this assertion is only meaningful
    // as a non-root user. Skipping is honest; asserting `ok === true` would be
    // encoding the wrong expectation into the suite.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      expect(probe.ok).toBe(true);
      return;
    }

    expect(probe.ok).toBe(false);
    expect(probe.reason).toBe("storage_unwritable");
  });
});

describe("a storage failure is never reported as a download failure", () => {
  it.each([
    ["EACCES", "storage_unwritable"],
    ["EPERM", "storage_unwritable"],
    ["EROFS", "storage_unwritable"],
    ["ENOSPC", "storage_full"],
    ["EDQUOT", "storage_full"],
  ])("classifies %s as %s", (code, expected) => {
    // These two look identical from the call site and have completely different
    // fixes: one is Meta expiring a media id, the other is an operator running
    // one chown. Collapsing them sent a real investigation to the wrong place.
    const err = Object.assign(new Error("boom"), { code });
    expect(classifyMediaFailure(err)).toBe(expected);
  });

  it("still calls a genuine network failure a download failure", () => {
    expect(classifyMediaFailure(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe(
      "download_failed",
    );
    expect(classifyMediaFailure(new Error("404"))).toBe("download_failed");
    expect(classifyMediaFailure(undefined)).toBe("download_failed");
  });
});

describe("the operator message carries the fix, not just the fault", () => {
  const failing = {
    ok: false as const,
    dir: "/app/uploads",
    reason: "storage_unwritable" as const,
    detail: "EACCES: permission denied",
  };

  it("names the directory and says what is being lost", () => {
    const msg = describeUploadsProbe(failing, "incoming-worker");
    expect(msg).toContain("/app/uploads");
    expect(msg).toContain("voice note");
  });

  it("says that rebuilding the image is not enough", () => {
    // The single most important sentence. Docker will not re-seed a volume that
    // already holds files, so a deploy alone leaves the box exactly as broken
    // and the operator concludes the fix did not work.
    const msg = describeUploadsProbe(failing, "incoming-worker");
    expect(msg).toContain("does NOT fix an existing volume");
  });

  it("gives the exact command", () => {
    const msg = describeUploadsProbe(failing, "incoming-worker");
    expect(msg).toContain("chown -R node:node /app/uploads");
    expect(msg).toContain("--user root");
  });

  it("stays quiet and factual when everything is fine", () => {
    const msg = describeUploadsProbe({ ok: true, dir: "/app/uploads" }, "conversation");
    expect(msg).toContain("writable");
    expect(msg).not.toContain("CANNOT");
  });
});
