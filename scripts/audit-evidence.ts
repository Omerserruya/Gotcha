/**
 * Audit the evidence directory itself — after a capture, not during one.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS, AND WHY `check-shoot.ts` IS NOT IT
 * ════════════════════════════════════════════════════════════════════════════
 * `check-shoot.ts` proves the `shoot()` helper captures a whole screen. This
 * looks at what a finished run actually left on disk, which is a different
 * question and the one nobody was asking: **every screenshot this project ever
 * took was one viewport tall, and five differently-named files in `s04` shared
 * a single md5, and no artefact disagreed.** The assertions passed. The DOM was
 * complete. The files were wrong.
 *
 * Read-only, no browser, no server, no session. Safe to run while a capture is
 * in progress, though it only means anything once one has finished.
 *
 *   npx tsx scripts/audit-evidence.ts [dir]
 *
 * ── WHAT IT CAN PROVE, AND WHAT IT DELIBERATELY DOES NOT CLAIM ──
 * It cannot re-derive whether a shot was tall enough: the content height is
 * not in the file, and `shoot()` is the only thing that ever knew it. Saying
 * "this looks like one viewport" from dimensions alone would be a verdict
 * built on a guess, and a short screen legitimately clamps to the viewport.
 *
 * So it checks only what the files themselves can answer, and each check is
 * something the last two capture runs actually got wrong:
 *
 *   1. TRUNCATION — a PNG with no IEND chunk. This is what two Playwright
 *      workers racing to write one filename produces, and a torn file reads
 *      as a rendering defect in the screen rather than as a corrupt artefact.
 *   2. DUPLICATES — differently-named files with the same md5. Five in `s04`
 *      last time, all of them "different" screens that were the same image
 *      above the fold.
 *   3. WIDTH AGAINST THE NAME — `1440-…` that is not 1440 wide. A shot taken
 *      at the wrong viewport, or one viewport's file overwritten by another's.
 *   4. UNREACHED MARKERS — listed, never counted as failures. They are
 *      deliberate absences with their reasons attached, and the reason is the
 *      evidence. A marker nobody reads is the same as a silent gap.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* `no-console` is on repo-wide: logging belongs to the redacting logger, and a
   stray console in shipped code can leak a customer's message. A build script
   writes to a terminal, so it writes to the stream directly — the same choice
   `empty-body-sweep.ts` made. */
const out = (text: string, err = false) =>
  (err ? process.stderr : process.stdout).write(`${text}\n`);

const ROOT = process.argv[2] ?? join('e2e', 'evidence');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from('IEND');

interface Shot {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly md5: string;
  readonly complete: boolean;
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

function read(path: string): Shot {
  const bytes = readFileSync(path);
  const isPng = bytes.subarray(0, 8).equals(PNG_MAGIC);
  return {
    path,
    /* IHDR width and height, which sit at a fixed offset in every PNG. */
    width: isPng && bytes.length >= 24 ? bytes.readUInt32BE(16) : 0,
    height: isPng && bytes.length >= 24 ? bytes.readUInt32BE(20) : 0,
    md5: createHash('md5').update(bytes).digest('hex'),
    /*
     * A PNG ends with an IEND chunk. A file cut off mid-write — two workers on
     * one filename, a killed run — has the header and the dimensions and no
     * IEND, so it opens in some viewers and is silently incomplete in others.
     */
    complete: isPng && bytes.subarray(-8).includes(IEND),
  };
}

let files: string[];
try {
  files = walk(ROOT);
} catch {
  out(`No evidence directory at ${ROOT}. Nothing to audit.`, true);
  process.exit(1);
}

const shots = files.filter((f) => f.endsWith('.png')).map(read);
const markers = files.filter((f) => f.endsWith('.unreached.txt'));
const problems: string[] = [];

/* 1 · truncation. */
for (const shot of shots) {
  if (shot.width === 0) problems.push(`${shot.path}: not a PNG, or shorter than a PNG header`);
  else if (!shot.complete) problems.push(`${shot.path}: no IEND chunk — the file is truncated`);
}

/* 2 · duplicates, which is what a run of same-named shots looked like. */
const byHash = new Map<string, string[]>();
for (const shot of shots) byHash.set(shot.md5, [...(byHash.get(shot.md5) ?? []), shot.path]);
for (const [md5, paths] of byHash) {
  if (paths.length > 1) {
    problems.push(
      `${paths.length} files share one image (${md5.slice(0, 8)}):\n      ${paths.join('\n      ')}`,
    );
  }
}

/* 3 · the width in the name against the width in the file. */
for (const shot of shots) {
  const named = /(?:^|\/)(\d{3,4})-/.exec(shot.path)?.[1];
  if (named && shot.width !== 0 && Number(named) !== shot.width) {
    problems.push(`${shot.path}: named ${named}px wide, the file is ${shot.width}px`);
  }
}

out(`${shots.length} shots, ${markers.length} unreached markers, under ${ROOT}\n`);

/* 4 · the deliberate absences, with their reasons, because that is the point. */
if (markers.length > 0) {
  out('NOT PHOTOGRAPHED, DELIBERATELY — read these, they are evidence too:\n');
  for (const marker of markers) {
    const reason = readFileSync(marker, 'utf8').split('\n').slice(2).join(' ').trim();
    out(`  ${marker}\n      ${reason.slice(0, 300)}\n`);
  }
}

if (problems.length === 0) {
  out('OK — every PNG is complete, uniquely imaged, and the width matches its name.');
  process.exit(0);
}

out(`${problems.length} PROBLEM(S) IN THE EVIDENCE:\n`, true);
for (const problem of problems) out(`  · ${problem}`, true);
out(
  '\nA corrupt or duplicated shot is worse than a missing one: it reads as a defect\n' +
    'in the screen. Re-run the affected spec alone before reviewing anything.',
  true,
);
process.exit(1);
