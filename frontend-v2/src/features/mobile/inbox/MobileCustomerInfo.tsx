import { ChevronRight } from 'lucide-react';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { channelName } from '@/api/contracts/inbox';
import { ChannelPlate } from '@/design-system/brand/channel-plate';
import { DirectionalIcon } from '@/design-system/patterns/DirectionalIcon';
import { UserText } from '@/design-system/primitives/text/UserText';
import { PersonName } from '@/features/customers/PersonName';
import { money } from '@/features/customers/row-facts';
import { initials } from '@/features/inbox/initials';
import { factLabel, ordersView } from '@/features/inbox/wall/wall-model';
import { Link } from '@/i18n/navigation';

import ui from '../mobile-ui.module.css';
import {
  crmSection,
  historySection,
  memorySection,
  notesSection,
  ordersSection,
  type Section,
} from './customer-info';
import type { CustomerInfo } from './load-customer-info';
import styles from './mobile-inbox.module.css';

/**
 * The phone's "מידע על הלקוח": what the desktop's Copilot wall knows about
 * the person in this conversation, as the phone's sections, read only -
 * what GOTCHA remembers, their other conversations, their orders, the
 * team's notes and the CRM's.
 *
 * ★ A SECTION THAT COULD NOT LOAD SAYS SO, AND THE REST STAND. An empty one
 *   is a quiet line, never a zero (`customer-info.ts`).
 */
export async function MobileCustomerInfo({ info }: { readonly info: CustomerInfo }) {
  const t = await getTranslations('mobile.customerInfo');
  const channels = await getTranslations('channels');
  const inbox = await getTranslations('inbox');
  const format = await getFormatter();
  const locale = await getLocale();
  const { conversation, person, conversationOrders, notes, crm } = info;
  const hasContact = conversation.contactId !== null;
  const date = (iso: string | null) =>
    iso === null || Number.isNaN(Date.parse(iso))
      ? null
      : format.dateTime(new Date(iso), { day: 'numeric', month: 'short', year: 'numeric' });

  const memory = memorySection(person.memory);
  const history = historySection(person.history, hasContact);
  const orders = ordersSection(ordersView(person.orders, conversationOrders), {
    byContact: person.orders !== null,
    byConversation: conversationOrders !== null,
  });
  const teamNotes = notesSection(notes, hasContact);
  const crmNotes = crmSection(crm);
  const channel = channelName(conversation.channel, channels);

  return (
    <div className={styles.info} data-testid="mobile-customer-info">
      <header className={styles.infoHead}>
        <span className={ui.avatar} aria-hidden="true">
          {initials(conversation.customerName)}
        </span>
        <span className={styles.infoWho}>
          <span className={styles.infoName}>
            {conversation.customerName === null ? (
              inbox('queue.unnamed')
            ) : (
              <PersonName name={conversation.customerName} />
            )}
          </span>
          {channel === null ? null : <span className={ui.rowSub}>{channel}</span>}
        </span>
      </header>
      {hasContact ? null : <p className={ui.lead}>{t('noContact')}</p>}

      <InfoSection id="memory" title={t('memory.title')} section={memory} t={t}>
        {(lines) => (
          <ul className={styles.infoList}>
            {lines.map((line, index) => (
              <li key={index} className={styles.infoItem}>
                {line.key === null ? null : (
                  <span className={styles.infoLabel}>{factLabel(line.key)}</span>
                )}
                <UserText>{line.value}</UserText>
              </li>
            ))}
          </ul>
        )}
      </InfoSection>

      <InfoSection id="history" title={t('history.title')} section={history} t={t}>
        {(rows) => (
          <ul className={styles.infoRows}>
            {rows.map((row) => (
              <li key={row.id} className={ui.cardRow}>
                <Link
                  href={`/m/inbox/${encodeURIComponent(row.id)}` as '/m/inbox'}
                  className={ui.row}
                  data-testid="mobile-customer-info-conversation"
                >
                  <ChannelPlate
                    channel={row.channel}
                    label={channelName(row.channel, channels) ?? row.channel}
                    size="lg"
                  />
                  <span className={ui.rowBody}>
                    <span className={styles.infoRowTitle}>
                      {row.summary === null ? t('history.noSummary') : <UserText>{row.summary}</UserText>}
                    </span>
                    <span className={ui.rowSub}>
                      {[
                        date(row.lastAt ?? row.startedAt),
                        row.status === 'CLOSED' ? t('history.resolved') : null,
                        t('history.messages', { count: row.messages }),
                      ]
                        .filter((part): part is string => part !== null)
                        .join(' · ')}
                    </span>
                  </span>
                  <DirectionalIcon>
                    <ChevronRight aria-hidden size={18} strokeWidth={2} className={styles.infoChevron} />
                  </DirectionalIcon>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </InfoSection>

      <InfoSection id="orders" title={t('orders.title')} section={orders} t={t}>
        {(lines) => (
          <ul className={styles.infoRows}>
            {lines.map((order) => (
              <li key={order.id} className={`${ui.cardRow} ${styles.infoOrder}`}>
                <span className={ui.rowBody}>
                  <span className={styles.infoRowTitle}>
                    {order.number === '' ? t('orders.unnumbered') : t('orders.number', { number: order.number })}
                  </span>
                  <span className={ui.rowSub}>
                    {[date(order.createdAt), order.cancelled ? t('orders.cancelled') : order.status]
                      .filter((part): part is string => !!part)
                      .join(' · ')}
                  </span>
                </span>
                {order.total.amount === null ? null : (
                  <span className={`${ui.figure} ${styles.infoMoney}`} dir="ltr">
                    {money(order.total.amount, order.total.currency ?? '', locale)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </InfoSection>

      <InfoSection id="notes" title={t('notes.title')} section={teamNotes} t={t}>
        {(items) => (
          <ul className={styles.infoList}>
            {items.map((note) => (
              <li key={note.id} className={styles.infoItem}>
                <UserText>{note.body}</UserText>
                <span className={styles.infoByline}>
                  {[note.authorName, date(note.createdAt)].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </InfoSection>

      <InfoSection id="crm" title={t('crm.title')} section={crmNotes} t={t}>
        {(items) => (
          <ul className={styles.infoList}>
            {items.map((note) => (
              <li key={note.id} className={styles.infoItem}>
                <UserText>{note.body}</UserText>
                <span className={styles.infoByline}>
                  {[t(`crm.kind.${note.kind}`), date(note.occurred_at)].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </InfoSection>
    </div>
  );
}

type InfoT = Awaited<ReturnType<typeof getTranslations<'mobile.customerInfo'>>>;

/** One section: its label, then a card - its rows, its quiet empty line, or that it could not load. */
function InfoSection<T>({
  id,
  title,
  section,
  t,
  children,
}: {
  readonly id: 'memory' | 'history' | 'orders' | 'notes' | 'crm';
  readonly title: string;
  readonly section: Section<T>;
  readonly t: InfoT;
  readonly children: (items: T) => ReactNode;
}) {
  return (
    <section
      className={styles.infoSection}
      aria-label={title}
      data-testid={`mobile-customer-info-${id}`}
      data-state={section.state}
    >
      <h2 className={ui.section}>{title}</h2>
      <div className={ui.card}>
        {section.state === 'ok' ? (
          children(section.items)
        ) : (
          <p className={styles.infoQuiet} role={section.state === 'failed' ? 'status' : undefined}>
            {section.state === 'failed' ? t('failed') : t(`${id}.empty`)}
          </p>
        )}
      </div>
    </section>
  );
}
