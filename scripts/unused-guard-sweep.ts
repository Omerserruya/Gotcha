/**
 * Which predicates are exported, tested, and called by nothing?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY
 * ════════════════════════════════════════════════════════════════════════════
 * `lib/safe-url.ts` exists because "placing an unvalidated URL in `href` or
 * `src` is how `javascript:` payloads become script execution". It exported
 * `safeLinkUrl` and `safeMediaUrl`, both with passing tests, and **nothing in
 * the application called either of them.** Meanwhile the billing screen
 * rendered `href={invoice.providerPdfUrl ?? '#'}` — the exact sink — and the
 * sign-in panel rendered a third party's `recovery_url` the same way.
 *
 * ★ A guard nobody calls is worse than no guard, because the file's existence
 *   is the reassurance. Nothing disagreed: the predicate was correct, its
 *   tests passed, and the question "does anything use it" was asked by no
 *   artefact in the repository.
 *
 * It is `orphan-component-sweep.ts` one level over. That one asks whether a
 * finished component is on a page; this asks whether a finished predicate is
 * in a code path. Both defects are invisible to every test, because every test
 * reads the artefact and nothing reads the wiring.
 *
 *   npx tsx scripts/unused-guard-sweep.ts
 *
 * ── WHAT COUNTS AS A GUARD ──
 * An exported function whose name begins with a predicate verb — `safe`,
 * `assert`, `is`, `has`, `validate`, and so on. Deliberately a name-shaped
 * heuristic: the alternative is reading every function, and the names in this
 * codebase are good enough that the list is short and mostly true.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──
 * It does not fail the build. A contract predicate can be legitimately ahead
 * of its screen — `hasLapsed` for an approvals view not yet built is the
 * vocabulary arriving before the surface — and turning that into a red gate
 * pushes somebody to call it pointlessly to silence it.
 *
 * ★ But a SECURITY predicate with no callers is a different object from a
 *   contract predicate with no callers, so they are printed apart. The first
 *   is a hole; the second is a plan.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/* `no-console` is on repo-wide; a build script writes to the stream directly,
   the same choice `orphan-component-sweep.ts` made. */
const out = (text: string) => process.stdout.write(`${text}\n`);

const ROOT = 'src';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const all = walk(ROOT);
const isTest = (path: string) => /\.test\.tsx?$/.test(path);
const sources = all.filter((path) => !isTest(path));
const read = new Map(all.map((path) => [path, readFileSync(path, 'utf8')]));

/**
 * Names that read as a question about a value.
 *
 * `safe`/`assert`/`validate`/`sanitise` are the refusing kind and are treated
 * as security-shaped below; the rest describe a state.
 */
const GUARD_NAME =
  /export\s+(?:async\s+)?function\s+((?:safe|assert|validate|sanitis|sanitiz|ensure|require|guard|forbid|deny|reject|allow|is|has|must)[A-Za-z0-9_]*)/g;

/** A name whose job is to REFUSE something, rather than to describe it. */
const REFUSING = /^(?:safe|assert|validate|sanitis|sanitiz|ensure|guard|forbid|deny|reject)/;

interface Finding {
  readonly name: string;
  readonly path: string;
  readonly tested: boolean;
}

const unused: Finding[] = [];

for (const path of sources) {
  const source = read.get(path)!;
  GUARD_NAME.lastIndex = 0;
  for (const match of source.matchAll(GUARD_NAME)) {
    const name = match[1]!;
    const word = new RegExp(`\\b${name}\\b`);
    /*
     * Any mention in another non-test file. Looser than the orphan sweep's
     * import-statement match on purpose: a re-export or an indirect call still
     * means somebody reaches it, and a false "unused" on a security predicate
     * costs more than a false "used" on a contract one.
     */
    const called = sources.some((other) => other !== path && word.test(read.get(other)!));
    if (called) continue;
    const tested = all.some((other) => isTest(other) && word.test(read.get(other)!));
    unused.push({ name, path: relative('.', path), tested });
  }
}

const refusing = unused.filter((finding) => REFUSING.test(finding.name));
const describing = unused.filter((finding) => !REFUSING.test(finding.name));

if (unused.length === 0) {
  out(`OK — every guard-shaped export in ${ROOT} is referenced somewhere.`);
  process.exit(0);
}

if (refusing.length > 0) {
  out(`⚠ ${refusing.length} REFUSING predicate(s) that nothing calls:\n`);
  for (const finding of refusing) {
    out(`  ${finding.name}  —  ${finding.path}${finding.tested ? '  (has a test)' : ''}`);
  }
  out(
    '\nThese exist to reject a value. If nothing calls one, find the sink it was\n' +
      'written for and check what guards it instead — `safeLinkUrl` had none, and\n' +
      'two screens were rendering somebody else’s string into an href.\n',
  );
}

if (describing.length > 0) {
  out(`${describing.length} describing predicate(s) that nothing calls:\n`);
  for (const finding of describing) {
    out(`  ${finding.name}  —  ${finding.path}${finding.tested ? '  (has a test)' : ''}`);
  }
  out(
    '\nUsually vocabulary that arrived before its screen, which is a legitimate\n' +
      'answer and the reason this prints rather than failing. Worth a look when one\n' +
      'names a rule the product is supposed to enforce.',
  );
}
