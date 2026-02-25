import pdfParse from "pdf-parse";
import mammoth from "mammoth";

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/markdown",
  "text/x-markdown",
  "text/plain",
]);

// Map file extensions to MIME types for fallback resolution
const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  md: "text/markdown",
  txt: "text/plain",
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function resolveMimeType(mimeType: string, filename: string): string {
  // If MIME type is recognized, use it
  if (ALLOWED_MIME_TYPES.has(mimeType)) return mimeType;

  // Fallback: resolve by file extension (browsers often send wrong MIME for .md etc.)
  const ext = filename.toLowerCase().split(".").pop() || "";
  return EXT_TO_MIME[ext] || mimeType;
}

export function isAllowedMimeType(mimeType: string): boolean {
  return ALLOWED_MIME_TYPES.has(mimeType);
}

export async function parseFile(buffer: Buffer, mimeType: string): Promise<string> {
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error("File exceeds maximum size of 10MB");
  }

  switch (mimeType) {
    case "application/pdf": {
      const result = await pdfParse(buffer);
      return result.text.trim();
    }

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/msword": {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    }

    case "text/markdown":
    case "text/x-markdown":
    case "text/plain": {
      return buffer.toString("utf-8").trim();
    }

    default:
      throw new Error(`Unsupported file type: ${mimeType}`);
  }
}
