import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { channelName } from '@/api/contracts/inbox';
import {
  bodyParts,
  groupByName,
  isUnchanged,
  templateStance,
  type Template,
  type TemplateGroup,
  type TemplateStance,
} from '@/api/contracts/templates';
import { Link } from '@/i18n/navigation';

import { DuplicateTemplate } from './DuplicateTemplate';
import styles from './Outreach.module.css';

/**
 * Screen 05c — message templates, measured.
 *
 * A table card (684 wide; head `#F5F2EC` at `padding:11px 18px`; rows at
 * `14px 18px`; the open one `#FCFBF8` with 02's 3px dark edge; the window
 * note as its foot) beside a 440 column: the preview, a rejection when there
 * is one, and "Worth knowing".
 *
 * ── WHAT EACH PART IS MADE OF ──
 *   USED · REPLIES   "—": nothing counts a template's sends or replies. 02's
 *                    own spec lists both under "needs from the backend".
 *   STATE            the platform's review status, said as what you can do
 *   preview          the body as a message, its {{n}} filled with each
 *                    variable's sample — highlighted — and its real buttons
 *   Filled in from   the variables' descriptions
 *   Who may send it  "—": nothing records which employees may
 *   Approved         that it is, and whether it changed since (`version`);
 *                    no approval DATE exists
 *
 * ⚠ NOT DRAWN, BY STANDING RULINGS: 02's In flight / Templates / Calls /
 * Finished tabs (the shell's rail carries these; the in-page tabs wait on
 * Omer) and "New template" (creating outreach waits on his decision).
 */

/** One group per name: `@@unique([tenantId, name, language, channel])`. */
export function templateGroups(templates: readonly Template[]): readonly TemplateGroup[] {
  return groupByName(templates);
}

/** The group a `?template=` id belongs to, else the first. */
export function selectedGroup(
  groups: readonly TemplateGroup[],
  wanted: string | undefined,
): TemplateGroup | null {
  return groups.find((group) => group.all.some((t) => t.id === wanted)) ?? groups[0] ?? null;
}

/**
 * "a, b and c". English lists here drop the comma before "and" — `en`'s own
 * list format keeps it, `en-GB`'s does not; other languages use their own.
 */
function joinWithAnd(items: readonly string[], locale: string): string {
  const tag = locale.startsWith('en') ? 'en-GB' : locale;
  return new Intl.ListFormat(tag, { style: 'long', type: 'conjunction' }).format(items);
}

