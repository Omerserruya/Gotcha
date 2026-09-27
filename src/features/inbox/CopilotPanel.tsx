import { getTranslations } from 'next-intl/server';

import { confidenceBand, copilotSentinel, isDraft } from '@/api/contracts/copilot';
import { UserText } from '@/design-system/primitives/text/UserText';

import type { CopilotRead } from './load-copilot';
import styles from './Inbox.module.css';

/**
 * What GOTCHA would say — screen 02's missing copilot panel.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE INTERESTING PART IS THE FOUR WAYS IT IS EMPTY
 * ════════════════════════════════════════════════════════════════════════════
 * A single "no suggestions" state would tell an agent the AI had no ideas, when
 * the truth may be that their plan does not include Copilot, or that the model
 * call failed. Those want three different actions from the reader: write it
 * yourself, ask someone who can change the plan, or try again.
 *
 * And the refusal splits again, because `FEATURE_NOT_AVAILABLE` means **the
 * product has not built this** — `isEntitled` returns false for an unsellable
 * key — so no plan change lifts it and offering an upgrade would sell somebody
 * something that does not exist.
 *
 * ── NO CONTROL ON A PROPOSED ACTION ──
 * A suggestion of type `quick_action` carries a tool name and arguments the model
 * proposed. **Firing a tool is the one thing this panel must never make easy**:
 * the approvals screen exists for that decision, with a keyboard model built
 * around the fact that this platform has no undo anywhere. So an action is shown
 * as what the AI would do, and it has no button.
 *
 * ── AND NO INSERT BUTTON EITHER, YET ──
 * A draft is text an agent might send, and the control that would send it is the
 * composer, which is not built. A button that puts text somewhere there is
 * nothing to put it into would be a control that does nothing.
 */
