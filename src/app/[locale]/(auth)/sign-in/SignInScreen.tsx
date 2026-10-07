'use client';

import { useState, type ReactNode } from 'react';

import { SignInPanel, type SignInScreenName } from '@/features/auth/SignInPanel';

import styles from './SignIn.module.css';

/**
 * The two halves of screens 00a and 00b, composed around one stage.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ WHY THIS EXISTS: THE PAGE COULD NOT KNOW WHICH SCREEN WAS SHOWING
 * ════════════════════════════════════════════════════════════════════════════
 * The editorial panel and the footnote were server-rendered siblings of
 * `SignInPanel`, which owns the flow stage in client state. Nothing connected
 * them, so the second-factor screen wore the sign-in screen's figures **and**
 * its footnote - *"New here? Ask your workspace admin for an invitation."*,
 * which is not merely the wrong copy on 00b but an actively wrong statement to
 * somebody already halfway signed in.
 *
 * ── WHY SLOTS AND NOT COPY IN HERE ──
 * Every string still comes from the server page, rendered there and handed
 * across as `ReactNode`. This component decides **which** of them is on screen
 * and nothing else - no `useTranslations`, no catalogue, no copy.
 *
 * ★ That is what keeps the panel bundle from growing: the two editorials are
 *   already-rendered markup, not two catalogues plus a switch.
 *
 * ── AND WHY THE FRAME MOVED HERE RATHER THAN THE STAGE MOVING UP ──
 * The alternative was lifting the whole flow state out of `SignInPanel` into a
 * new owner. That is a larger change to the component with the most tests on
 * it, on the screen that holds a password, for no gain: the stage belongs
 * where the stage machine is, and what the layout needs is one fact about it.
 * A callback carries that fact; nothing else moves.
 */
export function SignInScreen({
  handOverHref,
  recoverPath,
  returnTo,
  notice,
  brand,
  status,
  figures,
  footnote,
  ticks,
}: {
  readonly handOverHref: string;
  readonly recoverPath: string;
  readonly returnTo?: string;
  /** The `?error=` explanation, when there is one. Sign-in only. */
  readonly notice?: ReactNode;
  readonly brand: ReactNode;
  readonly ticks: ReactNode;
  /** One per screen - the rotating figures and the line under the ticks. */
  readonly figures: Record<SignInScreenName, ReactNode>;
  /**
   * The line after the ticks. `null`: none, and no dot - sign-in had "All
   * systems operational", fixed, with a green dot: a health claim nothing
   * measured (Omer: no dummy data). It returns only from a real check.
   */
  readonly status: Record<SignInScreenName, ReactNode | null>;
  /**
   * Sign-in only, and deliberately absent on the second factor: "New here?"
   * is a question somebody mid-sign-in has already answered.
   */
  readonly footnote: ReactNode;
}) {
  const [screen, setScreen] = useState<SignInScreenName>('signIn');

  return (
    <div className={styles.frame}>
      <aside className={styles.editorial}>
        {brand}

        {/*
          Both editorials are in the tree; one is rendered. `aria-hidden` and
          the reduced-motion rules live in the stylesheet, on the stage itself,
          so they hold whichever screen is showing.
        */}
        {figures[screen]}

        <div className={styles.systemStatus}>
          {ticks}
          {status[screen] ? (
            <>
              <span className={styles.editorialRule} aria-hidden="true" />
              <span className={styles.statusDot} aria-hidden="true" />
              {status[screen]}
            </>
          ) : null}
        </div>
      </aside>

      <main className={styles.surface}>
        {/*
          ★★ THE COLUMN IS NOT THE SAME WIDTH ON BOTH SCREENS.
          00a's mock gives the form `width:400px`; 00b's gives it `430px`.
          Thirty pixels, and it is the column the six code slots divide - so
          it is not only the column that changes width.
        */}
        <div className={styles.form} data-screen={screen}>
          {screen === 'signIn' ? notice : null}

          <SignInPanel
            handOverHref={handOverHref}
            recoverPath={recoverPath}
            returnTo={returnTo}
            onScreen={setScreen}
          />

          {screen === 'signIn' ? footnote : null}
        </div>
      </main>
    </div>
  );
}
