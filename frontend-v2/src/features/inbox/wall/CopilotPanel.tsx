'use client';

import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { useDirection } from '@/i18n/direction-context';

import {
  copilotPanelKey,
  readCopilotOpen,
  subscribeCopilotPanel,
  writeCopilotOpen,
} from './copilot-panel-state';
import styles from './Wall.module.css';

interface PanelControl {
  readonly controls: string;
  readonly collapse: () => void;
}

const PanelContext = createContext<PanelControl | null>(null);

/**
 * The Copilot's column, which the agent can fold to a slim strip and open
 * again (Omer, 2026-10-25) - legacy's Copilot panel closed the same way.
 *
 * ★ Folded is HIDDEN, NOT GONE. Everything inside stays mounted, so the
 *   private thread, a half-typed question and the wall's reads are exactly
 *   where they were on reopening; nothing is read again.
 * ★ The strip sits at the panel's own edge, which is the left in Hebrew:
 *   logical properties throughout, and the icons follow the direction.
 * ★ Focus follows the control: folding lands on "show", showing lands back
 *   on "hide", so a keyboard never loses its place.
 */
export function CopilotPanel({
  userId,
  className,
  label,
  children,
}: {
  readonly userId: string | null;
  readonly className: string | undefined;
  readonly label: string;
  readonly children: ReactNode;
}) {
  const t = useTranslations('inbox.wall');
  const rtl = useDirection() === 'rtl';
  const key = copilotPanelKey(userId);
  // The server draws it open; a person who folded it sees it folded on hydration.
  const open = useSyncExternalStore(
    subscribeCopilotPanel,
    () => readCopilotOpen(key),
    () => true,
  );
  const id = useId();
  // Which control a person's own click should leave focus on; none on mount.
  const [focusTo, setFocusTo] = useState<'show' | 'hide' | null>(null);

  useEffect(() => {
    if (focusTo !== null) document.getElementById(`${id}-${focusTo}`)?.focus();
  }, [open, focusTo, id]);

  const collapse = () => {
    setFocusTo('show');
    writeCopilotOpen(key, false);
  };
  const reopen = () => {
    setFocusTo('hide');
    writeCopilotOpen(key, true);
  };
  const Show = rtl ? PanelLeftOpen : PanelRightOpen;

  return (
    <aside
      id={id}
      className={[className, styles.panel].filter(Boolean).join(' ')}
      aria-label={label}
      data-collapsed={open ? undefined : '1'}
      data-testid="copilot-panel"
    >
      {open ? null : (
        <button
          id={`${id}-show`}
          type="button"
          className={styles.reopen}
          onClick={reopen}
          aria-expanded={false}
          aria-controls={id}
          aria-label={t('show')}
          title={t('show')}
          data-testid="copilot-reopen"
        >
          <Show size={16} aria-hidden="true" />
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.reopenName} aria-hidden="true">
            {t('name')}
          </span>
        </button>
      )}
      <PanelContext.Provider value={{ controls: id, collapse }}>{children}</PanelContext.Provider>
    </aside>
  );
}

/** "Hide", at the end of the wall's header. Nothing outside a `CopilotPanel`. */
export function CollapseCopilot() {
  const t = useTranslations('inbox.wall');
  const rtl = useDirection() === 'rtl';
  const panel = useContext(PanelContext);
  if (!panel) return null;
  const Hide = rtl ? PanelLeftClose : PanelRightClose;
  return (
    <button
      id={`${panel.controls}-hide`}
      type="button"
      className={styles.collapse}
      onClick={panel.collapse}
      aria-expanded={true}
      aria-controls={panel.controls}
      aria-label={t('hide')}
      title={t('hide')}
      data-testid="copilot-collapse"
    >
      <Hide size={16} aria-hidden="true" />
    </button>
  );
}
