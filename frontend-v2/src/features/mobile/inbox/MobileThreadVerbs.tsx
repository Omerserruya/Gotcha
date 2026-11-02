'use client';

import { EllipsisVertical, Pause, Sparkles } from 'lucide-react';
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

/**
 * A conversation's verbs on the phone, where the design puts them: the AI
 * switch in the bar ("AI פעיל" / "AI מושהה"), the rest behind the bar's menu.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE INBOX'S OWN ACTIONS, NOT THE DESKTOP'S BUTTONS
 * ════════════════════════════════════════════════════════════════════════════
 * The same server actions as `ConversationVerbs`, so the platform refuses
 * here what it refuses there. Not that component: it lands on the WEBSITE's
 * inbox after a claim (`router.push('/inbox')`), which on the phone left the
 * app. Here a verb refreshes the screen it was pressed on.
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
}) {
  const t = useTranslations('mobile.thread');
  const verbs = useTranslations('inbox.verbs');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [problem, setProblem] = useState<VerbResult | null>(null);
  const [sheet, setSheet] = useState<'claim' | 'transfer' | null>(null);

  const run = (verb: () => Promise<VerbResult>) => {
    setProblem(null);
    setSheet(null);
    startTransition(async () => {
      const outcome = await verb();
      if (outcome.ok) router.refresh();
      else setProblem(outcome);
    });
  };

  // The AI's switch: only where there is an AI to switch, or one to hand back to.
  const aiSwitch = !resolved && (hasAiEmployee || handedOver);
  const paused = handedOver;

  return (
    <>
      {aiSwitch ? (
        <button
          type="button"
          className={styles.aiSwitch}
          data-paused={paused ? '' : undefined}
          disabled={isPending || (paused && !hasAiEmployee)}
          aria-label={paused ? t('ai.resume') : t('ai.pause')}
          data-testid="mobile-ai-switch"
          onClick={() => run(() => (paused ? returnToAi(conversationId) : stopAi(conversationId)))}
        >
          {paused ? (
            <Pause aria-hidden size={15} strokeWidth={2} />
          ) : (
            <Sparkles aria-hidden size={15} strokeWidth={2} />
          )}
          <span>{paused ? t('ai.paused') : t('ai.active')}</span>
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
          {!resolved ? (
            <MenuItem onSelect={() => run(() => closeConversation(conversationId))}>
              {verbs('resolve')}
            </MenuItem>
          ) : null}
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
