'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState, useTransition, type ReactNode } from 'react';

import {
  POLICY_KINDS,
  sourceOf,
  type Learned,
  type LearnedFaq,
  type LearnedPolicy,
  type LearnedSection,
} from '@/api/contracts/onboarding-v2';
import { Input } from '@/design-system/primitives/input/Input';
import { Link, useRouter } from '@/i18n/navigation';

import {
  addPolicy,
  editLearned,
  type AddPolicyResult,
  type LearnedEdit,
  type LearnedEditResult,
} from './learned-actions';
import styles from './Onboarding.module.css';
import { stepHref } from './preview';
import { nameOf } from './ScanFeed';
import { UPLOAD_TYPES, uploadLearned, type UploadRefusal } from './upload-learned';

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
  const router = useRouter();
  return (
    <div className={styles.review} data-testid={`review-${reason}`}>
      <h1 className={styles.title}>{t('title')}</h1>
      <p className={styles.why} role="alert">
        {t(`unavailable.${reason}`)}
      </p>
      <span className={styles.actions}>
        {/* A read that failed can be tried again; nothing learned yet goes back to learning. */}
        {reason === 'unread' ? (
          <button
            type="button"
            className={styles.primary}
            onClick={() => router.refresh()}
            data-testid="review-retry"
          >
            {t('unavailable.retry')}
          </button>
        ) : null}
        <Link
          href={stepHref('/onboarding/website', preview)}
          className={reason === 'unread' ? styles.secondary : styles.primary}
          data-testid="review-back"
        >
          {t('unavailable.toWebsite')}
        </Link>
      </span>
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
              dir="auto"
              className={styles.textarea}
              value={values[field.key] ?? ''}
              rows={4}
              onChange={(event) => setValues({ ...values, [field.key]: event.target.value })}
            />
          </label>
        ) : (
          <Input
            dir="auto"
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
            {/* Only the store's own feed fills this (Shopify or Woo): a real count, "at least" when paging stopped. */}
            {t('products.count', { count: products.count, more: String(products.more) })}
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
      {/* Under the last policy: one quiet line when some were learned, open when none were. */}
      {preview ? null : (
        <AddMissing learned={learned} onDone={onDone} collapsed={learned.policies.length > 0} />
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
        <PolicyEdit policy={policy} onDone={onDone} onCancel={() => setEditing(false)} />
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
          <Source sourceUrl={policy.sourceUrl} />
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

/** Where an item came from: the site (a link), what the owner pasted, or their file. */
function Source({ sourceUrl }: { readonly sourceUrl: string | null }) {
  const t = useTranslations('onboarding.review');
  const source = sourceOf(sourceUrl);
  if (!source) return null;
  if (source.kind === 'web') {
    return (
      <a href={source.url} target="_blank" rel="noopener noreferrer" className={styles.inlineLink}>
        {t('source')}
      </a>
    );
  }
  return (
    <span className={styles.quiet} data-testid="review-source">
      {source.kind === 'pasted'
        ? t('fromPasted')
        : t.rich('fromFile', {
            name: source.name,
            file: (chunks) => <bdi dir="auto">{chunks}</bdi>,
          })}
    </span>
  );
}

/**
 * What the site didn't give us - a site that blocks automatic reading, a
 * policy that isn't on it - added from what the owner has: a policy pasted
 * in, or a file. Both land in what was learned AND the knowledge base
 * (Backend e2e8623f), and the screen redraws from the answer.
 */
function AddMissing({
  learned,
  onDone,
  collapsed,
}: {
  readonly learned: Learned;
  readonly onDone: (learned: Learned) => void;
  /** Some policies were learned: a quiet line that opens the form, so the screen stays short. */
  readonly collapsed: boolean;
}) {
  const t = useTranslations('onboarding.review');
  const ts = useTranslations('onboarding.scan');
  const missing = POLICY_KINDS.filter((kind) => !learned.policies.some((p) => p.kind === kind));
  const [kind, setKind] = useState<string>(missing[0] ?? 'other');
  const [text, setText] = useState('');
  const [pasteRefused, setPasteRefused] = useState<
    Exclude<AddPolicyResult, { ok: true }>['reason'] | null
  >(null);
  const [isPasting, startPaste] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, startUpload] = useTransition();
  const [open, setOpen] = useState(!collapsed);
  const [upload, setUpload] = useState<
    | {
        readonly ok: true;
        readonly policies: number;
        readonly faq: number;
        readonly partial: boolean;
      }
    | { readonly ok: false; readonly reason: UploadRefusal }
    | null
  >(null);

  if (!open) {
    return (
      <button
        type="button"
        className={styles.textButton}
        onClick={() => setOpen(true)}
        data-testid="review-add-open"
      >
        {t('add.collapsed')}
      </button>
    );
  }
  return (
    <div className={styles.addMissing} data-testid="review-add">
      <p className={styles.itemTitle}>{t('add.title')}</p>
      <p className={styles.quiet}>{t('add.lead')}</p>

      <form
        className={styles.connectHere}
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || isPasting) return;
          startPaste(async () => {
            setPasteRefused(null);
            const result = await addPolicy(kind, text).catch(
              () => ({ ok: false, reason: 'failed' }) as const,
            );
            if (result.ok) {
              onDone(result.learned);
              setText('');
            } else setPasteRefused(result.reason);
          });
        }}
        data-testid="review-paste"
      >
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('add.kind')}</span>
          <select
            className={styles.select}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            data-testid="review-paste-kind"
          >
            {(missing.length ? missing : (['other'] as const)).map((each) => (
              <option key={each} value={each}>
                {ts(`chips.policy.${each}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('add.text')}</span>
          <textarea
            dir="auto"
            className={styles.textarea}
            rows={5}
            value={text}
            onChange={(event) => setText(event.target.value)}
            data-testid="review-paste-text"
          />
        </label>
        <button
          type="submit"
          className={styles.secondary}
          disabled={!text.trim() || isPasting}
          data-testid="review-paste-add"
        >
          {isPasting ? t('add.adding') : t('add.addPolicy')}
        </button>
        {pasteRefused ? (
          <p className={styles.problem} role="alert" data-testid="review-paste-refused">
            {t(`add.refused.${pasteRefused}`)}
          </p>
        ) : null}
      </form>

      <form
        className={styles.connectHere}
        onSubmit={(event) => {
          event.preventDefault();
          if (!file || isUploading) return;
          startUpload(async () => {
            setUpload(null);
            const read = await uploadLearned(file).catch(
              () => ({ ok: false, reason: 'failed' }) as const,
            );
            if (read.ok) {
              onDone(read.result);
              setUpload({
                ok: true,
                policies: read.result.added.policies.length,
                faq: read.result.added.faq,
                partial: read.result.partial,
              });
              setFile(null);
            } else setUpload(read);
          });
        }}
        data-testid="review-upload"
      >
        {/* The browser's own file control speaks its own language: ours is a labelled button. */}
        <span className={styles.fieldLabel}>{t('add.file')}</span>
        <span className={styles.connectHere}>
          <label className={styles.secondary}>
            {t('add.choose')}
            <input
              type="file"
              className={styles.srOnly}
              accept={UPLOAD_TYPES.join(',')}
              onChange={(event) => {
                setUpload(null);
                setFile(event.target.files?.[0] ?? null);
              }}
              data-testid="review-upload-file"
            />
          </label>
          <span className={styles.quiet} data-testid="review-upload-name">
            {file ? <bdi dir="auto">{file.name}</bdi> : t('add.noFile')}
          </span>
        </span>
        <span className={styles.quiet}>
          {t.rich('add.fileHint', { ltr: (chunks) => <bdi dir="ltr">{chunks}</bdi> })}
        </span>
        <button
          type="submit"
          className={styles.secondary}
          disabled={!file || isUploading}
          data-testid="review-upload-go"
        >
          {isUploading ? t('add.reading') : t('add.readFile')}
        </button>
        {isUploading ? <p className={styles.quiet}>{t('add.readingWhy')}</p> : null}
        {upload?.ok ? (
          <p className={styles.quiet} role="status" data-testid="review-upload-done">
            {t('add.added', { policies: upload.policies, faq: upload.faq })}
            {upload.partial ? ` ${t('add.partial')}` : ''}
          </p>
        ) : upload ? (
          <p className={styles.problem} role="alert" data-testid="review-upload-refused">
            {t(`add.uploadRefused.${upload.reason}`)}
          </p>
        ) : null}
      </form>
    </div>
  );
}

/** Which terms a policy of each kind is edited by (plus any term it already has). */
const TERMS_OF: Readonly<Record<string, readonly TermKey[]>> = {
  returns: ['windowDays', 'exchange', 'refund'],
  exchange: ['exchange'],
  shipping: ['shipping'],
  refund: ['refund'],
  warranty: ['warranty'],
};
type TermKey = 'windowDays' | 'exchange' | 'shipping' | 'refund' | 'warranty';
const TERM_KEYS: readonly TermKey[] = ['windowDays', 'exchange', 'shipping', 'refund', 'warranty'];

const asNumber = (value: string) => {
  const n = Number(value.trim());
  return value.trim() === '' || !Number.isFinite(n) || n < 0 ? null : Math.round(n);
};
const asText = (value: string) => (value.trim() === '' ? null : value.trim());
/** A term with nothing in it is `null`, as the scan stores an unstated one. */
const group = <T extends Record<string, unknown>>(value: T) =>
  Object.values(value).every((each) => each === null) ? null : value;

/**
 * A policy is edited WHOLE: its summary and each of its terms, in one form,
 * saved together. The terms are what the employee reads when a customer asks
 * "how many days to return?", so they are never left behind by an edit to
 * the words above them (Backend merges `terms` by key).
 */
function PolicyEdit({
  policy,
  onDone,
  onCancel,
}: {
  readonly policy: LearnedPolicy;
  readonly onDone: (learned: Learned) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('onboarding.review');
  const terms = policy.terms;
  const keys = TERM_KEYS.filter(
    (key) => (TERMS_OF[policy.kind] ?? []).includes(key) || (terms?.[key] ?? null) !== null,
  );
  const initial = {
    summary: policy.summary ?? '',
    windowDays: terms?.windowDays?.toString() ?? '',
    exchangeAllowed:
      terms?.exchange?.allowed === true ? 'yes' : terms?.exchange?.allowed === false ? 'no' : '',
    exchangeHow: terms?.exchange?.how ?? '',
    shippingTimes: terms?.shipping?.times ?? '',
    shippingCosts: terms?.shipping?.costs ?? '',
    freeOver: terms?.shipping?.freeOver ?? '',
    refundMethod: terms?.refund?.method ?? '',
    refundDays: terms?.refund?.days?.toString() ?? '',
    warrantyMonths: terms?.warranty?.months?.toString() ?? '',
  };
  const [values, setValues] = useState(initial);
  const { run, isPending, refused } = useEdit(onDone);
  const set = (key: keyof typeof initial) => (event: { target: { value: string } }) =>
    setValues({ ...values, [key]: event.target.value });
  const changed = (Object.keys(initial) as (keyof typeof initial)[]).some(
    (key) => values[key] !== initial[key],
  );

  const termsValue = () => {
    const out: Record<string, unknown> = {};
    if (keys.includes('windowDays')) out.windowDays = asNumber(values.windowDays);
    if (keys.includes('exchange')) {
      out.exchange = group({
        allowed:
          values.exchangeAllowed === 'yes' ? true : values.exchangeAllowed === 'no' ? false : null,
        how: asText(values.exchangeHow),
      });
    }
    if (keys.includes('shipping')) {
      out.shipping = group({
        times: asText(values.shippingTimes),
        costs: asText(values.shippingCosts),
        freeOver: asText(values.freeOver),
      });
    }
    if (keys.includes('refund')) {
      out.refund = group({
        method: asText(values.refundMethod),
        days: asNumber(values.refundDays),
      });
    }
    if (keys.includes('warranty'))
      out.warranty = group({ months: asNumber(values.warrantyMonths) });
    return out;
  };

  return (
    <form
      className={styles.policyEdit}
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || isPending) return;
        run(
          {
            section: 'policies',
            id: policy.id,
            value: {
              summary: values.summary.trim(),
              ...(keys.length ? { terms: termsValue() } : {}),
            },
          },
          onCancel,
        );
      }}
      data-testid={`review-edit-policies-${policy.id}`}
    >
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('policies.summary')}</span>
        <textarea
          dir="auto"
          className={styles.textarea}
          rows={3}
          value={values.summary}
          onChange={set('summary')}
        />
      </label>
      {keys.length ? <p className={styles.quiet}>{t('policies.termsNote')}</p> : null}
      <div className={styles.termGrid}>
        {keys.includes('windowDays') ? (
          <Input
            dir="auto"
            label={t('termFields.windowDays')}
            inputMode="numeric"
            value={values.windowDays}
            onChange={set('windowDays')}
          />
        ) : null}
        {keys.includes('exchange') ? (
          <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t('termFields.exchange')}</span>
              <select
                className={styles.select}
                value={values.exchangeAllowed}
                onChange={set('exchangeAllowed')}
              >
                <option value="">{t('termFields.unknown')}</option>
                <option value="yes">{t('termFields.yes')}</option>
                <option value="no">{t('termFields.no')}</option>
              </select>
            </label>
            <Input
              dir="auto"
              label={t('termFields.exchangeHow')}
              value={values.exchangeHow}
              onChange={set('exchangeHow')}
            />
          </>
        ) : null}
        {keys.includes('shipping') ? (
          <>
            <Input
              dir="auto"
              label={t('termFields.shippingTimes')}
              value={values.shippingTimes}
              onChange={set('shippingTimes')}
            />
            <Input
              dir="auto"
              label={t('termFields.shippingCosts')}
              value={values.shippingCosts}
              onChange={set('shippingCosts')}
            />
            <Input
              dir="auto"
              label={t('termFields.freeOver')}
              value={values.freeOver}
              onChange={set('freeOver')}
            />
          </>
        ) : null}
        {keys.includes('refund') ? (
          <>
            <Input
              dir="auto"
              label={t('termFields.refundMethod')}
              value={values.refundMethod}
              onChange={set('refundMethod')}
            />
            <Input
              dir="auto"
              label={t('termFields.refundDays')}
              inputMode="numeric"
              value={values.refundDays}
              onChange={set('refundDays')}
            />
          </>
        ) : null}
        {keys.includes('warranty') ? (
          <Input
            dir="auto"
            label={t('termFields.warrantyMonths')}
            inputMode="numeric"
            value={values.warrantyMonths}
            onChange={set('warrantyMonths')}
          />
        ) : null}
      </div>
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
