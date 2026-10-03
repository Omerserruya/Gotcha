import { getTranslations } from 'next-intl/server';

import {
  connectedButFailing,
  electable,
  electedElsewhere,
  isInferred,
  partState,
  USE_CASES,
  type BusinessCore as Core,
  type RolePart,
} from '@/api/contracts/business-core';

import { ElectPart } from './ElectPart';
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
/** The chip's tone for each state: working, needs a hand, or nothing to do. */
const CHIP_TONE = {
  chosen: 'good',
  connected_none_chosen: 'warn',
  connected_but_failing: 'warn',
  nothing_connected: 'quiet',
  impossible: 'quiet',
} as const;

/** 02's three groups, and the parts each holds. */
const PART_GROUPS = [
  { key: 'store', roles: ['ecommerce', 'payments', 'shipping', 'returns'] },
  { key: 'leads', roles: ['crm'] },
] as const;

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
      <section className={styles.useCaseRow} data-testid="core-use-case">
        <h2 className={styles.useCaseLabel}>{t('useCase.heading')}</h2>
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
        {/* 02's note beside the control: what the choice does. */}
        <p className={styles.useCaseNote}>{t('useCase.hint')}</p>
        {core.useCase === null ? (
          <p className={styles.hint} data-testid="core-use-case-unset">
            {t('useCase.unset')}
          </p>
        ) : null}
      </section>

      {/*
        02's 14: the parts as ONE table, grouped by what they serve — the
        online store, leads and sales, and what runs across both (write-back).
      */}
      <section className={styles.table} data-testid="core-table">
        {PART_GROUPS.map((group) => {
          const parts = core.roles.filter((part) =>
            (group.roles as readonly string[]).includes(part.role),
          );
          return parts.length > 0 ? (
            <div key={group.key} data-testid={`core-group-${group.key}`}>
              <p className={styles.groupHead}>
                <span className={styles.groupName}>{t(`group.${group.key}`)}</span>
                <span className={styles.groupNote}>{t(`group.${group.key}Note`)}</span>
              </p>
              <ul
                className={styles.parts}
                data-testid={group.key === 'store' ? 'core-parts' : undefined}
              >
                {parts.map((part) => (
                  <li key={part.role}>
                    <Part part={part} t={t} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null;
        })}
        {/*
          ══════════════════════════════════════════════════════════════════════
          14e — WHAT GOTCHA WRITES BACK, AS A PARAGRAPH AND NOT AS A FRAME
          ══════════════════════════════════════════════════════════════════════
          The design draws a panel of write-back settings. There are none. A
          panel of empty controls would say "you have not configured this yet",
          and every one of these is a decision the product has already made and
          will not offer.

          ★ WHICH IS THE WHOLE POINT, AND IT IS ONE SENTENCE.

          ABSENT IS NOT UNSET. When a thing is not listed here as a setting,
          that does not mean nobody has filled it in — it means the connected
          system is the source of truth and GOTCHA follows it. A merchant who
          reads an absence as an omission goes looking for the screen that
          turns it on, and there is no such screen, because there is no such
          choice.

          The three below are stated as absent rather than drawn as disabled.
          A greyed-out control still promises that somewhere, for somebody, it
          is not greyed out.
        */}
        <section className={styles.writeback} data-testid="core-writeback">
          <p className={styles.groupHead}>
            <span className={styles.groupName}>{t('group.both')}</span>
            <span className={styles.groupNote}>{t('writeback.heading')}</span>
          </p>

          <p className={styles.writebackLead} data-testid="core-writeback-source">
            {t('writeback.sourceOfTruth')}
          </p>

          {/*
            ══════════════════════════════════════════════════════════════════
            ★ THE MOST VALUABLE SENTENCE ON THIS PAGE
            ══════════════════════════════════════════════════════════════════
            `crm-adapter-resolver.ts:146-191`. `config.useAsCrm` has THREE
            readings and the third is the one nobody is told about:

              true    Shopify wins over any dedicated CRM — explicitly chosen
              false   never used as CRM — an explicit opt-out
              ABSENT  a connected Shopify is the DEFAULT CRM, whenever no
                      dedicated CRM-category integration is connected

            So this workspace's customer records live in Shopify because a flag
            was never set, not because anybody decided. The resolver's own
            comment says the opt-in-only model was abandoned precisely because
            losing the flag "silently killed identity-link + timeline writeback
            while Shopify sat there connected as the obvious source of truth" —
            a fix for one silent failure that produced a quieter one.

            ★ AND IT IS CONDITIONAL. "Absent means Shopify is the CRM" is FALSE
            for a tenant with HubSpot connected: step 2 finds the dedicated CRM
            first. Stating it unconditionally would tell those merchants their
            records are somewhere they are not, so the condition is on screen.

            Not in the list below, because those are things that cannot be
            configured. This one IS configured — by absence.
          */}
          <p className={styles.writebackLead} data-testid="core-writeback-crm-default">
            {t('writeback.crmDefault')}
          </p>

          {/*
            ★ AND IT STAYS THE SOURCE OF TRUTH WHILE IT IS BROKEN.

            `crm-adapter-resolver.ts:158,178` both match
            `status: { in: ["CONNECTED", "ERROR"] }`. So THIS tenant's Shopify,
            sitting in ERROR with a failed token refresh, is still where its
            customer records resolve.

            Stated as reassurance rather than as alarm, because that is what it
            is. The resolver includes ERROR so an OAuth integration whose token
            merely expired still resolves to its real adapter instead of the
            NoOp stub — otherwise the adapter is never used, the token is never
            refreshed, and the connection deadlocks.

            A merchant watching a failing Shopify would reasonably assume the
            opposite: that their records had quietly moved, or stopped being
            written. They have not. This is the only page that can say so, and
            the last clause says the cost too — the system being written to is
            the one that is down.
          */}
          <p className={styles.writebackLead} data-testid="core-writeback-still-source">
            {t('writeback.stillSourceWhileFailing')}
          </p>

          <ul className={styles.writebackList}>
            {/*
              Per-rule write-back configuration. What is written is decided by
              the kind of action, identically for every rule.
            */}
            <li className={styles.writebackItem} data-testid="core-writeback-per-rule">
              {t('writeback.perRule')}
            </li>
            {/*
              One board per workspace, not one per purpose.

              ★ NOT WRITTEN AS A MONDAY RULE. Omer has no Monday connected, and
              a page built around a connector this workspace does not have asks
              somebody to reason about a system they have never seen — which is
              why the two-board question in the design could not be answered.
              Monday is named as an EXAMPLE, and named as absent.
            */}
            <li className={styles.writebackItem} data-testid="core-writeback-one-board">
              {t('writeback.oneBoard')}
            </li>
          </ul>

          {/*
            ══════════════════════════════════════════════════════════════════
            ★ IDENTITY IS NOT "FIRST MATCH WINS", AND THE MIDDLE CASE IS A WRITE
            ══════════════════════════════════════════════════════════════════
            `crm-identity.service.ts` owns a 0/1/2+ flow, and summarising it as
            "first match wins, new contact if none match" loses the half a
            merchant would most want to know:

              0    create a new lead
              1    ENRICH the existing record with missing strong identifiers —
                   phone, email, PSID, IGSID, username
              2+   auto-merge only with a strong signal AND vendor support;
                   otherwise `needs_approval` with the candidate list

            The one-match case is a WRITE to a customer record that nobody
            asked for. The 2+ case is approval-gated because a wrong merge is
            irreversible — the same Approvals queue as 14d and screen 03.

            Three sentences rather than one: they are three different things
            that happen to somebody, and a merged sentence would hide that the
            middle one edits their data.
          */}
          <ul className={styles.writebackList} data-testid="core-writeback-identity">
            <li className={styles.writebackItem} data-testid="core-identity-none">
              {t('writeback.identityNoMatch')}
            </li>
            <li className={styles.writebackItem} data-testid="core-identity-one">
              {t('writeback.identityOneMatch')}
            </li>
            <li className={styles.writebackItem} data-testid="core-identity-many">
              {t('writeback.identityManyMatches')}
            </li>
          </ul>

          {/*
            ★ WHICH LANGUAGE, AND THE ANSWER IS TWO ANSWERS.

            Held back for a day because "everything written back is in the
            workspace language" was unverified, and it turns out to be half
            right — which is the half that matters.

            `post-chat-pipeline.service.ts` calls `resolveEffectiveLocale({
            tenantId })` with NO userId, deliberately: the post-chat summary
            runs in a background subscriber with no user context, so it takes
            `Tenant.defaultLocale`. The AI-written summary really is in the
            workspace system language.

            But `crm-adapter-resolver.ts` and `connector-connection.service.ts`
            contain no locale reference at all. Names, phone numbers and deal
            fields are the customer's own data, not copy, and nothing
            translates them.

            So the design's one sentence is two, and the split is the useful
            part: it tells a merchant which half they control by changing the
            workspace language and which half they do not.
          */}
          <p className={styles.writebackLead} data-testid="core-writeback-language">
            {t('writeback.language')}
          </p>
        </section>
      </section>

      {/*
        The CRM and returns are elected on their own screens, so this page
        says which parts it does NOT decide. Without it, the two a merchant
        cannot configure here look identical to the two they can.

        The "takes effect once it is wired" caveat that stood here is GONE:
        Backend landed the read at 2d1abf88 and the bot path consumes it
        (`ai-bot.service.ts:1705` → `prompt-builder.service.ts:463`). It was
        removed because it stopped being true, which is what the assertion
        on it existed to force.
      */}
      <p className={styles.hint} data-testid="core-choosing">
        {t('choosing.crmWorks')}
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
  const elsewhere = electedElsewhere(part);

  return (
    <article className={styles.part} data-testid={`core-part-${part.role}`} data-state={state}>
      <div className={styles.partMain}>
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
        ) : isInferred(part) ? (
          /*
          ★ WHAT IT FALLS BACK TO — NOT WHAT ANYBODY CHOSE.

          `returns` resolves to Shopify because the capability resolver found
          it could serve returns. No merchant said so, and the prompt the
          model receives says as much in parentheses: "shopify (inferred, not
          chosen by the business)".

          Drawn as a selection, this would invent consent — the screen would
          show a decision nobody made, and whoever opened it next would
          believe a colleague had made it. So it says which it is, and says
          where a real choice would be made.
        */
          <p className={styles.partInferred} data-testid="core-part-inferred">
            {t('state.inferred', { name: part.elected!.name })}
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
        14c — the control, and ONLY where the server would accept it.

        `electable()` is false for the CRM (elected on its own screen), for a
        part nothing can serve, and for a part with nothing CONNECTED behind
        it. Each of those already has a sentence above saying which case it
        is and where the repair lives; a dropdown beside any of them would be
        a control the write rejects.
      */}
      </div>

      <div className={styles.partControl}>
        {electable(part) ? <ElectPart part={part} /> : null}

        {/*
        The CRM is chosen elsewhere and the screen has to say where. Left
        unexplained, the one part a merchant cannot configure here looks
        identical to the four they can.
      */}
        {elsewhere ? (
          <p
            className={styles.hint}
            data-testid={
              elsewhere === 'crm' ? 'core-part-crm-elsewhere' : 'core-part-returns-elsewhere'
            }
          >
            {elsewhere === 'crm' ? t('crm.elsewhere') : t('returns.elsewhere')}
          </p>
        ) : null}
      </div>

      {/* 02's state chip, from the same three-state reading as the sentence. */}
      <span
        className={styles.chip}
        data-tone={CHIP_TONE[state]}
        data-testid={`core-chip-${part.role}`}
      >
        {t(`chip.${isInferred(part) && state === 'chosen' ? 'inferred' : state}`)}
      </span>
    </article>
  );
}
