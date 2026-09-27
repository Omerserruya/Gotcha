/**
 * Assertions whose expected value is a raw platform identifier.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * A TEST THAT PINS A DEFECT IS THE MOST EXPENSIVE TEST THERE IS
 * ════════════════════════════════════════════════════════════════════════════
 * `IntegrationRail.test.tsx` asserted `toHaveTextContent('ERROR')` — so a raw
 * enum on an operational screen was not merely unnoticed, it was **required**.
 * Anyone who fixed the screen got a red build and backed the fix out. It
 * converts a bug into a requirement.
 *
 * So this sweeps the ASSERTIONS rather than the source: any check on RENDERED
 * TEXT whose expected value looks like a machine value — `SCREAMING_SNAKE`, or
 * a dotted lowercase code.
 *
 * ── WHY ONLY RENDERED TEXT ──
 * `expect(parsed.status).toBe('CONNECTED')` is correct and necessary: it pins a
 * contract against the platform's own vocabulary. The same string inside
 * `toHaveTextContent` is a claim about what a person reads. The matcher is the
 * whole difference, which is why this looks at the matcher and not at the
 * string.
 *
 *   npx tsx scripts/pinned-identifier-sweep.ts
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE CRITERION: IS THERE A NAME THE ASSERTION IS REFUSING?
 * ════════════════════════════════════════════════════════════════════════════
 * Most identifiers on screen are deliberate and correct, and the list below is
 * a triage rather than a to-do. What made `'ERROR'` a pin was not that it was a
 * code — it was that **`capabilities.rail.state.ERROR` already existed** and
 * the test required the code instead. There was a name and the assertion
 * refused it.
 *
 * Where no catalogue exists, the identifier is the honest thing to show:
 *
 *   missingScopes        `write_orders` is what the merchant must tick in
 *                        Shopify's own consent screen. A paraphrase would not
 *                        match what they are looking at.
 *   provider errors      `rate_limited` is the provider's word for what
 *                        happened; a vaguer copy of it helps nobody.
 *   an unmapped step     showing `verify_domain` beats silently dropping a
 *                        setup step nobody has written copy for.
 *   country codes        `IL` is what an address carries.
 *
 * So: for each hit, ask whether a label exists for that value. If one does,
 * the assertion is pinning a defect. If none does, it is pinning a decision.
 * As of 2026-09-27 the suite had exactly one of the former and it is fixed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* `no-console` is on repo-wide; a build script writes to the stream directly. */
const out = (text: string, err = false) =>
  (err ? process.stderr : process.stdout).write(`${text}\n`);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Matchers and queries that read what a PERSON sees. */
const TEXT_MATCHERS = [
  'toHaveTextContent',
  'toHaveText',
  'getByText',
  'queryByText',
  'findByText',
  'getAllByText',
];

/**
 * Words that are legitimately upper-case on a screen.
 *
 * A bare all-caps token has to be considered — the defect that prompted this
 * was `'ERROR'`, which has no underscore — but "VAT" and "AI" are what a
 * person reads, not codes. Closed list, same reasoning as `humaniseCode`: the
 * set of acronyms a product displays is enumerable and a rule is not.
 */
const DISPLAY_WORDS = new Set([
  'AI',
  'API',
  'CRM',
  'CSV',
  'FAQ',
  'GOTCHA',
  'ID',
  'OK',
  'PDF',
  'SLA',
  'SMS',
  'URL',
  'VAT',
]);

/** A machine value: screaming snake, a bare all-caps token, or a dotted code. */
const IDENTIFIER = /^(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|[A-Z]{2,}|[a-z][a-z0-9]*(?:[._][a-z0-9]+){1,})$/;

const hits: string[] = [];
for (const file of [...walk('src'), ...walk('e2e')]) {
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, index) => {
    /*
     * ★★ COMMENTS AND NEGATIVE ASSERTIONS ARE NOT PINS.
     *
     * A first run returned fourteen hits, of which four were my own comment
     * describing the defect and my own `not.toHaveTextContent('ERROR')` — the
     * FIX, reported as the bug. A negative assertion on an identifier is the
     * shape this sweep wants to see everywhere.
     */
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    if (/\bnot\.|queryBy|\.toBeNull\(/.test(line)) return;

    for (const matcher of TEXT_MATCHERS) {
      /* The expected value as a quoted string or a bare regex literal. */
      const pattern = new RegExp(`${matcher}\\(\\s*(?:'([^']+)'|"([^"]+)"|/\\^?([^/]+)\\$?/)`);
      const match = pattern.exec(line);
      if (!match) continue;
      const expected = match[1] ?? match[2] ?? match[3];
      if (expected === undefined) continue;
      /* A regex with alternation or flags is prose, not an identifier. */
      const bare = expected.replace(/\\b/g, '');
      if (!IDENTIFIER.test(bare)) continue;
      if (DISPLAY_WORDS.has(bare)) continue;
      hits.push(`${file}:${index + 1}\n      ${line.trim()}`);
    }
  });
}

if (hits.length === 0) {
  out('OK — no assertion on rendered text expects a raw platform identifier.');
  process.exit(0);
}

out(`${hits.length} ASSERTION(S) REQUIRING A MACHINE VALUE ON SCREEN:\n`, true);
for (const hit of hits) out(`  ${hit}`, true);
out(
  '\nTRIAGE, not a to-do. For each: does a label exist for that value?\n' +
    '  · YES → the assertion is pinning a defect. Fixing the screen would turn the\n' +
    '    build red and the next person would back the fix out. Re-aim it at what\n' +
    "    the assertion MEANT — the state's name, the rule, the absence.\n" +
    '  · NO  → it is pinning a decision, and the identifier is the honest thing to\n' +
    '    show. Leave it.\n' +
    'See the header for the four kinds that are legitimately codes.',
);
/* Exits 0: this is a list to read, not a gate. A gate here would be wrong in
   both directions — it cannot tell a pin from a decision. */
process.exit(0);
