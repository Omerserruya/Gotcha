#!/usr/bin/env node
/**
 * Compile docs/legal/{en,he}/*.md into a committed TypeScript module.
 *
 * Why compile rather than read the markdown at runtime? The legal documents
 * live at the repository root, but the frontend cannot reach them there:
 * `frontend/` is not a workspace of the root package, and the dev container
 * mounts only ./frontend. A page that did `fs.readFile("../../docs/legal")`
 * would work on a laptop and 500 in the container. So the markdown is the
 * single source of truth, and this script projects it into src/ where the app
 * can always see it. The output IS committed, for exactly that reason.
 *
 * Drift is caught two ways: `npm run legal:check` fails if the committed output
 * differs from the markdown, and a unit test asserts the same thing in CI.
 *
 *   node scripts/sync-legal-docs.mjs           write the module
 *   node scripts/sync-legal-docs.mjs --check   exit 1 if it would change
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "..");
const REPO = resolve(FRONTEND, "..");
const DOCS = join(REPO, "docs", "legal");
const REGISTRY = join(FRONTEND, "src", "app", "legal", "content", "registry.ts");
const OUT = join(FRONTEND, "src", "app", "legal", "content", "generated.ts");

const LOCALES = ["en", "he"];

/**
 * Phrases that mean a document is an internal record, not public copy. A
 * document carrying any of these is refused even if the registry marks it
 * public: the retention policy and the RoPA are candid engineering gap
 * registers, and shipping one to the web would publish a list of our own
 * shortcomings. Publishing such a document must involve editing it.
 */
const INTERNAL_MARKERS = [
  "internal document",
  "מסמך פנימי",
  "known gap",
  "this is a known",
  "silently skipped",
  "not guaranteed complete",
];

function fail(message) {
  console.error(`\n  legal-sync: ${message}\n`);
  process.exit(1);
}

/** Public slugs, read from the registry so there is one list, not two. */
function publicSlugs() {
  if (!existsSync(REGISTRY)) fail(`registry not found at ${REGISTRY}`);
  const src = readFileSync(REGISTRY, "utf8");
  const slugs = [];
  // Each entry is an object literal; capture slug + audience within one block.
  const entry = /slug:\s*"([a-z0-9-]+)"\s*,\s*audience:\s*"(public|internal)"/g;
  let m;
  while ((m = entry.exec(src)) !== null) {
    if (m[2] === "public") slugs.push(m[1]);
  }
  if (slugs.length === 0) fail("registry lists no public documents");
  return slugs;
}

/**
 * Turn relative document links into Trust Center routes. The markdown refers to
 * siblings as ./dpa.md because that is what works when read as files; on the
 * web those must be /legal/dpa. A link to a document we do NOT publish would
 * otherwise become a 404, so those are flattened to plain text.
 */
function rewriteLinks(body, published) {
  return body.replace(/\.\/([a-z0-9-]+)\.md/g, (whole, slug) =>
    published.includes(slug) ? `/legal/${slug}` : whole,
  );
}

/**
 * Split a document into prose and table blocks.
 *
 * Markdown tables are a GitHub extension, not CommonMark, and the renderer this
 * app already ships (react-markdown, no remark-gfm) would print them as raw
 * pipes. Three of the five published documents are mostly tables, so rather than
 * add a dependency the tables are parsed here and rendered as real <table>
 * elements by the page. That also lets the wide subprocessor table scroll on a
 * phone instead of overflowing the document.
 */
function toBlocks(markdown) {
  const lines = markdown.split("\n");
  const blocks = [];
  let prose = [];

  const flushProse = () => {
    const text = prose.join("\n").trim();
    if (text) blocks.push({ kind: "markdown", text });
    prose = [];
  };
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const isRow = /^\s*\|/.test(lines[i]);
    const isDivider = i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]);

    if (isRow && isDivider) {
      flushProse();
      const head = cells(lines[i]);
      const rows = [];
      i += 2; // skip header and divider
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      i--; // the outer loop will advance past the last consumed row
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    prose.push(lines[i]);
  }
  flushProse();
  return blocks;
}

/** Bracketed fill-ins such as [full legal name of the operating entity]. */
function findPlaceholders(body) {
  const out = new Set();
  // Negative lookahead for "(" so markdown links are not mistaken for these.
  for (const m of body.matchAll(/\[([^\]\n]{2,90})\](?!\()/g)) out.add(m[1].trim());
  return [...out];
}

