/**
 * Model text, shown with plain hyphens (Omer, 2026-10-06: "a clear sign of
 * AI"). An em dash becomes " - " between words, an en dash becomes "-" as in
 * a range. For what GOTCHA's models write (summaries, suggestions, drafts,
 * memory, the AI's  own messages) and never for what a customer wrote: their
 * words are theirs. Backend is fixing the source too; this is the display's
 * fallback.
 */
/* By code point: a literal here is the character the guard forbids, and a formatter unescapes `\u`. */
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

export function plainDashes(text: string): string;
export function plainDashes(text: string | null): string | null;
export function plainDashes(text: string | null | undefined): string | null | undefined;
export function plainDashes(text: string | null | undefined): string | null | undefined {
  if (!text || (!text.includes(EM) && !text.includes(EN))) return text;
  return text
    .replace(
      new RegExp(`[ \\t]*${EM}[ \\t]*`, 'g'),
      (match: string, offset: number, whole: string) => {
        const atEdge = offset === 0 || offset + match.length === whole.length;
        // At an edge the dash keeps its own spacing; between words it gets room.
        return atEdge ? match.replace(EM, '-') : ' - ';
      },
    )
    .replaceAll(EN, '-');
}
