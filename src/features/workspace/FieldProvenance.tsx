import { getLocale, getTranslations } from 'next-intl/server';

import {
  anyFieldAttributed,
  fieldOrigin,
  isUnusableValue,
  PROVENANCED_FIELDS,
  type FieldOrigin,
  type Workspace,
} from '@/api/contracts/workspace';

import { humaniseCode, looksLikeCode } from '@/api/contracts/capabilities';
import { UserText } from '@/design-system/primitives/text/UserText';

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
 *
 * ── AND THE FIRST VERSION OF THIS COMMENT WAS WRONG ──
 * It said the map is self-healing: *"the first scan asks about everything;
 * after that it refreshes what it wrote itself."* The service's own header
 * says the same. **It cannot happen.**
 *
 * `planRescan` applies a field only when `provenance[field]?.source === "scan"`,
 * and `runProfileRescan` stamps `"scan"` only for what it applied. So the
 * scan re-marks fields it already owns and can never take ownership of one it
 * does not. There are exactly two stamp sites in the platform, verified
 * repo-wide, and the other one writes `"human"`.
 *
 * Accepting a suggestion goes through `PATCH /workspace`, which stamps
 * `"human"`. So the review flow cannot make a field scan-owned either.
 *
 * **`scan` is unreachable from `unknown`.** On an estate whose provenance map
 * is empty everywhere, no field will ever be silently refreshed, and the
 * honest sentence is that it will keep asking — not that it will stop.
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
  const locale = await getLocale();
  const attributed = anyFieldAttributed(workspace);
  const named = displayName(locale);

  /**
   * Field key → the value the workspace actually holds for it, in the reader's
   * language.
   *
   * ════════════════════════════════════════════════════════════════════════
   * ★★ FOUR OF THESE SEVEN FIELDS HELD A CODE, AND THE PANEL PRINTED IT
   * ════════════════════════════════════════════════════════════════════════
   * A browser walk found *"Reply language · he"* here, two rows under a fact
   * table that says **"GOTCHA runs in Hebrew."** Going looking for its
   * siblings — the discipline this batch exists to teach — found `country` as
   * `IL` and `currency` as `ILS` on the same list.
   *
   * `Intl.DisplayNames` is the right instrument and not a lookup table of our
   * own: it is already in the runtime, it is translated for both locales, and
   * the day the platform stores a country we have never seen it still answers.
   * `industry` has no standard to name it, so it goes through `humaniseCode`.
   *
   * ⚠ Converted only when the value is USABLE. `country` arrives as the
   * literal string `"unknown"` on this tenant; naming it first would hand
   * `Intl` a malformed code and hide the third state the row below exists to
   * report.
   */
  const values: Record<string, string | null | undefined> = {
    organizationName: workspace.name,
    businessDescription: workspace.description,
    industry: usable(workspace.industry)
      ? named('industry', workspace.industry)
      : workspace.industry,
    country: usable(workspace.country) ? named('region', workspace.country) : workspace.country,
    primaryLanguage: usable(workspace.languages[0])
      ? named('language', workspace.languages[0])
      : (workspace.languages[0] ?? null),
    address: workspace.address,
    currency: usable(workspace.currency)
      ? named('currency', workspace.currency)
      : workspace.currency,
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

/** A value worth naming: present, non-blank, and not the platform's `unknown`. */
function usable(value: string | null | undefined): value is string {
  return value != null && value.trim() !== '' && !isUnusableValue(value);
}

/**
 * A platform code in the reader's language.
 *
 * Every branch falls back to the code itself. `Intl.DisplayNames.of` returns
 * its input for a well-formed code it does not know and **throws** on a
 * malformed one, so an unrecognised country shows the country rather than
 * taking the panel down — the same call `money()` makes on an unknown currency.
 */
function displayName(locale: string) {
  return (kind: 'region' | 'language' | 'currency' | 'industry', code: string): string => {
    if (kind === 'industry') return looksLikeCode(code) ? humaniseCode(code) : code;
    try {
      return new Intl.DisplayNames([locale], { type: kind }).of(code) ?? code;
    } catch {
      return code;
    }
  };
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
          /*
            ★★ THE SIBLING OF `FactRows`. The fact table 500 pixels above this
            list renders the same strings inside an isolate; this one did not,
            so one page showed "What you sell" correct and scrambled at once.
            One screenshot held both. Wave 1 applied `UserText` at five
            surfaces and this was the sixth, missed because the walk that found
            the defect photographed the table and not the list.
          */
          <UserText>{value}</UserText>
        )}
        <span className={styles.provenanceOrigin} data-testid="provenance-origin">
          {originLabel}
        </span>
      </dd>
    </div>
  );
}
