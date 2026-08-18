import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * The uploads directory: is it actually writable, and if not, say so loudly.
 *
 * ── Why this exists ──
 *
 * `/app/uploads` is a named Docker volume. Docker seeds a volume from the image
 * path it is mounted at, ownership included, but ONLY when the image contains
 * that path. The images did not create it, so Docker created it root-owned
 * while the services run as `node` (uid 1000).
 *
 * Every inbound WhatsApp image, voice note and document then failed at
 * `fs.writeFileSync` with EACCES. The media resolver caught it, returned null,
 * and the agent was told the media was unavailable. Nothing anywhere said
 * "permission denied". A real customer lost every attachment for as long as
 * that lasted, and the logs blamed the download.
 *
 * The bug was cheap. Not being able to SEE the bug was the expensive part, and
 * that is what this module fixes: a storage failure now announces itself at
 * boot, and is never again reported as a download failure.
 */

/** Why a piece of media could not be stored. Persisted on the message. */
export type MediaFailureReason =
  | "download_failed"
  | "storage_unwritable"
  | "storage_full"
  | "no_channel_token";

/**
 * Tell a storage failure apart from a download failure.
 *
 * These two look identical from the call site - both are a thrown error on the
 * path between "customer sent a photo" and "agent can open it" - and they have
 * completely different fixes. One is Meta expiring a media id; the other is an
 * operator needing to chown a directory. Reporting the second as the first sent
 * a real investigation to the wrong place.
 */
export function classifyMediaFailure(err: unknown): MediaFailureReason {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "storage_unwritable";
  if (code === "ENOSPC" || code === "EDQUOT") return "storage_full";
  return "download_failed";
}

export interface UploadsProbe {
  ok: boolean;
  dir: string;
  reason?: MediaFailureReason;
  detail?: string;
}

/**
 * Prove at boot that we can write where media has to go.
 *
 * Writes a real file and deletes it, rather than checking permission bits.
 * `fs.access` and a mode check both get this wrong under the exact conditions
 * that caused the outage: the directory is mode 755 and looks perfectly
 * healthy, and it is the UID mismatch that denies the write. Only a write
 * proves a write.
 *
 * Deliberately does NOT throw. A worker that refuses to start because it cannot
 * store attachments would also stop delivering text messages, which is a much
 * larger outage than the one it is reporting.
 */
export function probeUploadsDir(dir: string): UploadsProbe {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      dir,
      reason: classifyMediaFailure(err),
      detail: (err as Error)?.message,
    };
  }

  const probePath = path.join(dir, `.write-probe-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(probePath, "probe");
    fs.unlinkSync(probePath);
    return { ok: true, dir };
  } catch (err) {
    try {
      fs.unlinkSync(probePath);
    } catch {
      // The probe file may not exist; nothing to clean up.
    }
    return {
      ok: false,
      dir,
      reason: classifyMediaFailure(err),
      detail: (err as Error)?.message,
    };
  }
}

/**
 * The line an operator needs to see, and the one command that fixes it.
 *
 * The remediation is spelled out because the fix is not guessable from the
 * error: rebuilding the image is NOT enough. Docker will not re-seed a volume
 * that already holds files, so a box that has been running keeps the root-owned
 * directory until somebody chowns it once by hand.
 */
export function describeUploadsProbe(probe: UploadsProbe, service: string): string {
  if (probe.ok) return `[${service}] uploads directory is writable (${probe.dir})`;

  if (probe.reason === "storage_unwritable") {
    return (
      `[${service}] CANNOT WRITE TO ${probe.dir} - every inbound image, voice note and ` +
      `document will be lost. The directory is owned by another user (this process runs as ` +
      `uid ${typeof process.getuid === "function" ? process.getuid() : "?"}). ` +
      `Rebuilding the image does NOT fix an existing volume. On the host run: ` +
      `docker compose run --rm --user root ${service} chown -R node:node /app/uploads ` +
      `- then restart. Underlying error: ${probe.detail}`
    );
  }
  if (probe.reason === "storage_full") {
    return `[${service}] NO SPACE LEFT for ${probe.dir} - inbound attachments cannot be stored. ${probe.detail}`;
  }
  return `[${service}] uploads directory ${probe.dir} is not usable: ${probe.detail}`;
}
