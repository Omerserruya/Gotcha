/**
 * Backend identifiers and unbounded durations reaching a renderer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY: THE INSTANCE WAS FIXED AND THE NAME WAS NEVER SWEPT
 * ════════════════════════════════════════════════════════════════════════════
 * Screen 02's queue printed `SHOPIFY_LIVE_CHAT` and `47061m` — a raw channel
 * enum and a wait in raw minutes, which was thirty-two days. Both were fixed
 * there. A browser walk then found the same two defects on five other screens:
 * `SHOPIFY_LIVE_CHAT` on Home twice, `1444h` on Home (sixty days),
 * `PROJECT_MANAGEMENT` on Integrations, `Crm` and `Ai` as headings on
 * Permissions, and a tool-call id as a row title on Approvals.
 *
 * So this is the sweep that should have followed the fix.
 *
 * ── TWO SHAPES, AND NEITHER IS DECIDABLE, SO IT PRINTS ──
 * A field called `category` may hold a label or a code, and only its writer
 * knows. This lists candidates for a person to judge, like the orphan sweep,
 * because a gate that guesses gets disabled the first time it is wrong.
 *
 *   npx tsx scripts/raw-value-sweep.ts
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ⚠ WHAT THIS CANNOT SEE, STATED BECAUSE IT TOOK FOUR TRIES TO ADMIT
 * ════════════════════════════════════════════════════════════════════════════
 * A line-based regex cannot tell attribute position from text position when a
 * line has both. `<h3 className={styles.x}>{group.category}</h3>` renders a raw
 * category and is skipped, because the line also assigns an attribute — and
 * loosening that check floods the output with `data-testid` and `key`.
 *
 * It also cannot see a code that has been through a helper:
 * `humaniseToolName('crm')` is `'Crm'`, and `'ai-bot.inbox.tool_call'` becomes
 * `'Ai-bot inbox tool call'` as a row title. Three of the five defects that
 * prompted this sweep arrived that way.
 *
 * So this is a first pass, not coverage. **The browser walk is the authority
 * for this class** — it found all five and this found two. Treat a clean run
 * as "nothing obvious in text position", never as "no raw values ship".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* `no-console` is on repo-wide; a build script writes to the stream directly. */
const out = (text: string) => process.stdout.write(`${text}\n`);

function walk(dir: string, match: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, match);
    return match.test(entry.name) ? [path] : [];
  });
}

/**
 * Field names that usually hold a machine value.
 *
 * Drawn from what the platform actually sends, not from intuition: these are
 * the columns whose values arrive as `SCREAMING_SNAKE` or a dotted code.
 */
const CODE_FIELDS = [
  'channel',
  'category',
  'domain',
  'feature',
  'kind',
  'provider',
  'stage',
  'status',
  'systemType',
  'toolName',
  'type',
];

const codeHits: string[] = [];
for (const file of walk('src', /\.tsx$/)) {
  if (/\.test\.tsx$/.test(file)) continue;
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, index) => {
    for (const field of CODE_FIELDS) {
      /*
       * ★★ TEXT POSITION ONLY. A first version matched the expression anywhere
       * on the line and returned fifty hits, almost all of them `key={…}`,
       * `data-testid={…}` and `data-state={…}` — a code in an attribute is
       * correct and invisible. The negative lookbehind for `=` is what
       * distinguishes "rendered to a person" from "used as an identifier",
       * which is the property this sweep is actually about. It took three
       * attempts — 50 hits, then 26, then the list below — and each round was
       * the same error: matching where the text appeared rather than what it
       * does.
       */
      const inText = new RegExp(
        `(?<![=\\w$])\\{[a-zA-Z_$][\\w.$]*\\.${field}(?:\\s*\\?\\?[^}]*)?\\}`,
      );
      if (!inText.test(line)) continue;
      /*
       * And no attribute contexts at all. `${…}` inside a template literal is
       * not preceded by `=`, so `data-testid={`x-${row.type}`}` slipped past
       * the lookbehind on the second attempt. A line that assigns an attribute
       * is not rendering text, whatever the expression looks like.
       */
      if (/(?:data-[\w-]+|key|className|id|htmlFor|value|href|aria-[\w-]+)=/.test(line)) continue;
      /*
       * Passing it to a translator or a label helper is the fix, not the bug —
       * but only if THIS field is the argument.
       *
       * ★ A fourth correction. Excluding any line containing `t(` hid
       * `{group.category ?? t('rail.uncategorised')}`: the translator wraps
       * the FALLBACK while the raw value renders beside it, which is precisely
       * the defect. The exclusion now requires the field to be inside the
       * call.
       */
      const insideCall = new RegExp(`(?:t|Label|label|displayName)\\([^)]*\\.${field}`);
      if (insideCall.test(line)) continue;
      codeHits.push(`${file}:${index + 1}  renders .${field} as TEXT\n      ${line.trim()}`);
    }
  });
}

/**
 * A count with one hard-coded unit and no larger one.
 *
 * `"{count}h"` is fine for four hours and a lie for 1,444 of them. The tell is
 * a message whose whole value is a placeholder plus one or two letters, with no
 * plural or unit selection around it.
 */
const unitHits: string[] = [];
const messagesDir = join('src', 'i18n', 'messages', 'en');
const visit = (node: unknown, path: string, file: string): void => {
  if (typeof node === 'string') {
    if (/^\{[a-zA-Z]+\}\s?[a-zA-Z׳'"]{1,4}$/.test(node) && !/plural|select/.test(node)) {
      unitHits.push(`${file}  ${path} = ${JSON.stringify(node)}`);
    }
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      visit(child, path ? `${path}.${key}` : key, file);
    }
  }
};
for (const file of readdirSync(messagesDir).filter((f) => f.endsWith('.json'))) {
  visit(JSON.parse(readFileSync(join(messagesDir, file), 'utf8')), '', file);
}

out(`── BACKEND CODES RENDERED DIRECTLY (${codeHits.length}) ──\n`);
for (const hit of codeHits) out(`  ${hit}`);
out(`\n── COUNTS WITH ONE HARD-CODED UNIT (${unitHits.length}) ──\n`);
for (const hit of unitHits) out(`  ${hit}`);
out(
  '\nNeither list is a verdict. A code field may hold a label, and a single-unit\n' +
    'count may be bounded by its source. Check each against the writer: if the\n' +
    'value can be SCREAMING_SNAKE, give it the label the catalogue already has;\n' +
    'if the count can exceed its unit, give it a scale.',
);