function parseDoc(slug, locale, published) {
  const path = join(DOCS, locale, `${slug}.md`);
  if (!existsSync(path)) fail(`missing ${locale}/${slug}.md - every published document needs both languages`);

  const raw = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim();

  const lower = raw.toLowerCase();
  const tripped = INTERNAL_MARKERS.filter((p) => lower.includes(p));
  if (tripped.length > 0) {
    fail(
      `${locale}/${slug}.md is marked public but reads as an internal record ` +
        `(found: ${tripped.join(", ")}).\n` +
        `  Either set audience:"internal" in registry.ts, or rewrite the document for a public audience.`,
    );
  }

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  if (!titleMatch) fail(`${locale}/${slug}.md has no H1 title`);
  const title = titleMatch[1].trim();

  // The H1 becomes the page heading, so it must not repeat inside the body.
  let body = raw.slice(raw.indexOf(titleMatch[0]) + titleMatch[0].length).trim();
  body = rewriteLinks(body, published);

  const dateMatch = raw.match(/(?:Effective date|תאריך תחולה):\s*(.+?)\.?\s*$/m);

  return {
    title,
    effectiveDate: dateMatch ? dateMatch[1].trim() : "",
    placeholders: findPlaceholders(body),
    blocks: toBlocks(body),
  };
}

function build() {
  if (!existsSync(DOCS)) {
    // The dev container mounts only ./frontend, so the markdown genuinely is not
    // there. That is expected and not an error: the committed generated.ts is
    // what the app renders. Only refuse when the caller demanded a real run.
    if (process.argv.includes("--if-available")) {
      console.log("legal-sync: docs/legal not mounted, using the committed generated.ts");
      process.exit(0);
    }
    fail(`docs/legal not found at ${DOCS}`);
  }
  const published = publicSlugs();

  const docs = {};
  for (const slug of published) {
    docs[slug] = {};
    for (const locale of LOCALES) docs[slug][locale] = parseDoc(slug, locale, published);
  }

  const banner = [
    "/**",
    " * GENERATED FILE. Do not edit.",
    " *",
    " * Source of truth: docs/legal/{en,he}/*.md",
    " * Regenerate:     npm run legal:sync   (from frontend/)",
    " * Verify:         npm run legal:check",
    " *",
    " * Committed on purpose: the dev container mounts only ./frontend, so the",
    " * markdown at the repository root is unreachable at runtime.",
    " */",
    "",
    'import type { LegalLocale } from "./types";',
    'export type { LegalLocale } from "./types";',
    "",
    "/** Markdown tables are parsed out so they can render as real tables. */",
    "export type LegalBlock =",
    '  | { kind: "markdown"; text: string }',
    '  | { kind: "table"; head: string[]; rows: string[][] };',
    "",
    "export interface LegalDocText {",
    "  title: string;",
    "  effectiveDate: string;",
    "  /** Unresolved [bracketed] fill-ins still present in the text. */",
    "  placeholders: string[];",
    "  /** Body with the H1 removed and sibling links rewritten to /legal routes. */",
    "  blocks: LegalBlock[];",
    "}",
    "",
    "export const LEGAL_CONTENT: Record<string, Record<LegalLocale, LegalDocText>> =",
  ].join("\n");

  const source = `${banner} ${JSON.stringify(docs, null, 2)};\n`;
  return { source, docs, published };
}

const { source, docs, published } = build();
const checking = process.argv.includes("--check");
const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : null;

if (checking) {
  if (current !== source) {
    fail(
      "generated.ts is out of date with docs/legal.\n" +
        "  Run `npm run legal:sync` in frontend/ and commit the result.",
    );
  }
  console.log(`legal-sync: up to date (${published.length} documents x ${LOCALES.length} locales)`);
} else {
  if (current === source) {
    console.log(`legal-sync: already current (${published.length} documents)`);
  } else {
    writeFileSync(OUT, source, "utf8");
    console.log(`legal-sync: wrote ${published.length} documents x ${LOCALES.length} locales`);
  }
  for (const slug of published) {
    for (const locale of LOCALES) {
      const p = docs[slug][locale].placeholders;
      if (p.length > 0) console.log(`  note: ${locale}/${slug} still has fill-ins: ${p.join(" | ")}`);
    }
  }
}
