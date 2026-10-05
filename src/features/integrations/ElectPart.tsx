'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useTransition } from 'react';

import type { RolePart } from '@/api/contracts/business-core';
import { IntegrationLogo } from '@/features/capabilities/IntegrationLogo';
import { useRouter } from '@/i18n/navigation';

import { electRole, type ElectResult } from './actions';
import styles from './BusinessCore.module.css';

/**
 * 14 and 14c — which system plays a part, as 02 draws it: "the dropdown,
 * never a connect form". A 240px pill (the system's mark, its name, a
 * chevron) the height of its row; open, "Connected in Integrations" — only
 * CONNECTED candidates, because the write refuses anything else and a broken
 * shop in the list would be a choice the server rejects on save. Choosing
 * saves; there is no Save.
 *
 * What the save DISPLACED ("it was WooCommerce") and any refusal are said on
 * the pill (title) and to a screen reader, never as a paragraph that grows
 * the row. Connecting a new system is named at the foot of the menu, not
 * linked — this app has no route to the marketplace.
 */
export function ElectPart({ part }: { readonly part: RolePart }) {
  const t = useTranslations('business-core');
  const router = useRouter();
  const connected = part.candidates.filter((c) => c.connected);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ElectResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const box = useRef<HTMLDivElement>(null);

  // Closes on a click outside or Escape, as a menu does.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  // Nothing connected: the part's own sentence says why; an empty menu would not.
  if (connected.length === 0) return null;

  const current = part.elected ?? null;
  const said =
    result?.ok === true
      ? result.data.replaced
        ? t('elect.replaced', { name: result.data.replaced.name })
        : t('elect.saved')
      : result?.ok === false
        ? result.reason === 'not_connected'
          ? t('elect.error.notConnected')
          : result.reason === 'crm_elsewhere'
            ? t('crm.elsewhere')
            : result.reason === 'returns_elsewhere'
              ? t('returns.elsewhere')
              : t('elect.error.failed')
        : null;

  function choose(slug: string) {
    setOpen(false);
    if (slug === current?.slug) return;
    setResult(null);
    startTransition(async () => {
      const done = await electRole(part.role, slug);
      setResult(done);
      if (done.ok) router.refresh();
    });
  }

  return (
    <div className={styles.pickBox} ref={box} data-testid={`core-elect-${part.role}`}>
      <button
        type="button"
        className={styles.pill}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('elect.label')}
        title={said ?? undefined}
        data-problem={result?.ok === false ? '' : undefined}
        disabled={isPending}
        data-testid={`core-elect-open-${part.role}`}
        onClick={() => setOpen((now) => !now)}
      >
        <IntegrationLogo slug={current?.slug ?? null} size="pill" />
        <span className={styles.pillName}>
          {isPending ? t('elect.saving') : (current?.name ?? t('elect.none'))}
        </span>
        <ChevronDown size={14} className={styles.pillChevron} aria-hidden="true" />
      </button>
      <span className="srOnly" role="status" data-testid={`core-elect-said-${part.role}`}>
        {said}
      </span>
      {open ? (
        <div className={styles.pickMenu} data-testid={`core-elect-menu-${part.role}`}>
          <p className={styles.pickEyebrow}>{t('elect.connectedHeading')}</p>
          <ul role="listbox" aria-label={t('elect.label')} className={styles.pickList}>
            {connected.map((candidate) => (
              <li key={candidate.slug}>
                <button
                  type="button"
                  role="option"
                  aria-selected={candidate.slug === current?.slug}
                  className={styles.pickOption}
                  data-testid={`core-elect-option-${part.role}-${candidate.slug}`}
                  onClick={() => choose(candidate.slug)}
                >
                  <IntegrationLogo slug={candidate.slug} size="pill" />
                  <span className={styles.pillName}>{candidate.name}</span>
                  {candidate.slug === current?.slug ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              </li>
            ))}
          </ul>
          <p className={styles.pickFoot} data-testid="core-elect-connect">
            {t('elect.connectNew')}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** A part nobody can choose for here: the same pill, still — the system's mark and name, or "—". */
export function SystemPill({
  slug,
  name,
  testId,
}: {
  readonly slug: string | null;
  readonly name: string | null;
  readonly testId?: string;
}) {
  return (
    <span className={styles.pill} data-static="" data-testid={testId}>
      {name ? <IntegrationLogo slug={slug} size="pill" /> : null}
      <span className={name ? styles.pillName : styles.systemNone}>{name ?? '—'}</span>
    </span>
  );
}
