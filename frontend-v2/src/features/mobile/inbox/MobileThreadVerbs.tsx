'use client';

import { EllipsisVertical, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/design-system/primitives/overlay/Menu';
import { Sheet, SheetClose, SheetContent } from '@/design-system/primitives/overlay/Dialog';
import {
  claimConversation,
  closeConversation,
  returnToAi,
  stopAi,
  transferConversation,
  type VerbResult,
} from '@/features/inbox/conversation-actions';
import { initials } from '@/features/inbox/initials';
import { useRouter } from '@/i18n/navigation';

import ui from '../mobile-ui.module.css';
import styles from './mobile-inbox.module.css';
import { threadAiControl } from './thread-verbs';

/**
 * A conversation's verbs on the phone: "החזר ל‑AI" in the bar when a person
 * holds it and there is an AI to hand it back to, the rest behind the bar's
 * menu (`thread-verbs.ts` says which, and why there is no switch any more).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE INBOX'S OWN ACTIONS, NOT THE DESKTOP'S BUTTONS
 * ════════════════════════════════════════════════════════════════════════════
 * The same server actions as `ConversationVerbs`, so the platform refuses
 * here what it refuses there. Not that component: it lands on the WEBSITE's
 * inbox after a claim (`router.push('/inbox')`), which on the phone left the
 * app. Here a verb refreshes the screen it was pressed on.
 *
 * ★ HANDED BACK, IT IS NO LONGER "MINE": `returnToAi` unassigns the person, so
 *   the screen goes back to the inbox rather than staying on a conversation
 *   that has just left the reader's list.
 *
 * ★ Pausing the AI is `stopAi`, which assigns nobody and greets nobody. Taking
 *   the conversation is a separate, louder verb, because it sends the
 *   customer the workspace's greeting with this person's name in it - so it
 *   asks first, in the desktop's own words.
 */
export function MobileThreadVerbs({
  conversationId,
  mine,
  handedOver,
  hasAiEmployee,
  greeting,
  colleagues,
  resolved,
  websiteHref,
  customerHref,
}: {
  readonly conversationId: string;
  readonly mine: boolean;
  readonly handedOver: boolean;
  readonly hasAiEmployee: boolean;
  readonly greeting: boolean | null;
  readonly colleagues: readonly { readonly id: string; readonly name: string }[];
  readonly resolved: boolean;
  /** The conversation on the website: the copilot wall, the commerce panel. */
  readonly websiteHref: string;
  /** The phone's own screen of what is known about the customer. */
  readonly customerHref: string;
}) {
  const t = useTranslations('mobile.thread');
  const verbs = useTranslations('inbox.verbs');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [problem, setProblem] = useState<VerbResult | null>(null);
  const [sheet, setSheet] = useState<'claim' | 'transfer' | null>(null);

  /** A verb, then this screen again - or, with `leave`, the inbox. */
  const run = (verb: () => Promise<VerbResult>, leave = false) => {
    setProblem(null);
    setSheet(null);
    startTransition(async () => {
      const outcome = await verb();
      if (!outcome.ok) setProblem(outcome);
      else if (leave) router.replace('/m/inbox');
      else router.refresh();
    });
  };

  const ai = threadAiControl({ resolved, handedOver, hasAiEmployee });

  return (
    <>
      {ai.returnToAi ? (
        <button
          type="button"
          className={styles.aiSwitch}
          disabled={isPending}
          data-testid="mobile-return-to-ai"
          onClick={() => run(() => returnToAi(conversationId), true)}
        >
          <Sparkles aria-hidden size={15} strokeWidth={2} />
          <span>{t('ai.return')}</span>
        </button>
      ) : null}

      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className={styles.barIcon}
            aria-label={t('menu')}
            disabled={isPending}
            data-testid="mobile-thread-menu"
          >
            <EllipsisVertical aria-hidden size={21} strokeWidth={2} />
          </button>
        </MenuTrigger>
        <MenuContent align="end" side="bottom">
          {!mine && !resolved ? (
            <MenuItem onSelect={() => (greeting === false ? run(() => claimConversation(conversationId)) : setSheet('claim'))}>
              {verbs('claim')}
            </MenuItem>
          ) : null}
          {mine && colleagues.length > 0 ? (
            <MenuItem onSelect={() => setSheet('transfer')}>{verbs('transfer')}</MenuItem>
          ) : null}
          {ai.pauseInMenu ? (
            <MenuItem onSelect={() => run(() => stopAi(conversationId))}>{t('ai.pause')}</MenuItem>
          ) : null}
          {!resolved ? (
            <MenuItem onSelect={() => run(() => closeConversation(conversationId))}>
              {verbs('resolve')}
            </MenuItem>
          ) : null}
          <MenuItem onSelect={() => router.push(customerHref as '/m/inbox')}>
            {t('customer')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              window.location.href = websiteHref;
            }}
          >
            {t('website')}
          </MenuItem>
        </MenuContent>
      </Menu>

      <Sheet open={sheet !== null} onOpenChange={(open) => (open ? null : setSheet(null))}>
        {sheet === 'claim' ? (
          <SheetContent title={verbs('claim')}>
            <p className={styles.sheetText}>
              {greeting === true ? verbs('greetingSends') : verbs('greetingMaybe')}
            </p>
            <button
              type="button"
              className={`${ui.primary} ${styles.sheetAction}`}
              data-testid="mobile-claim-confirm"
              onClick={() => run(() => claimConversation(conversationId))}
            >
              {verbs('claim')}
            </button>
            <SheetClose asChild>
              <button type="button" className={`${ui.secondary} ${styles.sheetAction}`}>
                {t('cancel')}
              </button>
            </SheetClose>
          </SheetContent>
        ) : sheet === 'transfer' ? (
          <SheetContent title={verbs('transferTo')}>
            <ul className={styles.sheetList}>
              {colleagues.map((colleague) => (
                <li key={colleague.id}>
                  <button
                    type="button"
                    className={styles.sheetRow}
                    onClick={() => run(() => transferConversation(conversationId, colleague.id))}
                  >
                    <span className={styles.sheetAvatar} aria-hidden="true">
                      {initials(colleague.name)}
                    </span>
                    <span className={styles.sheetRowName}>{colleague.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </SheetContent>
        ) : null}
      </Sheet>

      {problem !== null && !problem.ok ? (
        <p className={styles.verbProblem} role="alert" data-testid="mobile-verb-problem">
          {verbs(`problem.${problem.reason}` as 'problem.failed')}
        </p>
      ) : null}
    </>
  );
}
