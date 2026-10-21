import type { ReactNode } from 'react';

import { Logo } from '@/design-system/brand/Logo';
import { Text } from '@/design-system/primitives/text/Text';

import signIn from '../sign-in/SignIn.module.css';

/**
 * The sign-in surface's frame, for a page somebody reaches from a link in an
 * email - an invitation, an expired setup link.
 *
 * ★ The recovery screen's markup, not a new layout: the same editorial panel
 *   beside the same form column, from `SignIn.module.css`. The recovery page
 *   keeps its own copy of it; this is not a refactor of that screen.
 */
export function LinkFrame({
  editorial,
  children,
}: {
  readonly editorial: {
    readonly eyebrow: string;
    readonly headline: string;
    readonly support: string;
    readonly status: string;
  };
  readonly children: ReactNode;
}) {
  return (
    <div className={signIn.frame}>
      <aside className={signIn.editorial}>
        <div className={signIn.brand}>
          <Logo variant="framed" size={38} />
          GOTCHA
        </div>

        <div className={signIn.editorialStage} aria-hidden="true">
          <div className={signIn.editorialSlide}>
            <Text role="eyebrow" as="p" className={signIn.editorialEyebrow}>
              {editorial.eyebrow}
            </Text>
            <Text role="serif" tone="inherit" as="p">
              {editorial.headline}
            </Text>
            <Text role="bodySm" tone="inherit" as="p" className={signIn.editorialSupport}>
              {editorial.support}
            </Text>
          </div>
        </div>

        <div className={signIn.systemStatus}>
          <span className={signIn.editorialRule} aria-hidden="true" />
          <span className={signIn.statusDot} aria-hidden="true" />
          {editorial.status}
        </div>
      </aside>

      <main className={signIn.surface}>
        <div className={signIn.form}>{children}</div>
      </main>
    </div>
  );
}
