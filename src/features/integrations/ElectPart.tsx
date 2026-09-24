'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import type { RolePart } from '@/api/contracts/business-core';

import { electRole, type ElectResult } from './actions';
import styles from './BusinessCore.module.css';

/**
 * Screen 14c — choosing which system plays a part.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT IS IN THE DROPDOWN, AND WHAT DELIBERATELY IS NOT
 * ════════════════════════════════════════════════════════════════════════════
 * Only CONNECTED candidates. The write refuses anything else, so a broken
 * Shopify in the list would be a choice the server rejects on save — and the
 * merchant would read the rejection as the screen failing rather than as
 * their shop being down. The failing system keeps its own sentence and its
 * own repair, above.
 *
 * ── ★ AND "+ CONNECT A NEW SYSTEM" IS NOT A LINK, BECAUSE THERE IS NOWHERE
 *      IN THIS APP TO LINK TO ──
 * Omer asked for the entry and it belongs here — it is what somebody looks
 * for when the answer they want is not in the list. But connecting happens
 * in the platform's own marketplace, which this app has no route to and no
 * configured URL for: `NEXT_PUBLIC_*` carries the realtime host and nothing
 * else, and the `marketplace` copy has sat unused in both catalogues since
 * 14b.
 *
 * So it says where, rather than offering an anchor that 404s. Same call as
 * 14c's banner, which declines to draw Reconnect for an OAuth system because
 * the handshake returns to whichever app `FRONTEND_URL` names and not to
 * this one. A dead link is worse than a sentence: it reads as the product
 * failing at the exact moment somebody is trying to give it more to work
 * with.
 *
 * ── NO OPTIMISM HERE, UNLIKE THE MFA SWITCHES ──
 * That screen moves the control first and corrects on failure, because a
 * switch that waits reads as broken. This one does not: the interesting
 * answer is what the save DISPLACED — "it was WooCommerce" — and that fact
 * only exists after the round trip. Moving first would mean rendering the
 * new state and then the sentence explaining a change the screen has already
 * finished animating.
 *
 * ── ★ AND SAVING IT DOES NOT YET CHANGE WHAT THE AI DOES ──
 * `config.roles` is read in exactly one place in the monorepo — the
 * displacement logic inside this very write. Nothing in the AI's decision
 * path reads it. The mapping is stored and it is real; it is not yet acted
 * on, and the screen says so rather than letting somebody choose a system
 * and assume their AI changed behaviour. The sentence comes out when
 * Backend's read path lands.
 *
 * That is narrower than the sentence this screen carried yesterday. The old
 * one said the write had never been watched to succeed. This one says the
 * write works and nothing downstream is listening yet.
 */
export function ElectPart({ part }: { readonly part: RolePart }) {
  const t = useTranslations('business-core');
  const connected = part.candidates.filter((c) => c.connected);

  const [choice, setChoice] = useState(part.elected?.slug ?? '');
  const [result, setResult] = useState<ElectResult | null>(null);
  const [isPending, startTransition] = useTransition();

  /*
   * Nothing connected means nothing to choose between. The part's own
   * three-state sentence already says which of the reasons applies and where
   * the repair is, so an empty dropdown here would be a second, worse copy
   * of it — a control implying the answer is a selection away.
   */
  if (connected.length === 0) return null;

  function save(slug: string) {
    setResult(null);
    startTransition(async () => {
      setResult(await electRole(part.role, slug));
    });
  }

  return (
    <div className={styles.elect} data-testid={`core-elect-${part.role}`}>
      <label className={styles.electLabel}>
        <span className={styles.electLabelText}>{t('elect.label')}</span>
        <select
          className={styles.electSelect}
          data-testid={`core-elect-select-${part.role}`}
          value={choice}
          disabled={isPending}
          onChange={(event) => setChoice(event.target.value)}
        >
          {/*
            An explicit empty option. Without one, a part with nothing chosen
            shows the first system as though it had been picked — which is
            the calm wrong value: not an error, not a blank, just somebody
            else's decision wearing the merchant's.
          */}
          <option value="">{t('elect.none')}</option>
          {connected.map((candidate) => (
            <option key={candidate.slug} value={candidate.slug}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        className={styles.electSave}
        data-testid={`core-elect-save-${part.role}`}
        disabled={isPending || choice === '' || choice === (part.elected?.slug ?? '')}
        onClick={() => save(choice)}
      >
        {isPending ? t('elect.saving') : t('elect.save')}
      </button>

      {/*
        The way out of the list — named, not linked. See the note above.
      */}
      <p className={styles.electConnect} data-testid="core-elect-connect">
        {t('elect.connectNew')}
      </p>

      {/*
        THE ANSWER, AND THE DISPLACEMENT IS THE PART WORTH SAYING.

        The write displaces rather than refusing when a part is taken —
        refusing would recreate the undeletable-employee trap, where somebody
        is blocked by a state they cannot see and did not set. Silent
        displacement is the reassuring direction, so it succeeds and names
        what it replaced.
      */}
      {result?.ok === true ? (
        <p className={styles.electOk} data-testid={`core-elect-ok-${part.role}`}>
          {result.data.replaced
            ? t('elect.replaced', { name: result.data.replaced.name })
            : t('elect.saved')}
        </p>
      ) : null}

      {result?.ok === false ? (
        <p className={styles.electError} data-testid={`core-elect-error-${part.role}`}>
          {/*
            Four failures, four sentences. A 409 here means three entirely
            different things — not connected, the CRM's own screen, returns'
            own switch — and a single "couldn't save that" would send
            somebody to reconnect a system that is working perfectly, or to
            the wrong screen half the time.
          */}
          {result.reason === 'not_connected'
            ? t('elect.error.notConnected')
            : result.reason === 'crm_elsewhere'
              ? t('crm.elsewhere')
              : result.reason === 'returns_elsewhere'
                ? t('returns.elsewhere')
                : t('elect.error.failed')}
        </p>
      ) : null}
    </div>
  );
}
