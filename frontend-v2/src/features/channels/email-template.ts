/**
 * An email channel's HTML template (Omer, 2026-10-22): every message the
 * mailbox sends goes out inside it, the message where `{{content}}` stands.
 *
 * Plain functions, so the editor, its preview and its tests read one rule.
 * The server is the authority on all of it (it sanitises, and refuses a
 * template without `{{content}}` or over the limit); these only let the
 * screen say so before a save.
 */

/** The one placeholder a template must carry: where the message goes. */
export const CONTENT_PLACEHOLDER = '{{content}}';

/**
 * The server's own grammar (packages/shared email-template.ts): spaces inside
 * the braces are allowed, names are lower case. `{{ content }}` is a template
 * the server accepts, so the screen must not block it; `{{Content}}` is not.
 */
const CONTENT_RE = /\{\{\s*content\s*\}\}/;
const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Every placeholder the sender fills, in the order the screen lists them. */
export const TEMPLATE_PLACEHOLDERS = [
  'content',
  'agent_name',
  'business_name',
  'customer_name',
] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

/** 100 KB, counted the way the server counts: UTF-8 bytes, not characters. */
export const TEMPLATE_MAX_BYTES = 100 * 1024;

export function templateBytes(html: string): number {
  return new TextEncoder().encode(html).length;
}

export type TemplateProblem = 'empty' | 'noContent' | 'tooLarge';

/** Why this HTML cannot be saved, or `null` when it can. */
export function templateProblem(html: string): TemplateProblem | null {
  if (html.trim() === '') return 'empty';
  if (templateBytes(html) > TEMPLATE_MAX_BYTES) return 'tooLarge';
  if (!CONTENT_RE.test(html)) return 'noContent';
  return null;
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/**
 * The preview's document: the pasted HTML with each placeholder filled.
 *
 * `values` are TEXT (a name typed by a person), so they are escaped here; a
 * placeholder with no value (`customer_name` - there is no customer in a
 * preview) is drawn as a labelled chip instead of an invented name. `content`
 * is the one value that is markup: the screen's own labelled block.
 *
 * The result only ever goes into a sandboxed iframe's `srcdoc` with no
 * permissions, never into this page's DOM.
 */
export function previewDocument(
  html: string,
  {
    content,
    values,
    chip,
  }: {
    /** Markup for `{{content}}`, built by the screen. */
    readonly content: string;
    /** Real values for the placeholders that have one. */
    readonly values: Readonly<Partial<Record<Exclude<TemplatePlaceholder, 'content'>, string>>>;
    /** How a placeholder with no value reads, e.g. `{{customer_name}}` in a chip. */
    readonly chip: (name: string) => string;
  },
): string {
  return html.replace(PLACEHOLDER_RE, (match, name: string) => {
    if (name === 'content') return content;
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) return match;
    const value = values[name as Exclude<TemplatePlaceholder, 'content'>];
    return value ? escapeHtml(value) : chip(name);
  });
}

/** A label for the chip: the placeholder as the author typed it, escaped. */
export function placeholderChip(name: string): string {
  return `<span style="display:inline-block;padding:0 6px;border-radius:4px;background:#eef0f3;color:#454b55;font:12px/1.6 ui-monospace,monospace">{{${escapeHtml(name)}}}</span>`;
}

/**
 * The preview's stand-in for `{{content}}`: the screen's own words in a
 * dashed box, so nobody mistakes it for a message. `label` is text, escaped.
 */
export function previewContentBlock(label: string): string {
  return `<div dir="auto" style="padding:12px 16px;border:1px dashed #9aa1ab;border-radius:6px;color:#454b55;font:14px/1.5 system-ui,sans-serif">${escapeHtml(label)}</div>`;
}

/** Only an HTML file is read into the editor. */
export function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name);
}
