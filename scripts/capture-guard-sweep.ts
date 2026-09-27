/**
 * Every capture test that opens a page must run in ONE Playwright project.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS EXISTS TO STOP
 * ════════════════════════════════════════════════════════════════════════════
 * `playwright.config.ts` runs `ltr` and `rtl`, which differ only in the
 * browser's `locale`. Every screen here takes its direction from the URL —
 * `/en/…` and `/he/…` — which is what next-intl reads. So without a guard the
 * two projects render identical pixels into identical filenames and, with
 * `fullyParallel: true`, race to write them.
 *
 *   · A torn PNG is not a missing shot. It is a corrupt one, and it reads as a
 *     rendering defect in the screen rather than in the capture.
 *   · It doubles the request budget — 1,000 requests per fifteen minutes per
 *     IP per service — which is the constraint that had been stopping capture
 *     runs. Half of every run was the English tests again under a Hebrew
 *     locale that changes nothing.
 *
 * ── THE RULE, AND WHY IT IS ABOUT FIXTURES ──
 * A test that takes a fixture (`{ page }`, `{ context }`, `{ request }`) opens
 * a browser and spends requests, so it needs the guard. A test that takes
 * none — the source-reading tripwire in `inbox.spec.ts`, for instance — costs
 * nothing and is a fact about the repository rather than about a screen. It
 * runs in both projects and that is correct.
 *
 * So this checks the property that matters instead of counting lines, and a
 * new spec cannot quietly reintroduce the duplication.
 *
 *   npx tsx scripts/capture-guard-sweep.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* `no-console` is on repo-wide: logging belongs to the redacting logger, and a
   stray console in shipped code can leak a customer's message. A build script
   writes to a terminal, so it writes to the stream directly — the same choice
   `empty-body-sweep.ts` and `probe-contracts.ts` made. */
const out = (text: string, err = false) =>
  (err ? process.stderr : process.stdout).write(`${text}\n`);

const DIR = 'e2e';
const problems: string[] = [];
let guarded = 0;
let exempt = 0;

for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith('.spec.ts'))
  .sort()) {
  const src = readFileSync(join(DIR, file), 'utf8');

  /*
   * `settings-notifications-seeded.spec.ts` guards for a different reason —
   * both projects writing to the tenant at once — and does it with its own
   * named constant at the write site. Its mechanism is equivalent and its
   * reason is stronger, so it is recognised rather than rewritten.
   */
  const hasHelper = src.includes('function onlyOneProject');
  const hasOwnGuard = src.includes('WRITING_PROJECT');

  const tests = [...src.matchAll(/(?<![.\w])test\(/g)];
  if (tests.length === 0) continue;

  for (const match of tests) {
    const arrow = src.indexOf('=> {', match.index!);
    if (arrow === -1) {
      problems.push(`${file}: a test( with no arrow body at offset ${match.index}`);
      continue;
    }
    const line = src.slice(0, match.index!).split('\n').length;
    const signature = src.slice(match.index!, arrow);
    /*
     * Does it ask for a fixture? `async () =>` takes none. Anything inside the
     * arrow's parameter list means Playwright builds a browser context for it.
     */
    const params = signature.slice(signature.lastIndexOf('async') + 5).trim();
    const takesFixtures = /^\(\s*[^)\s]/.test(params);

    if (!takesFixtures) {
      exempt += 1;
      continue;
    }
    /*
     * ★ THE FIRST STATEMENT, WITH COMMENTS TAKEN OUT FIRST.
     *
     * The initial version looked at a fixed 120 characters after the arrow and
     * reported the seeded spec as unguarded — its guard sits behind a
     * fourteen-line comment explaining the trap it exists for. **The checker
     * would have had me "fix" the one file that already did this correctly.**
     *
     * So the window is generous, prose comes out, and what is examined is the
     * first actual statement — which is the rule as stated rather than a proxy
     * for it.
     */
    const firstStatement = src
      .slice(arrow + 4, arrow + 4 + 2_000)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .trimStart()
      .split(';')[0]!;

    if (/onlyOneProject\(\)|PROJECT/.test(firstStatement)) {
      guarded += 1;
    } else {
      problems.push(`${file}:${line}: a test that opens a page and is not guarded to one project`);
    }
  }

  if (!hasHelper && !hasOwnGuard) {
    problems.push(`${file}: no project guard helper at all`);
  }
}

if (problems.length === 0) {
  out(`OK — ${guarded} page-opening tests guarded to one project, ${exempt} exempt (no fixtures).`);
  process.exit(0);
}

out('CAPTURE TESTS THAT WOULD RUN IN BOTH PROJECTS:\n', true);
for (const problem of problems) out(`  ${problem}`, true);
out(
  '\nAdd `if (onlyOneProject()) return;` as the FIRST statement of the test.\n' +
    'Not at describe scope: a describe-scope `test.skip(({}, testInfo) => …)`\n' +
    'receives fixtures only — there is no second argument — so `testInfo` is\n' +
    'undefined and reading `.project` throws in BOTH projects. Verified.',
  true,
);
process.exit(1);
