import type { TranscriptUtterance } from "@chatcenter/shared";

/**
 * Wraps utterances in fenced XML-ish tags. The ONLY way an utterance enters
 * an LLM prompt - see anti-duplication rule #4 in the architecture doc.
 *
 * Customer text is untrusted. The behavior contract block teaches the model
 * to treat `<utt role="customer">` content as data, never as instructions.
 */
export function transcriptFenceBlock(us: TranscriptUtterance[]): string {
  return us
    .map(
      (u) =>
        `<utt role="${u.source}" id="${escapeAttr(u.id)}">${escapeText(u.text)}</utt>`,
    )
    .join("\n");
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
