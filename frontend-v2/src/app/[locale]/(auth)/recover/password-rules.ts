import { NON_FIELD, type FlowErrors } from '@/api/contracts/auth-flow';

/**
 * The GOTCHA password rule, as a checklist the screen ticks while somebody
 * types (supervisor, 2026-10-22). ★ The server is the authority: these only
 * say early what the policy will say on submit, and "not a known-leaked
 * password" cannot be checked here at all - it is listed, and answered by the
 * submit.
 */
export const PASSWORD_MIN_LENGTH = 12;

export const PASSWORD_RULES = ['length', 'upper', 'lower', 'digit', 'symbol'] as const;
export type PasswordRule = (typeof PASSWORD_RULES)[number];

const TESTS: Readonly<Record<PasswordRule, (password: string) => boolean>> = {
  // Characters as a person counts them, not UTF-16 units.
  length: (p) => [...p].length >= PASSWORD_MIN_LENGTH,
  upper: (p) => /\p{Lu}/u.test(p),
  lower: (p) => /\p{Ll}/u.test(p),
  digit: (p) => /\p{Nd}/u.test(p),
  symbol: (p) => /[^\p{L}\p{N}\s]/u.test(p),
};

/** Which rules this password already meets. */
export function rulesMet(password: string): ReadonlySet<PasswordRule> {
  return new Set(PASSWORD_RULES.filter((rule) => TESTS[rule](password)));
}

/** What the screen says about a refused submit, in its own words. */
export type ResetProblem =
  | { readonly kind: 'required' }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'rules' }
  | { readonly kind: 'weak' }
  | { readonly kind: 'leaked' }
  /** A sentence we have no words for: the server's own, shown as it stands. */
  | { readonly kind: 'said'; readonly text: string };

/**
 * The server's sentences we translate, matched whole: gotcha-password-strength
 * on dev, 2026-10-22 (Backend's capture). Every one carries `code: "invalid"`,
 * so the text is all there is to match on.
 *
 * ★ ONE sentence covers every rule miss (length, case, digit, symbol, breach
 *   wording included); the checklist above the field already says which.
 * ⚠ A sentence not listed is shown as the server wrote it, never dropped: a
 *   refusal with no reason is worse than one in English.
 */
const KNOWN: readonly (readonly [RegExp, ResetProblem['kind']])[] = [
  [
    /^Password must be at least \d+ characters with upper and lower case letters, a number, and a symbol, and must not appear in a known breach\.$/,
    'rules',
  ],
  [/^Password exists on \d+ online lists\.$/, 'leaked'],
  [/^Passwords don't match\.$/, 'mismatch'],
  [/^Password is too weak\.$/, 'weak'],
];

/**
 * A refused prompt's errors as the screen's problems, each kind once.
 *
 * ★ After "too weak", zxcvbn appends its own English advice ("Add another word
 *   or two."). Our sentence for `weak` already says what to do, so its advice
 *   lines are left out rather than shown untranslated on a Hebrew screen.
 */
export function resetProblems(errors: FlowErrors | undefined): readonly ResetProblem[] {
  if (!errors) return [];
  const out: ResetProblem[] = [];
  const add = (problem: ResetProblem) => {
    if (
      problem.kind === 'said'
        ? !out.some((p) => p.kind === 'said' && p.text === problem.text)
        : !out.some((p) => p.kind === problem.kind)
    ) {
      out.push(problem);
    }
  };
  for (const entry of errors[NON_FIELD] ?? []) {
    const text = entry.string.trim();
    if (text === '') continue;
    const known = KNOWN.find(([pattern]) => pattern.test(text));
    if (known) {
      add({ kind: known[1] } as ResetProblem);
      if (known[1] === 'weak') break;
    } else {
      add({ kind: 'said', text });
    }
  }
  for (const [field, list] of Object.entries(errors)) {
    if (field === NON_FIELD) continue;
    for (const entry of list) {
      if (entry.code === 'required') add({ kind: 'required' });
      else if (entry.string.trim() !== '') add({ kind: 'said', text: entry.string.trim() });
    }
  }
  return out;
}
