'use client';

import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';

import styles from './AppShell.module.css';
import { OPEN_COMMAND_PALETTE } from './CommandPalette';

/**
 * The platform's command modifier, as an external store.
 *
 * The value never changes for the lifetime of the page, so `subscribe` is a
 * no-op. `useSyncExternalStore` is still the right primitive: it reads during
 * render with a distinct server snapshot, which is what avoids both a
 * hydration mismatch and a mount-time `setState` cascade.
 */
const noopSubscribe = () => () => {};
const clientModifier = () => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K');
/* The server cannot know the platform; ⌘K is what the design draws. */
const serverModifier = () => '⌘K';

/**
 * The ⌘K affordance in the foot of the rail.
 *
 * "⌘K covers both finding and doing." The palette itself is not built yet - it
 * is a product surface and its contract is undefined. The affordance and the
 * shortcut exist now because an operator who learns it on day one should not
 * have to unlearn it later.
 */
export function CommandHint() {
  const t = useTranslations('navigation');
  const modifier = useSyncExternalStore(noopSubscribe, clientModifier, serverModifier);

  return (
    <button
      type="button"
      className={styles.commandHint}
      data-testid="command-hint"
      onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
    >
      <kbd className={styles.commandKey}>{modifier}</kbd>
      <span className={styles.commandHintLabel}>{t('commandPalette')}</span>
    </button>
  );
}
