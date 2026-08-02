/**
 * The Trust Center publishes contracts, so the failure modes worth testing are
 * not layout ones. They are:
 *
 *   1. an internal record reaching the public web,
 *   2. the rendered text drifting from the markdown legal actually maintains,
 *   3. a document existing in one language but not the other.
 *
 * Each of those is silent in a browser and expensive in real life, so each gets
 * a test here rather than a code review.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { LEGAL_CONTENT } from "../content/generated";
import { LEGAL_DOCS, PUBLIC_LEGAL_DOCS, isPublicLegalDoc } from "../content/registry";
import { LEGAL_LOCALES } from "../content/types";

const FRONTEND = resolve(__dirname, "..", "..", "..", "..");
const DOCS = resolve(FRONTEND, "..", "docs", "legal");

const INTERNAL_SLUGS = ["ropa", "data-retention-policy", "data-subject-rights-procedure"];

describe("what the Trust Center publishes", () => {
  it("publishes exactly the documents the registry marks public", () => {
    expect(Object.keys(LEGAL_CONTENT).sort()).toEqual(PUBLIC_LEGAL_DOCS.map((d) => d.slug).sort());
  });

  it("never ships the internal accountability records", () => {
    for (const slug of INTERNAL_SLUGS) {
      expect(isPublicLegalDoc(slug), `${slug} must stay internal`).toBe(false);
      expect(LEGAL_CONTENT[slug], `${slug} must have no compiled content`).toBeUndefined();
    }
  });

  it("keeps every document in the registry accounted for, public or not", () => {
    // A document added to docs/legal but never registered would be invisible to
    // this whole safety net, so the registry must list all eight.
    if (!existsSync(DOCS)) return;
    const onDisk = execFileSync("ls", [join(DOCS, "en")], { encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(LEGAL_DOCS.map((d) => d.slug).sort()).toEqual(onDisk);
  });

  it("carries no internal-only language in anything published", () => {
    const tells = ["known gap", "internal document", "silently skipped", "מסמך פנימי"];
    for (const [slug, locales] of Object.entries(LEGAL_CONTENT)) {
      for (const locale of LEGAL_LOCALES) {
        const text = JSON.stringify(locales[locale]).toLowerCase();
        for (const tell of tells) {
          expect(text.includes(tell), `${locale}/${slug} contains "${tell}"`).toBe(false);
        }
      }
    }
  });
});

describe("both languages", () => {
  it("has every published document in Hebrew and English", () => {
    for (const doc of PUBLIC_LEGAL_DOCS) {
      for (const locale of LEGAL_LOCALES) {
        const d = LEGAL_CONTENT[doc.slug]?.[locale];
        expect(d, `${locale}/${doc.slug} missing`).toBeTruthy();
        expect(d.title.length, `${locale}/${doc.slug} has no title`).toBeGreaterThan(0);
        expect(d.blocks.length, `${locale}/${doc.slug} has no body`).toBeGreaterThan(0);
      }
    }
  });

  it("gives both languages the same structure, so neither is a stub", () => {
    for (const doc of PUBLIC_LEGAL_DOCS) {
      const en = LEGAL_CONTENT[doc.slug].en;
      const he = LEGAL_CONTENT[doc.slug].he;
      const tables = (d: typeof en) => d.blocks.filter((b) => b.kind === "table").length;
      expect(tables(he), `${doc.slug}: table count differs between languages`).toBe(tables(en));
    }
  });

  it("tells English readers that the Hebrew version governs", () => {
    for (const doc of PUBLIC_LEGAL_DOCS) {
      const en = JSON.stringify(LEGAL_CONTENT[doc.slug].en);
      expect(en.includes("Hebrew version"), `${doc.slug} (en) has no prevailing-language notice`).toBe(true);
    }
  });
});

describe("rendering-shape guarantees", () => {
  it("parses markdown tables out, so no raw pipes reach the page", () => {
    // react-markdown here has no remark-gfm, so a table left in the prose would
    // render as literal "| Provider | Purpose |" text.
    for (const [slug, locales] of Object.entries(LEGAL_CONTENT)) {
      for (const locale of LEGAL_LOCALES) {
        for (const block of locales[locale].blocks) {
          if (block.kind !== "markdown") continue;
          const rowish = block.text.split("\n").filter((l) => /^\s*\|.*\|\s*$/.test(l));
          expect(rowish, `${locale}/${slug} left a table in prose`).toEqual([]);
        }
      }
    }
  });

  it("gives tables a header for every column in every row", () => {
    for (const [slug, locales] of Object.entries(LEGAL_CONTENT)) {
      for (const locale of LEGAL_LOCALES) {
        for (const block of locales[locale].blocks) {
          if (block.kind !== "table") continue;
          expect(block.head.length).toBeGreaterThan(0);
          for (const row of block.rows) {
            expect(row.length, `${locale}/${slug}: ragged table row`).toBe(block.head.length);
          }
        }
      }
    }
  });

  it("rewrites sibling document links to Trust Center routes", () => {
    // The markdown links siblings as ./dpa.md, which 404s on the web.
    for (const [slug, locales] of Object.entries(LEGAL_CONTENT)) {
      for (const locale of LEGAL_LOCALES) {
        const text = JSON.stringify(locales[locale]);
        for (const published of PUBLIC_LEGAL_DOCS) {
          expect(
            text.includes(`./${published.slug}.md`),
            `${locale}/${slug} still links to ./${published.slug}.md`,
          ).toBe(false);
        }
      }
    }
  });

  it("ships no unresolved fill-ins in any published document", () => {
    // The terms once carried [full legal name of the operating entity] and
    // [number]; both are now filled. A bracketed placeholder reaching a
    // published contract is the defect this guards against, and the draft
    // banner is the fallback if one ever does.
    for (const [slug, locales] of Object.entries(LEGAL_CONTENT)) {
      for (const locale of LEGAL_LOCALES) {
        expect(
          locales[locale].placeholders,
          `${locale}/${slug} has unresolved fill-ins`,
        ).toEqual([]);
      }
    }
  });

  it("identifies the contracting entity in the terms, in both languages", () => {
    // Who you are contracting with is the one fact a terms page must state.
    const terms = LEGAL_CONTENT["terms-of-service"];
    expect(JSON.stringify(terms.en)).toContain("GOTCHA by Omer Serruya");
    expect(JSON.stringify(terms.he)).toContain("עומר צרויה");
    for (const locale of LEGAL_LOCALES) {
      expect(JSON.stringify(terms[locale]), `${locale} terms omit the registration number`).toContain(
        "322570243",
      );
    }
  });
});

describe("the generated module against the markdown", () => {
  it("is byte-identical to a fresh generation", () => {
    if (!existsSync(DOCS)) {
      throw new Error(
        `docs/legal not found at ${DOCS}. This test verifies the committed ` +
          `content still matches the markdown, and cannot do that without it.`,
      );
    }
    const before = readFileSync(join(FRONTEND, "src/app/legal/content/generated.ts"), "utf8");
    // --check exits non-zero and prints a fix hint when they differ.
    execFileSync("node", [join(FRONTEND, "scripts/sync-legal-docs.mjs"), "--check"], {
      cwd: FRONTEND,
      encoding: "utf8",
    });
    const after = readFileSync(join(FRONTEND, "src/app/legal/content/generated.ts"), "utf8");
    expect(after).toBe(before);
  });

  it("takes its text verbatim from docs/legal", () => {
    if (!existsSync(DOCS)) return;
    // Spot-check a sentence that only exists in the source markdown.
    const source = readFileSync(join(DOCS, "en", "subprocessors.md"), "utf8");
    const line = source.split("\n").find((l) => l.startsWith("| Amazon Web Services"));
    expect(line).toBeTruthy();
    const table = LEGAL_CONTENT["subprocessors"].en.blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" && table.rows[0][0]).toBe("Amazon Web Services (AWS)");
  });
});
