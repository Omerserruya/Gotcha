'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition, type ReactNode } from 'react';

import type {
  Learned,
  LearnedFaq,
  LearnedPolicy,
  LearnedSection,
} from '@/api/contracts/onboarding-v2';
import { Input } from '@/design-system/primitives/input/Input';
import { Link } from '@/i18n/navigation';

import { editLearned, type LearnedEdit, type LearnedEditResult } from './learned-actions';
import styles from './Onboarding.module.css';
import { stepHref } from './preview';
import { nameOf } from './ScanFeed';

/** One write, its pending state, and what it was refused for. */
function useEdit(onDone: (learned: Learned) => void) {
  const [isPending, start] = useTransition();
  const [refused, setRefused] = useState<Exclude<LearnedEditResult, { ok: true }>['reason'] | null>(
    null,
  );
  const run = (edit: LearnedEdit, after?: () => void) =>
    start(async () => {
      setRefused(null);
      const result = await editLearned(edit).catch(
        () => ({ ok: false, reason: 'failed' }) as const,
      );
      if (result.ok) {
        onDone(result.learned);
        after?.();
      } else setRefused(result.reason);
    });
  return { run, isPending, refused };
}

/**
 * Step 4's first half - check what was learned (00f, against Backend's
 * /learned): the business, its products, each policy with its terms in plain
 * words, the FAQ, contact and hours, the writing style, the tools seen.
 * Every item can be corrected or removed; a question can be added. Each
 * edit rewrites what the AI reads at once, and the screen redraws from the
 * server's answer.
 *
 * ★ Not learned is said per section, never drawn as an empty card; a read
 *   that failed is said as unread, never as "nothing learned".
 */
