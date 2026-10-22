/**
 * What a stored customer upload may be called, and how it may be served
 * (2026-10-09, uploads plan step 0).
 *
 * A stored file kept the SENDER's extension, so a WhatsApp document named
 * "x.html" became "<uuid>.html" and was served as text/html on the app's own
 * domain: script in it would run with the session of the agent who opened it.
 *
 *   - safeUploadExtension: only an allowlisted extension is ever written to
 *     disk; anything else (html, svg, xml, js, unknown) is stored as ".bin".
 *     The sender's own filename still travels separately for display.
 *   - uploadServingHeaders: every upload is served with nosniff and a sandbox
 *     policy, and only images, audio and video may render inline; everything
 *     else downloads.
 */

/** Extensions an upload may be stored under. Lowercase, with the dot. */
export const SAFE_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  // images (no svg: it is a document that can carry script)
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  // audio
  ".ogg", ".oga", ".opus", ".mp3", ".m4a", ".aac", ".amr", ".wav",
  // video
  ".mp4", ".3gp", ".mov", ".webm",
  // documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".rtf", ".txt", ".csv", ".zip",
]);

/** Extensions a browser may render inline. Everything else is an attachment. */
export const INLINE_UPLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".ogg", ".oga", ".opus", ".mp3", ".m4a", ".aac", ".wav",
  ".mp4", ".mov", ".webm",
]);

/**
 * The stored extension. The first NON-EMPTY candidate decides (the sender's
 * name, then the declared MIME, then the download's content type): kept when
 * it is on the allowlist, ".bin" when it is not. A later, guessed candidate
 * never overrides what the sender said, so "x.html" is ".bin", not a ".pdf"
 * guessed from the message kind. Case and surrounding space do not matter.
 */
export function safeUploadExtension(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const ext = typeof c === "string" ? c.trim().toLowerCase() : "";
    if (ext) return SAFE_UPLOAD_EXTENSIONS.has(ext) ? ext : ".bin";
  }
  return ".bin";
}

/** The headers an upload is served with, by its stored extension. */
export function uploadServingHeaders(extension: string): Record<string, string> {
  const ext = extension.trim().toLowerCase();
  return {
    "X-Content-Type-Options": "nosniff",
    // A sandboxed document runs no script and has no origin, even if a
    // browser were made to render one.
    "Content-Security-Policy": "sandbox",
    ...(INLINE_UPLOAD_EXTENSIONS.has(ext) ? {} : { "Content-Disposition": "attachment" }),
  };
}
