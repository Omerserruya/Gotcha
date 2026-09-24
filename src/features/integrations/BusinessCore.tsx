import { getTranslations } from 'next-intl/server';

import {
  connectedButFailing,
  electedElsewhere,
  partState,
  USE_CASES,
  type BusinessCore as Core,
  type RolePart,
} from '@/api/contracts/business-core';

import styles from './BusinessCore.module.css';

/**
 * Business core — screens 14b and 14c.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * BUILT FOR THE STATE THE PLATFORM PRODUCES, NOT THE ONE THE DESIGN DRAWS
 * ════════════════════════════════════════════════════════════════════════════
 * The design shows five parts with a system chosen for each. Measured here:
 * one part nothing can ever serve, three with nothing connected, and one
 * whose only candidate is connected and BROKEN.
 *
 * So this is a screen that routes somebody to the marketplace and back. The
 * filled-in state is the one that happens later; building for it first gives
 * a screen that is beautiful once and useless on day one.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★ "CONNECT ONE" IS THE WRONG INSTRUCTION FOR A BROKEN CONNECTION
 * ════════════════════════════════════════════════════════════════════════════
 * Three states, not two:
 *
 *   never connected        nothing started        → connect one
 *   connected but failing  the work is done and   → FIX it
 *                          something is wrong
 *   connected              usable                 → nothing to do
 *
 * An empty dropdown tells a merchant who already connected Shopify to go and
 * connect Shopify. Both routes end at the marketplace and the sentences must
 * differ, because one of them asks somebody to redo work they have done.
 */
export async function BusinessCore({ core }: { readonly core: Core | null }) {
  const t = await getTranslations('business-core');

  if (core === null) {
    return (
      <p className={styles.unavailable} data-testid="core-unavailable">
        {t('unavailable')}
      </p>
    );
  }

  return (
    <section className={styles.core} data-testid="business-core">
      {/*
        14b. The use case decides which parts are asked about at all — "a lead
        business is not asked about shipping or returns, and asking would be
        the invented-gap bug the discovery engine already learned".
      */}
      <section data-testid="core-use-case">
        <h2 className={styles.heading}>{t('useCase.heading')}</h2>
        <p className={styles.hint}>{t('useCase.hint')}</p>
        <ul className={styles.useCases}>
          {USE_CASES.map((useCase) => (
            <li
              key={useCase}
              className={styles.useCase}
              data-testid={`core-use-case-${useCase}`}
              data-selected={core.useCase === useCase}
            >
              {t(`useCase.${useCase}`)}
            </li>
          ))}
        </ul>
        {core.useCase === null ? (
          <p className={styles.hint} data-testid="core-use-case-unset">
            {t('useCase.unset')}
          </p>
        ) : null}
      </section>

      {core.roles.length > 0 ? (
        <ul className={styles.parts} data-testid="core-parts">
          {core.roles.map((part) => (
            <li key={part.role}>
              <Part part={part} t={t} />
            </li>
          ))}
        </ul>
      ) : null}

      {/*
        ★ SAID, NOT IMPLIED.
        The election endpoint exists. Its success and displacement paths have
        never run against a real connection — no integration on this
        deployment is CONNECTED — so the control is not put in front of
        somebody as though it were proven. Built and verified are different
        words.
      */}
      <p className={styles.hint} data-testid="core-choosing-not-yet">
        {t('choosing.notYet')} {t('choosing.crmWorks')}
      </p>

      {/*
        Two facts the catalogue cannot express, written once server-side so
        each client does not rediscover them. Rendered verbatim.
      */}
      {core.catalogueNotes.length > 0 ? (
        <section data-testid="core-notes">
          <h3 className={styles.notesHeading}>{t('notesHeading')}</h3>
          <ul className={styles.notes}>
            {core.catalogueNotes.map((note) => (
              <li key={note} className={styles.note}>
                {note}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function Part({
  part,
  t,
}: {
  readonly part: RolePart;
  readonly t: Awaited<ReturnType<typeof getTranslations<'business-core'>>>;
}) {
  const state = partState(part);
  const failing = part.candidates.find((c) => connectedButFailing(c));

  return (
    <article className={styles.part} data-testid={`core-part-${part.role}`} data-state={state}>
      <p className={styles.partName}>{t(`part.${part.role}`)}</p>

      {state === 'impossible' ? (
        /*
          "Nothing exists to choose" — not the tenant's doing, and the
          sentence says so. An empty dropdown here would read as something
          they had failed to set up.
        */
        <p className={styles.partState} data-testid="core-part-impossible">
          {t('state.impossible')}
        </p>
      ) : state === 'connected_but_failing' && failing ? (
        <p className={styles.partFailing} data-testid="core-part-failing">
          {t('state.connected_but_failing', { name: failing.name })}
        </p>
      ) : state === 'nothing_connected' ? (
        <p className={styles.partState} data-testid="core-part-nothing">
          {t('state.nothing_connected', {
            systems: part.candidates.map((c) => c.name).join(', '),
          })}
        </p>
      ) : state === 'chosen' ? (
        <p className={styles.partState} data-testid="core-part-chosen">
          {t('state.chosen', { name: part.elected!.name })}
        </p>
      ) : (
        <p className={styles.partState} data-testid="core-part-unchosen">
          {t('state.connected_none_chosen')}
        </p>
      )}

      {/*
        The CRM is chosen elsewhere and the screen has to say where. Left
        unexplained, the one part a merchant cannot configure here looks
        identical to the four they can.
      */}
      {electedElsewhere(part) ? (
        <p className={styles.hint} data-testid="core-part-crm-elsewhere">
          {t('crm.elsewhere')}
        </p>
      ) : null}
    </article>
  );
}