/** The body as one line, its variables in braces: "Hi {John} — the {lamp} is back". */
function bodyLine(template: Template): string {
  return bodyParts(template)
    .map((part) => ('text' in part ? part.text : `{${part.variable}}`))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function TemplateTable({
  groups,
  selectedId,
}: {
  readonly groups: readonly TemplateGroup[] | null;
  readonly selectedId: string | null;
}) {
  const t = await getTranslations('templates');
  const channels = await getTranslations('channels');

  const chip = (stance: TemplateStance, template: Template) =>
    stance === 'exempt'
      ? t('stance.exempt', {
          channel: channelName(template.channel, channels) ?? template.channel ?? '',
        })
      : t(`stance.${stance}` as 'stance.ready');

  return (
    <section className={styles.tplTable} data-testid="template-list">
      <div className={styles.tplHead} aria-hidden="true">
        <span>{t('head.template')}</span>
        <span>{t('head.used')}</span>
        <span>{t('head.replies')}</span>
        <span>{t('head.state')}</span>
      </div>

      <div className={styles.tplRows}>
        {groups === null ? (
          <p className={styles.tplNone} data-testid="templates-unavailable">
            {t('unavailable')}
          </p>
        ) : groups.length === 0 ? (
          /*
            The consequence, not just the absence: with no template you can
            only continue conversations, never begin one. One line, the
            consequence its tooltip.
          */
          <p className={styles.tplNone} data-testid="templates-empty" title={t('noneBody')}>
            {t('none')}
          </p>
        ) : (
          <ul className={styles.tplList}>
            {groups.map((group) => {
              const stance = templateStance(group.primary);
              const open = group.primary.id === selectedId;
              return (
                <li key={group.name}>
                  <Link
                    href={{
                      pathname: '/outreach/templates',
                      query: { template: group.primary.id },
                    }}
                    className={styles.tplRow}
                    aria-current={open ? 'true' : undefined}
                    data-stance={stance}
                    data-testid={`template-${group.primary.id}`}
                  >
                    <span className={styles.tplText}>
                      <span className={styles.tplName}>{group.name}</span>
                      <span className={styles.tplLine}>{bodyLine(group.primary)}</span>
                    </span>
                    {/* Nothing counts a template's sends or replies: 02 lists both as backend needs. */}
                    <span className={styles.tplFigure}>—</span>
                    <span className={styles.tplFigure}>—</span>
                    <span className={styles.tplState}>
                      <span
                        className={styles.tplChip}
                        data-stance={stance}
                        data-testid={`stance-${group.primary.id}`}
                      >
                        {chip(stance, group.primary)}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 02's foot: inside the 24-hour window no template is needed. */}
      <p className={styles.tplFoot} data-testid="window-note">
        {t('window')}
      </p>
    </section>
  );
}

/** 05c's preview card: the template as the customer will see it. */
export async function TemplatePreview({ group }: { readonly group: TemplateGroup | null }) {
  const t = await getTranslations('templates');
  const format = await getFormatter();
  const locale = await getLocale();

  if (group === null) {
    return (
      <section className={styles.tplCard} data-testid="template-preview">
        <div className={styles.tplCardHead}>
          <span className={styles.tplCardName}>—</span>
        </div>
        <div className={styles.tplStage} />
      </section>
    );
  }

  const template = group.primary;
  const languageNames = new Intl.DisplayNames([locale], { type: 'language' });
  const languages = format.list(
    group.languages.map((code) => {
      try {
        return languageNames.of(code) ?? code;
      } catch {
        return code;
      }
    }),
    { type: 'unit' },
  );
  /*
    One sentence, not a list of labels: "The customer, the product and when
    they asked" — lowercase after the first, and no comma before "and", as
    the rest of the app writes a list.
  */
  const filledFrom = template.variables
    .map((variable) => variable.description?.trim())
    .filter((text): text is string => !!text)
    .map((text, index) =>
      index === 0 ? text : text.charAt(0).toLocaleLowerCase(locale) + text.slice(1),
    );
  const stance = templateStance(template);

  return (
    <section className={styles.tplCard} data-testid="template-preview">
      <div className={styles.tplCardHead}>
        <span className={styles.tplCardName}>{group.name}</span>
        <span className={styles.tplLangs} data-testid="template-languages">
          {languages}
        </span>
      </div>

      {/* The stage: 02's `#F5F2EC`, the message as a bubble, its buttons under it. */}
      <div className={styles.tplStage}>
        <div className={styles.tplBubble} data-testid="template-bubble">
          {template.headerType === 'text' && template.headerContent ? (
            <strong className={styles.tplBubbleHead}>{template.headerContent}</strong>
          ) : null}
          <p className={styles.tplBubbleBody}>
            {bodyParts(template).map((part, index) =>
              'text' in part ? (
                <span key={index}>{part.text}</span>
              ) : (
                <mark key={index} className={styles.tplVar} title={`{{${part.key}}}`}>
                  {part.variable}
                </mark>
              ),
            )}
          </p>
          {template.footer ? <p className={styles.tplBubbleFoot}>{template.footer}</p> : null}
        </div>
        {template.buttons.length > 0 ? (
          <div className={styles.tplButtons}>
            {template.buttons
              .filter((button) => button.text.trim())
              .map((button, index) => (
                <span key={index} className={styles.tplButton}>
                  {button.text}
                </span>
              ))}
          </div>
        ) : null}
      </div>

      <dl className={styles.tplFacts}>
        <div>
          <dt>{t('preview.filledFrom')}</dt>
          <dd data-testid="template-filled-from">
            {filledFrom.length > 0 ? joinWithAnd(filledFrom, locale) : '—'}
          </dd>
        </div>
        {/* Nothing records which employees or automations may send it. */}
        <div>
          <dt>{t('preview.whoMay')}</dt>
          <dd>—</dd>
        </div>
        <div>
          <dt>{t('preview.approved')}</dt>
          <dd data-ok={stance === 'ready' ? '' : undefined} data-testid="template-approved">
            {stance === 'ready'
              ? isUnchanged(template)
                ? t('preview.unchanged')
                : t('preview.changed', { version: template.version })
              : stance === 'off' && template.status === 'APPROVED'
                ? t('preview.approvedOff')
                : stance === 'exempt' || stance === 'off'
                  ? t('preview.noReview')
                  : '—'}
          </dd>
        </div>
      </dl>

      {/*
        Live (Omer, 2026-10-04): an approved template opens the draft-campaign
        drawer with it chosen; Duplicate makes a local DRAFT copy. Submitting
        a draft to Meta is a separate write — drawn, with why.
      */}
      <div className={styles.tplActions}>
        {template.status === 'APPROVED' ? (
          <Link
            href={{ pathname: '/outreach', query: { create: 'campaign', template: template.id } }}
            className={styles.tplPrimary}
            data-testid="template-use"
          >
            {t('useInCampaign')}
          </Link>
        ) : (
          <span
            className={styles.tplPrimary}
            aria-disabled="true"
            title={t('useNeedsApproval')}
            data-testid="template-use"
          >
            {t('useInCampaign')}
          </span>
        )}
        <DuplicateTemplate id={template.id} />
        {template.status === 'DRAFT' ? (
          <span
            className={styles.tplSecondary}
            aria-disabled="true"
            title={t('submitNotYet')}
            data-testid="template-submit"
          >
            {t('submit')}
          </span>
        ) : null}
      </div>
    </section>
  );
}

/**
 * 02's rejection card — for the first rejected template, with WhatsApp's own
 * words. Drawn only when one exists: a pink card announcing nothing would
 * alarm. No rewrite exists to see, and no email fallback to send by, so both
 * controls are drawn and not live.
 */
export async function RejectedCard({ groups }: { readonly groups: readonly TemplateGroup[] }) {
  const t = await getTranslations('templates');
  const rejected = groups.find((group) => templateStance(group.primary) === 'rejected');
  if (!rejected) return null;
  return (
    <section className={styles.tplRejected} data-testid="template-rejected">
      <p className={styles.tplRejectedTitle}>{t('rejected.title', { name: rejected.name })}</p>
      <p className={styles.tplRejectedBody} data-testid={`reason-${rejected.primary.id}`}>
        {rejected.primary.rejectionReason
          ? t('rejectedBecause', { reason: rejected.primary.rejectionReason })
          : t('rejected.noReason')}
      </p>
      <div className={styles.tplActions}>
        <span className={styles.tplPrimary} aria-disabled="true">
          {t('rejected.seeRewrite')}
        </span>
        <span className={styles.tplRejectedSecondary} aria-disabled="true">
          {t('rejected.byEmail')}
        </span>
      </div>
    </section>
  );
}

/** 02's "Worth knowing": what the reply rates say. Nothing counts them yet. */
export async function WorthKnowing() {
  const t = await getTranslations('templates');
  return (
    <section className={styles.tplWorth} data-testid="template-worth">
      <p className={styles.tplWorthTitle}>{t('worth.title')}</p>
      <p className={styles.tplWorthBody}>{t('worth.none')}</p>
    </section>
  );
}
