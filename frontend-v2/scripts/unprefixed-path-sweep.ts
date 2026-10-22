/**
 * Which browser-facing paths assume this app is mounted at the root?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY — THE SAME DEFECT IN THREE SPELLINGS, EACH FOUND BY A DIFFERENT ACCIDENT
 * ════════════════════════════════════════════════════════════════════════════
 * Next prefixes `next/link`, the router, `redirect()` and the `source` of
 * `headers()`/`redirects()` with `basePath`. It does **not** touch `fetch`,
 * `new URL`, a raw `<a href>`, or `location.assign` — those are plain web APIs
 * with no knowledge of where the app is mounted. Under `/v2`, beside the legacy
 * product, an unprefixed path is not a 404: **it is the other application's
 * route.**
 *
 *   the sign-in anchor        `href={loginHref}` where `loginHref` was bare
 *                             → started the LEGACY product's OIDC flow
 *   the OIDC `redirect_uri`   `new URL('/api/auth/callback', APP_ORIGIN)`
 *                             → handed the provider a URL we do not own
 *   session expiry            `location.assign('/api/auth/login?…')`
 *                             → sent an expiring session to the legacy login
 *
 * ★ Each was found by a different accident, and the sweep written after each
 *   one was shaped like the spelling in front of it. "They are all `fetch`
 *   calls, this was the only `href`" was true and its conclusion was wrong:
 *   `sign-out.ts` satisfies "calls `appPath`" in one function while the
 *   function below it did not. **A sweep organised by FILE cannot see a second
 *   call site, and one organised by SYNTAX finds one spelling.**
 *
 *   npx tsx scripts/unprefixed-path-sweep.ts
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TWO PASSES, BECAUSE ONE OF THE THREE DEFECTS HAD NO LITERAL AT ITS SINK
 * ════════════════════════════════════════════════════════════════════════════
 * The first pass matches a LITERAL path at a sink. On its own that misses the
 * sign-in anchor — the defect that started this line of work — because the
 * path was built into a name on one line and used on the next:
 *
 *     const loginHref = `/api/auth/login?…`;   // no sink on this line
 *     <a href={loginHref}>                     // no literal on this line
 *
 * So the second pass follows a `const` bound to a literal absolute path and
 * asks whether that NAME reaches a sink in the same file.
 *
 * ⚠⚠ AND IT STILL DOES NOT CATCH THE ANCHOR. MEASURED, NOT ASSUMED.
 * Restoring the real defect in `sign-in/page.tsx` — `const loginBase =
 * '/api/auth/login'` — produced a CLEAN run. The real code is two hops and a
 * file boundary, not one:
 *
 *     const loginBase = '/api/auth/login';          // the literal
 *     const loginHref = `${loginBase}${query}`;     // a second name
 *     <SignInPanel handOverHref={loginHref} />      // a prop, not a sink
 *     … and the <a href> lives in another file entirely
 *
 * ★ My first probe for this pass was called "the sign-in anchor" and was a
 *   two-line simplification I wrote from memory of the defect rather than from
 *   the code. **It passed while the defect walked through** — the same
 *   fixture-that-cannot-discriminate this project keeps producing, this time
 *   inside the instrument built to stop it. The probe is now named for what it
 *   actually tests.
 *
 * ★ The binding pattern requires a real character after the slash, so
 *   `` const path = `/${segments.join('/')}` `` in the BFF is not a match. It
 *   is a path with no literal in it, composed for the PLATFORM's origin, and
 *   it must not be prefixed. Without that refinement it was the only finding
 *   on a clean tree — one false positive out of one result, which is the rate
 *   at which people stop reading a sweep.
 *
 * ⚠⚠ SO WHAT IS STILL INVISIBLE, STATED PLAINLY. The second pass follows ONE
 *   assignment to ONE name inside ONE file. A second hop, a prop, a return
 *   value, or a module boundary defeats it — and the anchor defect had three
 *   of those four. It is covered today only by `page.test.tsx` asserting the
 *   composed `href`, which is a test, not a sweep.
 *
 *   A green run means "no unprefixed literal at a sink, and none bound to a
 *   local name that reaches one". It does not mean every browser-facing path
 *   is prefixed, and reporting the first as the second is the habit this file
 *   exists to break.
 *
 * ── AND ONE VARIANT WAS TRIED AND THROWN AWAY ──
 * Organising by VALUE instead — every literal naming `/api/…` — returns 174
 * hits, essentially all of them `endpoints/registry.ts` naming the PLATFORM
 * API's routes, which are proxied through the BFF and must not be prefixed.
 * A sweep whose output is all false positives teaches the next person that
 * this class of alert is noise.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/* `no-console` is on repo-wide; a build script writes to the stream directly. */
const out = (text: string, err = false) =>
  (err ? process.stderr : process.stdout).write(`${text}\n`);

const ROOT = 'src';

/**
 * Sinks that resolve a path against the ORIGIN rather than the mount point.
 *
 * `<Link>` is deliberately absent: Next prefixes it, and including it would
 * flag a dozen correct call sites — the fastest way to make a sweep ignored.
 */
