import en from '@/i18n/messages/en/approvals.json';
import he from '@/i18n/messages/he/approvals.json';

/**
 * A rejection's reason, said in the reader's language when it was one of
 * ours. The reject buttons send their LABEL as `decisionReason`, in whatever
 * language the decider had — so a Hebrew reader saw "Outside policy · נדחה"
 * (measured on dev). A label from any catalogue maps back to its key; free
 * text — typed under "Other", or written by the platform — is the writer's
 * own words and stays as it is.
 */
const REASONS = {
  policy: (m: typeof en) => m.action2.reasons.policy,
  myself: (m: typeof en) => m.action2.reasons.myself,
  wrongOrder: (m: typeof en) => m.action2.reasons.wrongOrder,
  tooGenerous: (m: typeof en) => m.reject3.tooGenerous,
} as const;

export type ReasonKey = keyof typeof REASONS;

const BY_LABEL = new Map<string, ReasonKey>(
  (Object.keys(REASONS) as ReasonKey[]).flatMap((key) =>
    [en, he as unknown as typeof en].map(
      (m) => [REASONS[key](m).trim().toLowerCase(), key] as const,
    ),
  ),
);

/** The key of one of our reasons, or `null` for anyone's own words. */
export function reasonKeyOf(text: string): ReasonKey | null {
  return BY_LABEL.get(text.trim().toLowerCase()) ?? null;
}
