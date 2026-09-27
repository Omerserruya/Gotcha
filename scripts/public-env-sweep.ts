/**
 * Every `NEXT_PUBLIC_*` the source reads must be a build arg in the Dockerfile.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY, AND WHY IT IS A GATE RATHER THAN A LISTING
 * ════════════════════════════════════════════════════════════════════════════
 * Next replaces `process.env.NEXT_PUBLIC_X` with a literal when it compiles the
 * client bundle, so **a value supplied only at runtime does not exist for the
 * browser.** A missing one does not crash and does not warn — it is
 * `undefined`, and the code around it takes the "not configured" branch it was
 * written to take honestly.
 *
 * `NEXT_PUBLIC_REALTIME_URL` was missing from the Dockerfile and that is
 * exactly what would have happened: `realtime-provider` reads it, gets
 * `undefined`, returns `null`, and **no socket is ever opened.** Meanwhile
 * `proxy.ts` reads the same variable at runtime and puts the origin in the
 * CSP, so the policy permits a connection nobody attempts. Every screen
 * renders, every navigation works, the inbox never updates.
 *
 * That is the shape this project keeps finding — complete by every check
 * anybody runs, absent in the one dimension nobody checks — so this one fails
 * the run rather than printing.
 *
 *   npx tsx scripts/public-env-sweep.ts
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
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Where each variable is read, so a failure names the file to look at. */
const readers = new Map<string, Set<string>>();
for (const file of [...walk('src'), 'next.config.ts']) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
    const name = match[0];
    readers.set(name, (readers.get(name) ?? new Set()).add(file));
  }
}

const dockerfile = readFileSync('Dockerfile', 'utf8');

/*
 * ★★ ONLY THE STAGE THAT RUNS THE BUILD COUNTS.
 *
 * A first version matched `ARG NEXT_PUBLIC_*` anywhere in the file, and **it
 * passed the exact defect it was written for**: the runtime stage declared
 * `NEXT_PUBLIC_REALTIME_URL` while the build stage did not, which is precisely
 * "set at runtime, undefined in the bundle". Its own comment rationalised
 * matching either stage.
 *
 * So the file is split on stage boundaries and only the stage containing the
 * build command is read. An `ARG` anywhere else does not reach the compiler.
 */
const stages = dockerfile.split(/^FROM .*$/m);
const buildStage = stages.find((stage) => /^\s*RUN\s+npm run build/m.test(stage));
if (!buildStage) {
  out('Could not find the stage that runs `npm run build` in the Dockerfile.', true);
  process.exit(1);
}
const declared = new Set(
  [...buildStage.matchAll(/^ARG\s+(NEXT_PUBLIC_[A-Z0-9_]+)/gm)].map((m) => m[1]!),
);

const missing = [...readers.keys()].filter((name) => !declared.has(name)).sort();
/* The reverse is harmless — an arg for a variable nothing reads yet — but it is
   worth saying, because it is usually a rename that left one side behind. */
const unread = [...declared].filter((name) => !readers.has(name)).sort();

for (const name of unread) {
  out(`note: ${name} is a build arg and nothing in src reads it.`);
}

if (missing.length === 0) {
  out(`OK — all ${readers.size} NEXT_PUBLIC_* variables are declared in the stage that builds.`);
  process.exit(0);
}

out('NEXT_PUBLIC_* VARIABLES THAT WOULD BE UNDEFINED IN THE BROWSER:\n', true);
for (const name of missing) {
  out(`  ${name}`, true);
  for (const file of [...(readers.get(name) ?? [])].sort()) out(`      read in ${file}`, true);
}
out(
  '\nAdd an `ARG` for each in the Dockerfile build stage. Next inlines these at\n' +
    'BUILD time: supplying one only at runtime leaves it undefined for the client,\n' +
    'which does not crash and does not warn — the code takes its "not configured"\n' +
    'branch and the feature is silently absent.',
  true,
);
process.exit(1);
