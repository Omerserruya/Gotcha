/**
 * Widget images (W3/W4, 2026-10-14): the logo and the cover a merchant puts on
 * the customer-facing widget, uploaded or fetched from a link, then re-hosted
 * by us so the merchant's site never hotlinks someone else's file.
 *
 * Everything here reads the BYTES, never a name or a declared type: the type
 * comes from the file's signature and the size from its header. No image
 * library (none is allowed in the repo); nothing is resized, so an image over
 * a limit is refused with the limit in the answer.
 *
 * SVG is never accepted: it is a document that can carry script.
 */

export type WidgetImageSlot = "logo" | "cover";
export type WidgetImageType = "png" | "jpeg" | "gif" | "webp";

export const WIDGET_IMAGE_LIMITS: Record<WidgetImageSlot, { maxBytes: number; maxWidth: number; maxHeight: number }> = {
  logo: { maxBytes: 1 * 1024 * 1024, maxWidth: 1024, maxHeight: 1024 },
  cover: { maxBytes: 3 * 1024 * 1024, maxWidth: 2400, maxHeight: 1600 },
};

/** The largest any slot accepts: what a reader may buffer before it knows the slot. */
export const WIDGET_IMAGE_MAX_BYTES = Math.max(...Object.values(WIDGET_IMAGE_LIMITS).map((l) => l.maxBytes));

export const WIDGET_IMAGE_EXTENSION: Record<WidgetImageType, string> = { png: ".png", jpeg: ".jpg", gif: ".gif", webp: ".webp" };

export function isWidgetImageSlot(v: unknown): v is WidgetImageSlot {
  return v === "logo" || v === "cover";
}

export interface ImageFacts {
  type: WidgetImageType;
  width: number;
  height: number;
}

/** The type and size from the file's own header, or null when it is not one of the four. */
export function probeImage(buf: Buffer): ImageFacts | null {
  if (!buf || buf.length < 12) return null;

  // PNG: signature, then the IHDR chunk.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString("latin1", 12, 16) === "IHDR") {
    return sized("png", buf.readUInt32BE(16), buf.readUInt32BE(20));
  }

  // GIF87a / GIF89a: the logical screen size.
  const gif = buf.toString("latin1", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return sized("gif", buf.readUInt16LE(6), buf.readUInt16LE(8));

  // WebP: RIFF....WEBP, then one of three encodings.
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP" && buf.length >= 30) {
    const kind = buf.toString("latin1", 12, 16);
    if (kind === "VP8 ") return sized("webp", buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff);
    if (kind === "VP8L" && buf[20] === 0x2f) {
      const b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
      return sized("webp", 1 + (((b1 & 0x3f) << 8) | buf[21]!), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
    if (kind === "VP8X") return sized("webp", 1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3));
    return null;
  }

  // JPEG: walk the segments to the first frame header (SOF0-SOF15, not DHT/JPG/DAC).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null;
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return sized("jpeg", buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
      }
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

function sized(type: WidgetImageType, width: number, height: number): ImageFacts | null {
  return width > 0 && height > 0 ? { type, width, height } : null;
}

export type WidgetImageRefusal =
  | { code: "IMAGE_TOO_LARGE"; maxBytes: number }
  | { code: "IMAGE_DIMENSIONS_TOO_LARGE"; maxWidth: number; maxHeight: number; width: number; height: number }
  | { code: "NOT_AN_IMAGE" };

/** The file checked against its slot: its facts, or why it is refused. */
export function checkWidgetImage(buf: Buffer, slot: WidgetImageSlot): { ok: true; facts: ImageFacts } | ({ ok: false } & WidgetImageRefusal) {
  const limit = WIDGET_IMAGE_LIMITS[slot];
  if (buf.length > limit.maxBytes) return { ok: false, code: "IMAGE_TOO_LARGE", maxBytes: limit.maxBytes };
  const facts = probeImage(buf);
  if (!facts) return { ok: false, code: "NOT_AN_IMAGE" };
  if (facts.width > limit.maxWidth || facts.height > limit.maxHeight) {
    return { ok: false, code: "IMAGE_DIMENSIONS_TOO_LARGE", maxWidth: limit.maxWidth, maxHeight: limit.maxHeight, width: facts.width, height: facts.height };
  }
  return { ok: true, facts };
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * A Google Drive share link as the direct download of the same file, or the
 * link unchanged when it is not one. Recognised: drive.google.com/file/d/<id>/...,
 * drive.google.com/open?id=<id>, drive.google.com/uc?id=<id>. A file that is not
 * shared publicly answers with a Drive page, which the byte check refuses.
 */
export function driveDirectUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return raw; }
  if (u.hostname !== "drive.google.com") return raw;
  const m = /^\/file\/d\/([^/]+)/.exec(u.pathname);
  const id = m ? m[1]! : (u.pathname === "/open" || u.pathname === "/uc") ? u.searchParams.get("id") ?? "" : "";
  return DRIVE_ID.test(id) ? `https://drive.google.com/uc?export=download&id=${id}` : raw;
}
