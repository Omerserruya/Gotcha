import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { DirectionalIcon } from '@/design-system/patterns/DirectionalIcon';
import { Link } from '@/i18n/navigation';

import styles from './MobileBar.module.css';
import { MobileAccountMenu } from './MobileAccountMenu';
import type { MobileTabHref } from './MobileTabs';

/**
 * A screen's top bar on the phone, as `GOTCHA Mobile App.dc.html` draws it.
 *
 * Two shapes: a list screen names itself in large type (the inbox writes the
 * GOTCHA wordmark instead) with its actions and the account menu at the end;
 * a screen over a list (a conversation, an approval, a customer) has a way
 * back, then whatever says what it is.
 */
export function MobileBar({
  title,
  brand = false,
  back,
  lead,
  actions,
  edge = false,
  children,
}: {
  readonly title?: ReactNode;
  /** The inbox's bar: the wordmark, not a screen name. */
  readonly brand?: boolean;
  /** The list this screen sits in. Present = the back arrow, absent = the account menu. */
  readonly back?: { readonly href: MobileTabHref; readonly label: string };
  /** Before the title: an avatar, on a conversation. */
  readonly lead?: ReactNode;
  readonly actions?: ReactNode;
  /** A hairline under the bar: a conversation's, where the stream scrolls under it. */
  readonly edge?: boolean;
  /** Under the bar's row, still part of it. */
  readonly children?: ReactNode;
}) {
  return (
    <header
      className={styles.bar}
      data-back={back === undefined ? undefined : ''}
      data-edge={edge ? '' : undefined}
    >
      <div className={styles.row}>
        {back === undefined ? null : (
          <Link
            href={back.href}
            className={styles.iconButton}
            aria-label={back.label}
            data-testid="mobile-back"
          >
            <DirectionalIcon>
              <ArrowLeft size={23} strokeWidth={2} />
            </DirectionalIcon>
          </Link>
        )}
        {lead}
        {brand ? (
          <span className={styles.brand}>GOTCHA</span>
        ) : (
          <div className={styles.title}>{title}</div>
        )}
        {brand ? <span className={styles.fill} /> : null}
        {actions}
        {back === undefined ? <MobileAccountMenu /> : null}
      </div>
      {children}
    </header>
  );
}