const SINKS: readonly (readonly [RegExp, string])[] = [
  [/\bfetch\(\s*[`'"]\//, 'fetch'],
  [/\bnew URL\(\s*[`'"]\//, 'new URL'],
  [/\blocation\.(?:assign|replace)\(\s*[`'"]\//, 'location.assign'],
  [/\blocation\.href\s*=\s*[`'"]\//, 'location.href'],
  [/<a\b[^>]*\bhref=[{]?\s*[`'"]\//, 'raw anchor href'],
  [/\baction=[{]?\s*[`'"]\//, 'form action'],
];

const WRAPPED = /appPath\(|appUrl\(/;
const COMMENT = /^\s*(?:\*|\/\/|\/\*)/;

/**
 * ★★ THE INSTRUMENT IS RUN AGAINST THE DEFECTS BEFORE IT IS TRUSTED.
 *
 * Every guard in this project has, at least once, been written from the shape
 * of the thing it was meant to catch and then failed to catch it. So the three
 * real defects — and the fixed form, which must NOT match — are checked on
 * every run, and the sweep refuses to report a clean result if its own probes
 * disagree.
 */
const PROBES: readonly (readonly [string, string, boolean])[] = [
  ['the OIDC redirect_uri', "return new URL('/api/auth/callback', origin).toString();", true],
  ['session expiry', 'window.location.assign(`/api/auth/login?returnTo=${x}`);', true],
  ['a raw anchor', '<a className={styles.forgot} href="/api/auth/login">', true],
  ['a browser fetch', "await fetch('/auth-api/flows/executor/x/');", true],
  ['the FIXED expiry', "window.location.assign(`${appPath('/api/auth/login')}?x`);", false],
  ['a next/link href', '<Link href="/home" className={styles.brand}>', false],
];

/** Second-pass probes: a whole file, because the defect spans two lines. */
const BOUND_PROBES: readonly (readonly [string, string, boolean])[] = [
  [
    // NOT "the sign-in anchor": that defect has two hops and a file boundary,
    // and a clean run against it is recorded in the header above.
    'a literal bound to a name used directly at a sink',
    'const loginHref = `/api/auth/login?x`;\nreturn <a href={loginHref}>x</a>;',
    true,
  ],
  [
    "the BFF's composed upstream path",
    "const path = `/${segments.map(encodeURIComponent).join('/')}`;\nconst url = new URL(path, base);",
    false,
  ],
  [
    'the FIXED anchor',
    "const loginHref = `${appPath('/api/auth/login')}?x`;\nreturn <a href={loginHref}>x</a>;",
    false,
  ],
];

/**
 * A `const` holding a literal absolute path.
 *
 * The trailing `[A-Za-z]` is the refinement that keeps the BFF's
 * `` `/${segments…}` `` out: a path with no literal segment is not a path this
 * app owns, it is one composed for somebody else's origin.
 */
const BINDING = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*[`'"](\/[A-Za-z][\w.-]*)/;

const sinksFor = (name: string): readonly RegExp[] => [
  new RegExp(`\\bfetch\\(\\s*${name}\\b`),
  new RegExp(`\\bnew URL\\(\\s*${name}\\b`),
  new RegExp(`\\blocation\\.(?:assign|replace)\\(\\s*${name}\\b`),
  new RegExp(`\\blocation\\.href\\s*=\\s*${name}\\b`),
  new RegExp(`<a\\b[^>]*\\bhref=\\{\\s*${name}\\s*\\}`),
];

/** Lines binding a literal path to a name that later reaches a sink. */
function boundPathsReachingASink(source: string): readonly { line: string; index: number }[] {
  const lines = source.split('\n');
  const found: { line: string; index: number }[] = [];
  lines.forEach((line, index) => {
    if (COMMENT.test(line) || WRAPPED.test(line)) return;
    const match = BINDING.exec(line);
    if (!match) return;
    const name = match[1]!;
    const reaches = sinksFor(name).some((pattern) =>
      lines.some((other) => !COMMENT.test(other) && pattern.test(other)),
    );
    if (reaches) found.push({ line, index });
  });
  return found;
}

const flags = (line: string): string | null => {
  if (COMMENT.test(line)) return null;
  if (WRAPPED.test(line)) return null;
  for (const [pattern, kind] of SINKS) if (pattern.test(line)) return kind;
  return null;
};

const brokenProbes = [
  ...PROBES.filter(([, line, shouldFlag]) => (flags(line) !== null) !== shouldFlag),
  ...BOUND_PROBES.filter(
    ([, source, shouldFlag]) => boundPathsReachingASink(source).length > 0 !== shouldFlag,
  ),
];
if (brokenProbes.length > 0) {
  out('REFUSING TO REPORT — the sweep does not agree with its own probes:\n', true);
  for (const [name, , shouldFlag] of brokenProbes) {
    out(`  ${name}: expected ${shouldFlag ? 'a flag' : 'no flag'}, got the opposite`, true);
  }
  out('\nFix the patterns before trusting a run. A clean sweep that cannot see', true);
  out('a known defect is worse than no sweep.', true);
  process.exit(2);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const findings: string[] = [];
for (const path of walk(ROOT)) {
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const kind = flags(line);
      if (kind)
        findings.push(`  [${kind}] ${relative('.', path)}:${index + 1}\n      ${line.trim()}`);
    });

  for (const { line, index } of boundPathsReachingASink(readFileSync(path, 'utf8'))) {
    findings.push(`  [bound then used] ${relative('.', path)}:${index + 1}\n      ${line.trim()}`);
  }
}

if (findings.length === 0) {
  out(`OK — no literal unprefixed path at a known sink in ${ROOT}.`);
  out('(Both passes agree with their probes. Neither follows a path across files.)');
  process.exit(0);
}

out(`${findings.length} browser-facing path(s) that assume the root:\n`);
for (const finding of findings) out(finding);
out(
  '\nEach resolves against the ORIGIN, not the mount point. Under a base path,\n' +
    'beside another application, that is not a 404 — it is the other app’s route.\n' +
    'Wrap in `appPath` for a path, or `appUrl` for an absolute URL.',
);
process.exit(1);
