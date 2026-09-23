import { getTranslations } from 'next-intl/server';

import {
  anyFieldAttributed,
  fieldOrigin,
  isUnusableValue,
  PROVENANCED_FIELDS,
  type FieldOrigin,
  type Workspace,
} from '@/api/contracts/workspace';

import styles from './Workspace.module.css';

/**
 * Where each business detail came from — screen 11b.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE BADGES WILL ALL BE BLANK, AND THE PANEL SAYS WHY
 * ════════════════════════════════════════════════════════════════════════════
 * The mechanic the design asks for — *"Scan again only touches fields marked
 * From website"* — is fully implemented in `field-provenance.service.ts`.
 *
 * **And `profileFieldProvenance` has zero rows across the entire database.**
 * Every field on every tenant is unmarked, so a rescan today applies nothing
 * and offers everything.
 *
 * A panel of empty badges with no explanation would read as a broken feature.
 * The true sentence is better than that, because the map is self-healing:
 * *the first scan asks about everything; after that it refreshes what it wrote
 * itself.* That describes a system that improves, and it is the only honest
 * thing to put above a set of badges that are all going to say the same thing.
 *
 * ── THREE STATES, AND THE THIRD IS NOT A MISSING SECOND ──
 * `null` is UNKNOWN, not *"from the website"*. The profile was seeded by an
 * onboarding confirm step that *"means two different things: 'the scan
 * proposed this' and 'the human accepted or corrected it'. Same column, same
 * statement."* Labelling an unmarked field *"From your website"* would be a
 * guess printed as a fact — and it is the exact guess that would let a rescan
 * overwrite somebody's correction.
 */
export async function FieldProvenance({ workspace }: { readonly workspace: Workspace }) {
  const t = await getTranslations('workspace.provenance');
  const attributed = anyFieldAttributed(workspace);

  /** Field key → the value the workspace actually holds for it. */
  const values: Record<string, string | null | undefined> = {
    organizationName: workspace.name,
    businessDescription: workspace.description,
    industry: workspace.industry,
    country: workspace.country,
    primaryLanguage: workspace.languages[0] ?? null,
    address: workspace.address,
    currency: workspace.currency,
  };

  return (
    <section className={styles.provenance} data-testid="provenance" data-attributed={attributed}>
      <h2 className={styles.provenanceHeading}>{t('heading')}</h2>

      {attributed ? (
        <p className={styles.provenanceLead} data-testid="provenance-some">
          {t('someAttributed')}
        </p>
      ) : (
        <div className={styles.provenanceNotice} data-testid="provenance-none">
          {/*
            Not an apology. The first scan asks about everything BECAUSE the
            alternative is guessing who wrote a field, and guessing wrong
            overwrites a correction somebody made during onboarding.
          */}
          <p className={styles.provenanceLeadStrong}>{t('nothingAttributed.lead')}</p>
          <p className={styles.provenanceLead}>{t('nothingAttributed.body')}</p>
        </div>
      )}

      <dl className={styles.provenanceFields}>
        {PROVENANCED_FIELDS.map((field) => (
          <FieldRow
            key={field}
            label={t(`field.${field}`)}
            origin={fieldOrigin(workspace, field)}
            value={values[field] ?? null}
            originLabel={t(`origin.${fieldOrigin(workspace, field)}`)}
            unusableLabel={t('unusable')}
            notSetLabel={t('notSet')}
          />
        ))}
      </dl>

      {/*
        11d, in two facts rather than one alarming one.

        No control, because `PATCH /workspace` validates up to SIX languages
        and then writes `primaryLanguage = languages[0]`: a multi-select would
        be accepted, answered 200, and silently drop the rest.

        But the sentence does NOT lead with "GOTCHA holds one reply language",
        which is true and reads as a problem. Backend confirmed the stored
        value does not participate in replies at all — the live path decides
        from the conversation, on a prompt rule marked non-negotiable, and
        never reads this column. It is used to tag knowledge documents.

        So the honest version says the replies are already right and names
        what the setting actually does. Not for reassurance: the old sentence
        invited a merchant to go and fix something that is not broken, and the
        real risk runs the other way — the day somebody wires this inert
        setting up and it starts overriding a rule that was working. A
        merchant cannot act on that. Saying less here is more accurate.
      */}
      <p className={styles.provenanceNote} data-testid="provenance-one-language">
        {t('oneLanguage')}
      </p>
    </section>
  );
}

/**
 * One field, its value and where it came from.
 *
 * Synchronous and given its strings. An async child cannot be resolved outside
 * a server renderer, which makes the whole subtree untestable — every
 * assertion then fails identically whatever is actually wrong.
 */
function FieldRow({
  label,
  origin,
  value,
  originLabel,
  unusableLabel,
  notSetLabel,
}: {
  readonly label: string;
  readonly origin: FieldOrigin;
  readonly value: string | null;
  readonly originLabel: string;
  readonly unusableLabel: string;
  readonly notSetLabel: string;
}) {
  const unusable = isUnusableValue(value);

  return (
    <div className={styles.provenanceRow} data-testid="provenance-row" data-origin={origin}>
      <dt className={styles.provenanceLabel}>{label}</dt>
      <dd className={styles.provenanceValue}>
        {unusable ? (
          <span className={styles.provenanceUnset} data-testid="provenance-unset">
            {/*
              `country` arrives as the literal string "unknown" on this tenant.
              Rendered as-is it reads as a country called "unknown"; rendered
              blank it reads as a field nobody filled in. Neither is true — we
              looked, and what came back was unusable. So that is what it says,
              and only when there WAS a value to reject.
            */}
            {value != null && value.trim() !== '' ? unusableLabel : notSetLabel}
          </span>
        ) : (
          <span>{value}</span>
        )}
        <span className={styles.provenanceOrigin} data-testid="provenance-origin">
          {originLabel}
        </span>
      </dd>
    </div>
  );
}