export function ReviewStep({
  initial,
  preview = false,
}: {
  readonly initial: Learned;
  readonly preview?: boolean;
}) {
  const t = useTranslations('onboarding.review');
  const [learned, setLearned] = useState(initial);

  return (
    <div className={styles.review} data-testid="review">
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.subtitle}>{t('subtitle')}</p>

      <Profile learned={learned} onDone={setLearned} preview={preview} />
      <Products learned={learned} />
      <Policies learned={learned} onDone={setLearned} preview={preview} />
      <Faq learned={learned} onDone={setLearned} preview={preview} />
      <Contact learned={learned} onDone={setLearned} preview={preview} />
      <Brand learned={learned} onDone={setLearned} preview={preview} />
      {learned.tools.length ? (
        <Section title={t('tools.title')} testid="review-tools">
          <ul className={styles.chips}>
            {learned.tools.map((tool) => (
              <li key={tool.slug} className={styles.chip}>
                <bdi dir="ltr">{tool.name || nameOf(tool.slug)}</bdi>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** The step's way back when nothing was learned yet, or the read failed. */
export function ReviewUnavailable({
  reason,
  preview = false,
}: {
  readonly reason: 'not_learned' | 'unread';
  readonly preview?: boolean;
}) {
  const t = useTranslations('onboarding.review');
  return (
    <div className={styles.review} data-testid={`review-${reason}`}>
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.why} role="alert">
        {t(`unavailable.${reason}`)}
      </p>
      {reason === 'not_learned' ? (
        <span className={styles.actions}>
          <Link href={stepHref('/onboarding/website', preview)} className={styles.primary}>
            {t('unavailable.toWebsite')}
          </Link>
        </span>
      ) : null}
    </div>
  );
}

function Section({
  title,
  testid,
  children,
}: {
  readonly title: string;
  readonly testid: string;
  readonly children: ReactNode;
}) {
  return (
    <section className={styles.system} aria-label={title} data-testid={testid}>
      <h2 className={styles.systemName}>{title}</h2>
      {children}
    </section>
  );
}

type SectionProps = {
  readonly learned: Learned;
  readonly onDone: (learned: Learned) => void;
  readonly preview: boolean;
};

/** A labelled set of text fields, edited in place and saved together. */
function FieldsEdit({
  fields,
  initial,
  section,
  id,
  onDone,
  onCancel,
}: {
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly long?: boolean;
  }[];
  readonly initial: Readonly<Record<string, string>>;
  readonly section: LearnedSection;
  readonly id?: string;
  readonly onDone: (learned: Learned) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('onboarding.review');
  const [values, setValues] = useState(initial);
  const { run, isPending, refused } = useEdit(onDone);
  const changed = fields.some((field) => (values[field.key] ?? '') !== (initial[field.key] ?? ''));
  return (
    <form
      className={styles.connectHere}
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || isPending) return;
        const value = Object.fromEntries(
          fields.map((field) => [field.key, (values[field.key] ?? '').trim()]),
        );
        run({ section, ...(id ? { id } : {}), value }, onCancel);
      }}
      data-testid={`review-edit-${section}${id ? `-${id}` : ''}`}
    >
      {fields.map((field) =>
        field.long ? (
          <label key={field.key} className={styles.field}>
            <span className={styles.fieldLabel}>{field.label}</span>
            <textarea
              className={styles.textarea}
              value={values[field.key] ?? ''}
              rows={4}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
          </label>
        ) : (
          <Input
            key={field.key}
            label={field.label}
            value={values[field.key] ?? ''}
            onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
          />
        ),
      )}
      <span className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={!changed || isPending}>
          {isPending ? t('saving') : t('save')}
        </button>
        <button type="button" className={styles.secondary} onClick={onCancel}>
          {t('cancel')}
        </button>
      </span>
      {refused ? (
        <p className={styles.problem} role="alert">
          {t(`refused.${refused}`)}
        </p>
      ) : null}
    </form>
  );
}

/** Edit / Remove for one item, drawn the same everywhere. */
function ItemActions({
  onEdit,
  onRemove,
  removing,
  preview,
  testid,
}: {
  readonly onEdit: () => void;
  readonly onRemove?: () => void;
  readonly removing?: boolean;
  readonly preview: boolean;
  readonly testid: string;
}) {
  const t = useTranslations('onboarding.review');
  const [confirming, setConfirming] = useState(false);
  if (preview) return null;
  return (
    <span className={styles.itemActions}>
      <button
        type="button"
        className={styles.textButton}
        onClick={onEdit}
        data-testid={`${testid}-edit`}
      >
        {t('edit')}
      </button>
      {onRemove ? (
        confirming ? (
          <>
            <button
              type="button"
              className={styles.textButton}
              disabled={removing}
              onClick={onRemove}
              data-testid={`${testid}-remove-yes`}
            >
              {removing ? t('removing') : t('removeYes')}
            </button>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => setConfirming(false)}
            >
              {t('cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.textButton}
            onClick={() => setConfirming(true)}
            data-testid={`${testid}-remove`}
          >
            {t('remove')}
          </button>
        )
      ) : null}
    </span>
  );
}

function Profile({ learned, onDone, preview }: SectionProps) {
  const t = useTranslations('onboarding.review');
  const [editing, setEditing] = useState(false);
  const profile = learned.profile;
  const fields = [
    { key: 'name', label: t('profile.name') },
    { key: 'industry', label: t('profile.industry') },
    { key: 'summary', label: t('profile.summary'), long: true },
  ];
  return (
    <Section title={t('profile.title')} testid="review-profile">
      {editing ? (
        <FieldsEdit
          fields={fields}
          initial={{
            name: profile?.name ?? '',
            industry: profile?.industry ?? '',
            summary: profile?.summary ?? '',
          }}
          section="profile"
          onDone={onDone}
          onCancel={() => setEditing(false)}
        />
      ) : profile && (profile.name || profile.summary) ? (
        <>
          <p className={styles.itemTitle}>
            <bdi dir="auto">{profile.name}</bdi>
            {profile.industry ? <span className={styles.quiet}> · {profile.industry}</span> : null}
          </p>
          {profile.summary ? <p className={styles.quiet}>{profile.summary}</p> : null}
          <ItemActions onEdit={() => setEditing(true)} preview={preview} testid="review-profile" />
        </>
      ) : (
        <>
          <p className={styles.quiet}>{t('notLearned')}</p>
          <ItemActions onEdit={() => setEditing(true)} preview={preview} testid="review-profile" />
        </>
      )}
    </Section>
  );
}

function Products({ learned }: { readonly learned: Learned }) {
  const t = useTranslations('onboarding.review');
  const format = useFormatter();
  const products = learned.products;
  const price = products?.priceRange;
  const money = (amount: number) =>
    price?.currency
      ? format.number(amount, {
          style: 'currency',
          currency: price.currency,
          maximumFractionDigits: 0,
        })
      : format.number(amount);
  return (
    <Section title={t('products.title')} testid="review-products">
      {products === null || products.count === null ? (
        <p className={styles.quiet}>{t('products.notLearned')}</p>
      ) : (
        <>
          <p className={styles.itemTitle} data-testid="review-products-count">
            {products.source === 'sampled'
              ? t('products.sampled', { count: products.count })
              : t('products.count', { count: products.count, more: String(products.more) })}
          </p>
          {price && price.min !== null && price.max !== null ? (
            <p className={styles.quiet}>
              {t('products.price', { min: money(price.min), max: money(price.max) })}
            </p>
          ) : null}
          {products.categories.length ? (
            <ul className={styles.chips}>
              {products.categories.map((category) => (
                <li key={category} className={styles.chip}>
                  <bdi dir="auto">{category}</bdi>
                </li>
              ))}
            </ul>
          ) : null}
          <p className={styles.quiet}>{t('products.fromStore')}</p>
        </>
      )}
    </Section>
  );
}

/** A policy's terms, in plain words: what a customer would ask about. */
function useTerms() {
  const t = useTranslations('onboarding.review.terms');
  return (policy: LearnedPolicy): string[] => {
    const terms = policy.terms;
    if (!terms) return [];
    const lines: string[] = [];
    if (terms.windowDays !== null) lines.push(t('window', { days: terms.windowDays }));
    if (terms.exchange?.allowed === true)
      lines.push(
        terms.exchange.how ? t('exchangeHow', { how: terms.exchange.how }) : t('exchange'),
      );
    if (terms.exchange?.allowed === false) lines.push(t('noExchange'));
    if (terms.shipping?.times) lines.push(t('shippingTimes', { times: terms.shipping.times }));
    if (terms.shipping?.costs) lines.push(t('shippingCosts', { costs: terms.shipping.costs }));
    if (terms.shipping?.freeOver) lines.push(t('freeOver', { amount: terms.shipping.freeOver }));
    if (terms.refund?.method) lines.push(t('refundMethod', { method: terms.refund.method }));
    if (terms.refund?.days !== null && terms.refund?.days !== undefined)
      lines.push(t('refundDays', { days: terms.refund.days }));
    if (terms.warranty?.months !== null && terms.warranty?.months !== undefined)
      lines.push(t('warranty', { months: terms.warranty.months }));
    return lines;
  };
}

function Policies({ learned, onDone, preview }: SectionProps) {
  const t = useTranslations('onboarding.review');
  return (
    <Section title={t('policies.title')} testid="review-policies">
      {learned.policies.length === 0 ? (
        <p className={styles.quiet}>{t('policies.none')}</p>
      ) : (
        <ul className={styles.reviewList}>
          {learned.policies.map((policy) => (
            <PolicyItem key={policy.id} policy={policy} onDone={onDone} preview={preview} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function PolicyItem({
  policy,
  onDone,
  preview,
}: {
  readonly policy: LearnedPolicy;
  readonly onDone: (learned: Learned) => void;
  readonly preview: boolean;
}) {
  const t = useTranslations('onboarding.review');
  const ts = useTranslations('onboarding.scan');
  const terms = useTerms();
  const [editing, setEditing] = useState(false);
  const remove = useEdit(onDone);
  const testid = `review-policy-${policy.id}`;
  return (
    <li className={styles.reviewItem} data-testid={testid}>
      <span className={styles.itemTitle}>{ts(`chips.policy.${policy.kind}`)}</span>
      {editing ? (
        <FieldsEdit
          fields={[{ key: 'summary', label: t('policies.summary'), long: true }]}
          initial={{ summary: policy.summary ?? '' }}
          section="policies"
          id={policy.id}
          onDone={onDone}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          {policy.summary ? <p className={styles.quiet}>{policy.summary}</p> : null}
          {terms(policy).length ? (
            <ul className={styles.terms} data-testid={`${testid}-terms`}>
              {terms(policy).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {policy.sourceUrl ? (
            <a
              href={policy.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={styles.inlineLink}
            >
              {t('source')}
            </a>
          ) : null}
          <ItemActions
            onEdit={() => setEditing(true)}
            onRemove={() => remove.run({ section: 'policies', id: policy.id, remove: true })}
            removing={remove.isPending}
            preview={preview}
            testid={testid}
          />
          {remove.refused ? (
            <p className={styles.problem} role="alert">
              {t(`refused.${remove.refused}`)}
            </p>
          ) : null}
        </>
      )}
    </li>
  );
}

function Faq({ learned, onDone, preview }: SectionProps) {
  const t = useTranslations('onboarding.review');
  const [adding, setAdding] = useState(false);
  return (
    <Section title={t('faq.title')} testid="review-faq">
      {learned.faq.length === 0 ? <p className={styles.quiet}>{t('faq.none')}</p> : null}
      {learned.faq.length ? (
        <ul className={styles.reviewList}>
          {learned.faq.map((item) => (
            <FaqItem key={item.id} item={item} onDone={onDone} preview={preview} />
          ))}
        </ul>
      ) : null}
      {preview ? null : adding ? (
        <FieldsEdit
          fields={[
            { key: 'q', label: t('faq.q') },
            { key: 'a', label: t('faq.a'), long: true },
          ]}
          initial={{ q: '', a: '' }}
          section="faq"
          onDone={onDone}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          type="button"
          className={styles.textButton}
          onClick={() => setAdding(true)}
          data-testid="review-faq-add"
        >
          {t('faq.add')}
        </button>
      )}
    </Section>
  );
}

function FaqItem({
  item,
  onDone,
  preview,
}: {
  readonly item: LearnedFaq;
  readonly onDone: (learned: Learned) => void;
  readonly preview: boolean;
}) {
  const t = useTranslations('onboarding.review');
  const [editing, setEditing] = useState(false);
  const remove = useEdit(onDone);
  const testid = `review-faq-${item.id}`;
  return (
    <li className={styles.reviewItem} data-testid={testid}>
      {editing ? (
        <FieldsEdit
          fields={[
            { key: 'q', label: t('faq.q') },
            { key: 'a', label: t('faq.a'), long: true },
          ]}
          initial={{ q: item.q, a: item.a }}
          section="faq"
          id={item.id}
          onDone={onDone}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <span className={styles.itemTitle}>
            <bdi dir="auto">{item.q}</bdi>
          </span>
          <p className={styles.quiet}>
            <bdi dir="auto">{item.a}</bdi>
          </p>
          <ItemActions
            onEdit={() => setEditing(true)}
            onRemove={() => remove.run({ section: 'faq', id: item.id, remove: true })}
            removing={remove.isPending}
            preview={preview}
            testid={testid}
          />
          {remove.refused ? (
            <p className={styles.problem} role="alert">
              {t(`refused.${remove.refused}`)}
            </p>
          ) : null}
        </>
      )}
    </li>
  );
}

function Contact({ learned, onDone, preview }: SectionProps) {
  const t = useTranslations('onboarding.review');
  const [editing, setEditing] = useState(false);
  const contact = learned.contact;
  const lines = contact
    ? [
        ...contact.phones.map((phone) => ({ key: `p-${phone}`, text: phone, ltr: true })),
        ...contact.whatsapp.map((number) => ({
          key: `w-${number}`,
          text: `WhatsApp ${number}`,
          ltr: true,
        })),
        ...contact.emails.map((email) => ({ key: `e-${email}`, text: email, ltr: true })),
        ...(contact.address ? [{ key: 'address', text: contact.address, ltr: false }] : []),
      ]
    : [];
  return (
    <Section title={t('contact.title')} testid="review-contact">
      {editing ? (
        <FieldsEdit
          fields={[
            { key: 'address', label: t('contact.address') },
            { key: 'hours', label: t('contact.hours'), long: true },
          ]}
          initial={{ address: contact?.address ?? '', hours: contact?.hours ?? '' }}
          section="contact"
          onDone={onDone}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          {lines.length || contact?.hours ? (
            <ul className={styles.terms}>
              {lines.map((line) => (
                <li key={line.key}>
                  <bdi dir={line.ltr ? 'ltr' : 'auto'}>{line.text}</bdi>
                </li>
              ))}
              {contact?.hours ? <li>{t('contact.hoursLine', { hours: contact.hours })}</li> : null}
            </ul>
          ) : (
            <p className={styles.quiet}>{t('notLearned')}</p>
          )}
          <ItemActions onEdit={() => setEditing(true)} preview={preview} testid="review-contact" />
        </>
      )}
    </Section>
  );
}

function Brand({ learned, onDone, preview }: SectionProps) {
  const t = useTranslations('onboarding.review');
  const [editing, setEditing] = useState(false);
  const brand = learned.brand;
  return (
    <Section title={t('brand.title')} testid="review-brand">
      {editing ? (
        <FieldsEdit
          fields={[
            { key: 'voice', label: t('brand.voice'), long: true },
            { key: 'greetingExample', label: t('brand.greeting') },
          ]}
          initial={{ voice: brand?.voice ?? '', greetingExample: brand?.greetingExample ?? '' }}
          section="brand"
          onDone={onDone}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          {brand?.voice ? (
            <p className={styles.quiet}>{brand.voice}</p>
          ) : (
            <p className={styles.quiet}>{t('notLearned')}</p>
          )}
          {brand?.greetingExample ? (
            <p className={styles.quiet}>
              {t('brand.greetingLine', { greeting: brand.greetingExample })}
            </p>
          ) : null}
          {brand?.forbiddenWords.length ? (
            <p className={styles.quiet}>
              {t('brand.never', { words: brand.forbiddenWords.join(', ') })}
            </p>
          ) : null}
          <ItemActions onEdit={() => setEditing(true)} preview={preview} testid="review-brand" />
        </>
      )}
    </Section>
  );
}
