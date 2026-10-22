'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';

import { labelFromServer } from '@/api/contracts/customers';
import { linkMatch, type IdentityLink, type IdentityLinks } from '@/api/contracts/identity';
import { channelName } from '@/api/contracts/inbox';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { UserText } from '@/design-system/primitives/text/UserText';
import { Link, useRouter } from '@/i18n/navigation';

import styles from './Customers.module.css';
import { Proof } from './DuplicateCard';
import { unlinkContacts, type UnlinkResult } from './identity-actions';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ THE ACCOUNTS THIS CUSTOMER IS LINKED TO, AND A WAY TO UNDO ONE (F1)
 * ════════════════════════════════════════════════════════════════════════════
 * Omer (2026-10-13): on a customer's page, each linked identity - its channel,
 * its name, how it was linked - with "ביטול צימוד", which asks first.
 *
 * How it was linked is the duplicates card's own words (the reason line and
 * its proof), so a link reads the way its suggestion did. A link made through
 * ANOTHER account (`direct: false`) names that account. No `unlink` body, no
 * button: the platform says that link cannot be undone.
 */
export function LinkedAccounts({ links }: { readonly links: IdentityLinks | null }) {
  const t = useTranslations('customers.links');
  if (links === null) {
    return (
      <section className={styles.sideBlock} data-testid="customer-links">
        <h2 className={styles.sideEyebrow}>{t('title')}</h2>
        <p className={styles.sideNone} data-testid="customer-links-unavailable">
          {t('unavailable')}
        </p>
      </section>
    );
  }
  if (links.linked.length === 0) return null;
  const labels = new Map(links.linked.map((row) => [row.contactId, row]));
  return (
    <section className={styles.sideBlock} data-testid="customer-links">
      <h2 className={styles.sideEyebrow}>{t('title')}</h2>
      <ul className={styles.linkList}>
        {links.linked.map((row) => (
          <LinkedRow key={row.contactId} row={row} labels={labels} />
        ))}
      </ul>
    </section>
  );
}

function LinkedRow({
  row,
  labels,
}: {
  readonly row: IdentityLink;
  readonly labels: ReadonlyMap<string, IdentityLink>;
}) {
  const t = useTranslations('customers.links');
  const list = useTranslations('customers.list');
  /* The server's fallback words ("Instagram customer") become ours, as on the duplicates card. */
  const nameOf = (label: string | null | undefined, channel: string | null | undefined) => {
    if (!label) return t('unnamed');
    const read = labelFromServer(label, channel);
    return 'name' in read ? read.name : list(`generic.${read.generic}`);
  };
  const why = useTranslations('customers.dupes.why');
  const channels = useTranslations('channels');
  const format = useFormatter();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<UnlinkResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const name = nameOf(row.label, row.channel);
  const link = row.link ?? null;
  // Joined through another account: the one in its pair that is not this row's.
  const through =
    link && !link.direct ? (link.contactIds.find((id) => id !== row.contactId) ?? null) : null;
  const throughRow = through ? labels.get(through) : undefined;
  const throughName = through ? nameOf(throughRow?.label, throughRow?.channel) : null;
  const pair = row.unlink?.contactIds ?? null;

  return (
    <li className={styles.linkRow} data-testid={`link-${row.contactId}`}>
      <Link
        className={styles.dupeName}
        href={`/customers/${row.contactId}`}
        data-testid={`link-name-${row.contactId}`}
      >
        {row.channel ? (
          <ChannelPlate
            channel={row.channel}
            size="sm"
            label={channelName(row.channel, channels) ?? channels('name.other')}
          />
        ) : null}
        <UserText>{name}</UserText>
      </Link>
      {link ? (
        <>
          <p className={styles.dupeWhy} data-testid={`link-why-${row.contactId}`}>
            {why(linkMatch(link))}
          </p>
          {link.evidence ? <Proof evidence={link.evidence} /> : null}
          <p className={styles.sideNote} data-testid={`link-how-${row.contactId}`}>
            {[
              link.automatic ? t('automatic') : t('byPerson'),
              link.at
                ? t('on', {
                    date: format.dateTime(new Date(link.at), { day: 'numeric', month: 'short' }),
                  })
                : null,
              throughName ? t('through', { name: throughName }) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </>
      ) : null}
      {result?.ok ? (
        <p className={styles.sideNote} role="status" data-testid={`link-undone-${row.contactId}`}>
          {t('undone')}
        </p>
      ) : pair ? (
        <div className={styles.dupeActions}>
          {confirming ? (
            <>
              <span className={styles.sideNote}>{t('confirm', { name })}</span>
              <button
                type="button"
                className={styles.dupePrimary}
                disabled={isPending}
                data-testid={`unlink-confirm-${row.contactId}`}
                onClick={() =>
                  startTransition(async () => {
                    const done = await unlinkContacts(pair);
                    setResult(done);
                    setConfirming(false);
                    if (done.ok) router.refresh();
                  })
                }
              >
                {t('confirmYes')}
              </button>
              <button
                type="button"
                className={styles.dupeSecondary}
                data-testid={`unlink-cancel-${row.contactId}`}
                onClick={() => setConfirming(false)}
              >
                {t('cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={styles.dupeSecondary}
              data-testid={`unlink-${row.contactId}`}
              onClick={() => {
                setResult(null);
                setConfirming(true);
              }}
            >
              {t('unlink')}
            </button>
          )}
        </div>
      ) : null}
      {result && !result.ok ? (
        <p className={styles.sideNote} role="alert" data-testid={`unlink-problem-${row.contactId}`}>
          {t(`problem.${result.reason}`)}
        </p>
      ) : null}
    </li>
  );
}
