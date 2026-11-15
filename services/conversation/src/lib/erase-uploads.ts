/**
 * The stored files a contact's erasure leaves behind (data-retention-policy,
 * follow-up (a), 2026-11-15): the person's conversations are deleted, but the
 * media files their messages named stayed on the uploads volume.
 *
 * This service owns the volume, so the files are removed here, after the
 * database delete commits. A file is removed only when nothing left in the
 * workspace still names it: one broadcast's media is the same stored file in
 * every recipient's message, and erasing one recipient must not take it from
 * the others. Never throws; what could not be removed is reported by name.
 */
import fs from "fs";
import path from "path";
import { prisma } from "@chatcenter/shared";

const NAME = /\/api\/uploads\/((?:widget\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8})(?:[?#].*)?$/i;

/** The stored upload a URL names ("/api/uploads/<uuid>.<ext>"), or null for anything else. */
export function uploadNameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = NAME.exec(url);
  return m ? m[1]! : null;
}

export function uploadsDir(): string {
  return process.env.UPLOADS_DIR || path.resolve(process.cwd(), "uploads");
}

/** Does anything left in the workspace still name this stored file? */
async function stillNamed(tenantId: string, name: string): Promise<boolean> {
  const like = { contains: name };
  const counts = await Promise.all([
    prisma.message.count({ where: { tenantId, mediaUrl: like } }),
    prisma.scheduledMessage.count({ where: { tenantId, mediaUrl: like } }),
    prisma.broadcast.count({ where: { tenantId, headerMediaUrl: like } }),
    prisma.contact.count({ where: { tenantId, avatarUrl: like } }),
    prisma.conversation.count({ where: { tenantId, customerAvatarUrl: like } }),
  ]);
  return counts.some((n) => n > 0);
}

/**
 * Remove these stored files unless the workspace still names them.
 * `kept`: still named elsewhere; `left`: could not be checked or removed.
 */
export async function removeUnnamedUploads(
  tenantId: string,
  names: string[],
  dir: string = uploadsDir(),
): Promise<{ removed: number; missing: number; kept: string[]; left: string[] }> {
  let removed = 0;
  let missing = 0;
  const kept: string[] = [];
  const left: string[] = [];
  for (const name of Array.from(new Set(names))) {
    try {
      if (await stillNamed(tenantId, name)) { kept.push(name); continue; }
    } catch {
      // Unreadable: keep the file rather than remove one somebody else uses.
      left.push(name);
      continue;
    }
    try {
      fs.unlinkSync(path.join(dir, name));
      removed++;
    } catch (err: any) {
      if (err?.code === "ENOENT") missing++;
      else left.push(name);
    }
  }
  if (left.length) console.error(`[gdpr] contact erasure: uploads NOT removed tenant=${tenantId}: ${JSON.stringify(left)}`);
  return { removed, missing, kept, left };
}
