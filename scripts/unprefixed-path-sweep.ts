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
 * ⚠⚠ WHAT IT CANNOT SEE, STATED FIRST BECAUSE IT MATTERS MOST
 * ════════════════════════════════════════════════════════════════════════════
 * It matches a LITERAL path at a sink. **A path that travels through a
 * variable is invisible to it** — which means the first of the three defects
 * above, the one that started this whole line of work, would NOT have been
 * caught:
 *
 *     const loginHref = `/api/auth/login?…`;   // no sink on this line
 *     <a href={loginHref}>                     // no literal on this line
 *
 * Closing that needs dataflow, which is a different tool. A green run here
 * means "no literal unprefixed path at a known sink", not "every browser-facing
 * path is prefixed", and reporting the first as the second is exactly the
 * habit this file exists to break.
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

const flags = (line: string): string | null => {
  if (COMMENT.test(line)) return null;
  if (WRAPPED.test(line)) return null;
  for (const [pattern, kind] of SINKS) if (pattern.test(line)) return kind;
  return null;
};

const brokenProbes = PROBES.filter(([, line, shouldFlag]) => (flags(line) !== null) !== shouldFlag);
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
}

if (findings.length === 0) {
  out(`OK — no literal unprefixed path at a known sink in ${ROOT}.`);
  out('(Probes agree. This does NOT cover a path built into a variable first.)');
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
