/**
 * Which legal documents the public Trust Center exposes, and in what order.
 *
 * This registry is the ONE place that decides publication. `docs/legal` holds
 * nine documents; three of them are internal accountability records that happen
 * to live in the same folder - the Art. 30 register and two candid engineering
 * gap registers. Publishing one of those would hand a reader a list of our own
 * shortcomings and contradict the Privacy Policy.
 *
 * Flipping `audience` to "public" is not enough on its own: tools/build-legal.mjs
 * refuses to emit a public document that still reads as an internal record. That
 * refusal is deliberate - the decision to publish should require editing the
 * document, not just a flag.
 *
 * Summaries are written for the hub, not lifted from the documents, so the card
 * says what the reader will get rather than repeating the first line.
 */

/** @typedef {"public" | "internal"} LegalAudience */

/** Order here is the order on the hub. Most-asked-for first. */
export const LEGAL_DOCS = [
  {
    slug: 'terms-of-service',
    audience: 'public',
    icon: 'scroll',
    summary: [
      'The agreement that governs your use of GOTCHA, including plans, billing, and termination.',
      'ההסכם המסדיר את השימוש שלכם ב-GOTCHA, לרבות תוכניות, חיוב וסיום התקשרות.',
    ],
  },
  {
    // Directly after the Terms because it is the commercial half of the same
    // question: the Terms say what you are buying, this says what happens when
    // you stop. People look for it at cancellation time, which is the worst
    // moment to have to hunt for a policy.
    slug: 'cancellation-refunds',
    audience: 'public',
    icon: 'scroll',
    summary: [
      'How subscriptions renew and cancel, when a refund is given, and what happens to AI Credits.',
      'איך מנוי מתחדש ומתבטל, מתי ניתן החזר כספי, ומה קורה ליתרת ה-AI Credits.',
    ],
  },
  {
    slug: 'privacy-policy',
    audience: 'public',
    icon: 'shield',
    summary: [
      'What personal data we collect, why we process it, how long we keep it, and the rights you can exercise.',
      'איזה מידע אישי אנו אוספים, מדוע אנו מעבדים אותו, כמה זמן הוא נשמר ואילו זכויות עומדות לכם.',
    ],
  },
  {
    slug: 'cookie-policy',
    audience: 'public',
    icon: 'cookie',
    summary: [
      'The cookies and similar technologies the site and the product use, and how to control them.',
      'העוגיות והטכנולוגיות הדומות שבהן משתמשים האתר והמוצר, וכיצד לשלוט בהן.',
    ],
  },
  {
    slug: 'dpa',
    audience: 'public',
    icon: 'handshake',
    summary: [
      'Our Data Processing Agreement: the terms under which we process personal data on your behalf as your processor.',
      'הסכם עיבוד הנתונים שלנו: התנאים שלפיהם אנו מעבדים מידע אישי בשמכם כמעבד מטעמכם.',
    ],
  },
  {
    slug: 'subprocessors',
    audience: 'public',
    icon: 'server',
    summary: [
      'Every third-party provider that may process customer personal data on our behalf, and what each one does.',
      'כל ספק צד שלישי שעשוי לעבד מידע אישי של לקוחות בשמנו, ותפקידו של כל אחד מהם.',
    ],
  },

  // ── Internal. Listed so the set stays auditable, never rendered. ──
  { slug: 'ropa', audience: 'internal', icon: 'server', summary: ['', ''] },
  { slug: 'data-retention-policy', audience: 'internal', icon: 'server', summary: ['', ''] },
  { slug: 'data-subject-rights-procedure', audience: 'internal', icon: 'server', summary: ['', ''] },
];

export const PUBLIC_LEGAL_DOCS = LEGAL_DOCS.filter((d) => d.audience === 'public');

export function legalDocMeta(slug) {
  return LEGAL_DOCS.find((d) => d.slug === slug);
}
