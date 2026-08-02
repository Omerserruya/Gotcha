/**
 * Which legal documents the public Trust Center exposes, and in what order.
 *
 * This registry is the ONE place that decides publication. `docs/legal` holds
 * eight documents, but three of them are internal accountability records that
 * happen to live in the same folder:
 *
 *   - ropa.md                        GDPR Art. 30 register, for the supervisory
 *                                    authority on request, not for the web.
 *   - data-retention-policy.md       A candid engineering gap register ("this is
 *   - data-subject-rights-procedure  a known gap", backup topology, which purges
 *                                    are unenforced). Publishing it would hand a
 *                                    reader a list of our own shortcomings and
 *                                    contradict the Privacy Policy.
 *
 * The public obligation those two would nominally serve is already discharged by
 * the Privacy Policy, which carries its own Retention and Your Rights sections.
 *
 * Flipping `audience` to "public" is all it takes to publish one, but the
 * generator (scripts/sync-legal-docs.mjs) will refuse to emit a public document
 * that still contains internal-only markers. That refusal is deliberate: the
 * decision to publish should require editing the document, not just a flag.
 */

export type LegalAudience = "public" | "internal";

export interface LegalDocMeta {
  /** URL segment under /legal, and the docs/legal basename without .md. */
  slug: string;
  audience: LegalAudience;
  /** Line art on the hub card. */
  icon: "scroll" | "shield" | "cookie" | "handshake" | "server";
  /** One-line description on the hub, [en, he]. Not taken from the document. */
  summary: [string, string];
}

/** Order here is the order on the hub. Most-asked-for first. */
export const LEGAL_DOCS: LegalDocMeta[] = [
  {
    slug: "terms-of-service",
    audience: "public",
    icon: "scroll",
    summary: [
      "The agreement that governs your use of GOTCHA, including plans, billing, and termination.",
      "ההסכם המסדיר את השימוש שלכם ב-GOTCHA, לרבות תוכניות, חיוב וסיום התקשרות.",
    ],
  },
  {
    slug: "privacy-policy",
    audience: "public",
    icon: "shield",
    summary: [
      "What personal data we collect, why we process it, how long we keep it, and the rights you can exercise.",
      "איזה מידע אישי אנו אוספים, מדוע אנו מעבדים אותו, כמה זמן הוא נשמר ואילו זכויות עומדות לכם.",
    ],
  },
  {
    slug: "cookie-policy",
    audience: "public",
    icon: "cookie",
    summary: [
      "The cookies and similar technologies the site and the product use, and how to control them.",
      "העוגיות והטכנולוגיות הדומות שבהן משתמשים האתר והמוצר, וכיצד לשלוט בהן.",
    ],
  },
  {
    slug: "dpa",
    audience: "public",
    icon: "handshake",
    summary: [
      "Our Data Processing Agreement: the terms under which we process personal data on your behalf as your processor.",
      "הסכם עיבוד הנתונים שלנו: התנאים שלפיהם אנו מעבדים מידע אישי בשמכם כמעבד מטעמכם.",
    ],
  },
  {
    slug: "subprocessors",
    audience: "public",
    icon: "server",
    summary: [
      "Every third-party provider that may process customer personal data on our behalf, and what each one does.",
      "כל ספק צד שלישי שעשוי לעבד מידע אישי של לקוחות בשמנו, ותפקידו של כל אחד מהם.",
    ],
  },

  // ── Internal. Present so the set is auditable, never rendered. ──
  { slug: "ropa", audience: "internal", icon: "server", summary: ["", ""] },
  { slug: "data-retention-policy", audience: "internal", icon: "server", summary: ["", ""] },
  { slug: "data-subject-rights-procedure", audience: "internal", icon: "server", summary: ["", ""] },
];

export const PUBLIC_LEGAL_DOCS = LEGAL_DOCS.filter((d) => d.audience === "public");

export function legalDocMeta(slug: string): LegalDocMeta | undefined {
  return LEGAL_DOCS.find((d) => d.slug === slug);
}

export function isPublicLegalDoc(slug: string): boolean {
  return legalDocMeta(slug)?.audience === "public";
}
