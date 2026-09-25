/**
 * Which response contracts accept `{}` — and therefore render a confident
 * screen out of a body that said nothing?
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════════════
 * `customerAuditSchema` defaulted all five of its top-level keys, so `{}`
 * parsed cleanly and screen 04e rendered *"nothing has been recorded against
 * this person yet"* with no coverage caveats underneath it. A confident claim
 * about somebody's history, manufactured from a response that carried nothing
 * — and **exactly the body a stale or half-deployed service returns.**
 *
 * It was found by accident: a test wrote `{ nonsense: true }` expecting a
 * failure and got back a valid `CustomerAudit`. Nothing would have reported
 * it, because a schema that always succeeds produces no error to notice.
 *
 * ── WHAT THIS CHECKS ──
 * Every exported Zod schema used as a `payload:` at a call site, parsed
 * against `{}`. A success is a finding: it means absence and emptiness are
 * indistinguishable at that boundary.
 *
 * ── WHAT IT CANNOT SEE, AND THIS MATTERS ──
 * **It ranks nothing.** A defaulted leaf is often right — one odd row
 * degrading beats a whole list vanishing — and the tool cannot tell a
 * harmless `moneySchema` from `revokeResultSchema`, whose `ok` defaults to
 * **true** so an unparseable response reads as a completed session revoke.
 *
 * The question the tool cannot answer is the only one that matters:
 * **what sentence does the empty parse put on the screen?** If that sentence
 * is a claim — "MFA is not required", "0 credits consumed", "the outcome is
 * known" — the default is a defect. If it is visibly an empty screen, it is
 * resilience. Read the output with that question, not as a to-do list.
 *
 *   npx tsx scripts/empty-body-sweep.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const CONTRACTS = join(ROOT, 'src/api/contracts');

/** Every schema named at a `payload:` — the response boundaries. */
function payloadSchemas(): ReadonlySet<string> {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        for (const m of readFileSync(path, 'utf8').matchAll(/payload:\s*(\w+)/g)) names.add(m[1]!);
      }
    }
  };
  walk(join(ROOT, 'src'));
  return names;
}

/* `no-console` is on repo-wide: logging belongs to the redacting logger, and
   a stray console in shipped code can leak a customer's message. A build
   script writes to a terminal, so it writes to the stream directly — the same
   choice `probe-contracts.ts` made. */
const out = (text: string, err = false) =>
  (err ? process.stderr : process.stdout).write(text);

async function main() {
  const wanted = payloadSchemas();
  const findings: { file: string; name: string; renders: string }[] = [];

  for (const file of readdirSync(CONTRACTS)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(join(CONTRACTS, file)).href)) as Record<string, unknown>;
    } catch (cause) {
      out(`  could not import ${file}: ${String(cause).slice(0, 80)}\n`, true);
      continue;
    }
    for (const [name, value] of Object.entries(mod)) {
      if (!wanted.has(name)) continue;
      const schema = value as { safeParse?: (input: unknown) => { success: boolean; data?: unknown } };
      if (typeof schema?.safeParse !== 'function') continue;
      const result = schema.safeParse({});
      if (result.success) {
        findings.push({ file, name, renders: JSON.stringify(result.data).slice(0, 110) });
      }
    }
  }

  findings.sort((a, b) => `${a.file}${a.name}`.localeCompare(`${b.file}${b.name}`));
  out('Response contracts that accept `{}`.\n\n');
  out('Ask of each: what SENTENCE does this put on the screen?\n\n');
  for (const f of findings) {
    out(`  ${f.file.padEnd(24)} ${f.name.padEnd(30)} ${f.renders}\n`);
  }
  out(`\n  ${findings.length} of ${wanted.size} response boundaries.\n`);
  /*
   * Deliberately exits 0. This is an inventory to be read, not a gate — a
   * failing build here would be answered by adding `.default()` removals
   * without reading what each one renders, which is the opposite of the
   * point.
   */
}

void main();
