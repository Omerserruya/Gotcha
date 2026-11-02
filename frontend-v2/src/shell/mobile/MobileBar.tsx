import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { DirectionalIcon } from '@/design-system/patterns/DirectionalIcon';
import { Link } from '@/i18n/navigation';

import styles from './MobileBar.module.css';
import { MobileAccountMenu } from './MobileAccountMenu';

/**
 * A screen's top bar on the phone.
 *
 * Two shapes, as WhatsApp has: a list screen names itself and carries the
 * account menu; a screen inside a list (one conversation) has a way back and
 * says who or what it is, with room for its own actions at the end.
 */
export function MobileBar({
  title,
  back,
  lead,
  actions,
  children,
}: {
  readonly title?: ReactNode;
  /** The list this screen sits in. Present = the back arrow, absent = the account menu. */
  readonly back?: { readonly href: '/m/inbox' | '/m/approvals' | '/m/outreach' | '/m/customers'; readonly label: string };
  /** Before the title: an avatar, on a conversation. */
  readonly lead?: ReactNode;
  readonly actions?: ReactNode;
  /** Under the bar's row, still part of it: the inbox's view chips. */
  readonly children?: ReactNode;
}) {
  return (
    <header className={styles.bar}>
      <div className={styles.row}>
        {back === undefined ? null : (
          <Link
            href={back.href}
            className={styles.iconButton}
            aria-label={back.label}
            data-testid="mobile-back"
          >
            <DirectionalIcon>
              <ArrowLeft size={22} strokeWidth={1.8} />
            </DirectionalIcon>
          </Link>
        )}
        {lead}
        <div className={styles.title}>{title}</div>
        {actions}
        {back === undefined ? <MobileAccountMenu /> : null}
      </div>
      {children}
    </header>
  );
}