export async function CopilotPanel({ read }: { readonly read: CopilotRead }) {
  const t = await getTranslations('inbox.copilot');

  if (read.state === 'unavailable') {
    return (
      <section className={styles.copilot} data-testid="copilot-unavailable">
        <h3 className={styles.copilotHeading}>{t('heading')}</h3>
        {/*
          We asked and could not get an answer. Distinct from every other empty
          state here, and the only one where trying again is the right move.
        */}
        <p className={styles.copilotNote}>{t('unavailable')}</p>
      </section>
    );
  }

  if (read.state === 'refused') {
    const { code, upgradePath } = read.refusal;
    return (
      <section className={styles.copilot} data-testid="copilot-refused" data-code={code}>
        <h3 className={styles.copilotHeading}>{t('heading')}</h3>
        <p className={styles.copilotNote} data-testid="copilot-refusal-reason">
          {code === 'FEATURE_NOT_AVAILABLE'
            ? /*
               * ★★ NOT AN UPGRADE PROMPT. This code means the product has not
               * built the capability, so there is nothing to buy and no plan
               * that includes it.
               */
              t('notBuilt')
            : code === 'PLAN_LIMIT_REACHED'
              ? t('limitReached')
              : t('notOnPlan')}
        </p>
        {/*
          The link only where a plan change would actually help, and only when the
          platform named a destination. Inventing one would send somebody to a
          page that may not exist under this app's base path.
        */}
        {code !== 'FEATURE_NOT_AVAILABLE' && upgradePath ? (
          <p className={styles.copilotNote} data-testid="copilot-upgrade">
            {t('whereToChange')}
          </p>
        ) : null}
      </section>
    );
  }

  const { data: suggestions, copilotMode } = read.response;
  const mode = copilotMode.trim().toUpperCase();

  if (mode !== 'READY_MESSAGE') {
    return (
      <section className={styles.copilot} data-testid="copilot-other-mode" data-mode={mode}>
        <h3 className={styles.copilotHeading}>{t('heading')}</h3>
        {/*
          ★★ `CHAT` IS A DIFFERENT PANEL, NOT A DIFFERENT LIST. It is a
          conversation between the agent and the AI, with its own write behind it.
          Rendering ready messages for it would show drafts the tenant's
          configuration did not ask for, which is worse than saying so.
        */}
        <p className={styles.copilotNote}>{t('otherMode')}</p>
      </section>
    );
  }

  /*
   * ════════════════════════════════════════════════════════════════════════════
   * ★★ THE PROVIDER REPORTS ITS OWN FAILURES INSIDE THE LIST, AS A 200
   * ════════════════════════════════════════════════════════════════════════════
   * A browser walk read *"Failed to get AI suggestions. Check API key and model
   * configuration."* out of this panel, in the position where a draft reply goes.
   * A support agent was being told to check an API key.
   *
   * It is not an envelope, not a status and not a 402 — it is a one-item list with
   * a sentinel id, so the four honest empty states above could not see it. There
   * are five such sentinels and they mean different things: a failed provider, no
   * provider, Copilot switched off, no employee to draft with, and nothing
   * relevant. Only the last is the ordinary empty case.
   *
   * ★ None of these sentences hands the reader an operational instruction. Two of
   *   them are genuinely actionable and say who can act — an admin — because
   *   "ask somebody who can change this" is advice a support agent can use and
   *   "check API key and model configuration" is not.
   */
  const sentinel = copilotSentinel(suggestions);
  if (sentinel !== null) {
    return (
      <section className={styles.copilot} data-testid="copilot-sentinel" data-sentinel={sentinel}>
        <h3 className={styles.copilotHeading}>{t('heading')}</h3>
        <p className={styles.copilotNote} data-testid="copilot-sentinel-note">
          {sentinel === 'provider_failed'
            ? t('providerFailed')
            : sentinel === 'no_provider'
              ? t('noProvider')
              : sentinel === 'switched_off'
                ? t('switchedOff')
                : sentinel === 'no_employee'
                  ? t('noEmployee')
                  : /* `no-match`: asked, answered, nothing to say. */
                    t('none')}
        </p>
      </section>
    );
  }

  if (suggestions.length === 0) {
    return (
      <section className={styles.copilot} data-testid="copilot-empty">
        <h3 className={styles.copilotHeading}>{t('heading')}</h3>
        {/*
          Asked, answered, nothing to say. The one empty state that means the
          agent should simply write the reply.
        */}
        <p className={styles.copilotNote}>{t('none')}</p>
      </section>
    );
  }

  return (
    <section className={styles.copilot} data-testid="copilot-panel">
      <h3 className={styles.copilotHeading}>{t('heading')}</h3>
      <ul className={styles.copilotList}>
        {suggestions.map((suggestion) => (
          <li
            key={suggestion.id}
            className={styles.copilotItem}
            data-testid={`suggestion-${suggestion.id}`}
            data-draft={isDraft(suggestion) ? 'yes' : 'no'}
          >
            <p className={styles.copilotMeta} data-testid={`suggestion-meta-${suggestion.id}`}>
              {/*
                ★ A BAND, NEVER A PERCENTAGE. Two decimal places on a model's
                self-report is a precision claim nothing supports — and `null` is
                "the model did not say", which is not "the model is unsure".
              */}
              {[
                t(`confidence.${confidenceBand(suggestion)}` as 'confidence.high'),
                isDraft(suggestion) ? null : t('proposal'),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>

            {/* The model's own words, isolated: it writes in the customer's language. */}
            <UserText className={styles.copilotText}>{suggestion.text}</UserText>

            {suggestion.approach?.trim() ? (
              <p className={styles.copilotWhy} data-testid={`suggestion-approach-${suggestion.id}`}>
                <UserText>{suggestion.approach}</UserText>
              </p>
            ) : null}
            {suggestion.rationale?.trim() ? (
              <p className={styles.copilotWhy}>
                <UserText>{suggestion.rationale}</UserText>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
