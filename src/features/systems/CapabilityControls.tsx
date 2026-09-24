import type { getTranslations } from 'next-intl/server';

import type { CapabilityRow, SystemRow } from './rows';
import styles from './Systems.module.css';

/**
 * Screen 14d — what each capability may do, as the control it really is.
 *
 * ── WHY THE CONTROLS ARE HERE AND DISABLED ──
 * `PUT /api/tool-permissions/:toolName` provisions the `TenantTool` and
 * writes the `TenantToolPermission` in ONE call, and it answers
 * **409 `integration for "<slug>" is not connected`** when the system behind
 * the tool is not reachable. On this tenant that is every tool, because the
 * only integration is in ERROR.
 *
 * So there were two wrong screens available. Live toggles would fail on
 * click, every time, teaching a merchant that the page is broken rather than
 * that their shop is. No controls at all — which is what this screen had —
 * hides that these are settings somebody chose, and makes the counts above
 * read like a property of the product.
 *
 * Reading the current value needs no connection. So the value is shown, in
 * the control it lives in, and the save is disabled **with its reason**
 * pointing at the same repair the banner above already describes.
 *
 * ── THE THREE STATES ARE ONE CONTROL, NOT TWO ──
 * `enabled` and `requiresApproval` are written together by that single call,
 * so they cannot disagree:
 *
 *     Never        enabled false
 *     Asks first   enabled true · requiresApproval true
 *     On its own   enabled true · requiresApproval false
 *
 * Rendering them as two checkboxes would invent a fourth state — disabled but
 * requiring approval — that the endpoint cannot produce.
 *
 * ── ★ AND "ASKS FIRST" IS NOT A LABEL ──
 * It is the Approvals queue. `requiresApproval` creates a real
 * `ApprovalRequest` and HOLDS the conversation until a person decides — the
 * same queue screen 03 renders. The design asked only that this screen use
 * "the same words as Approvals"; the truth is stronger than the consistency,
 * and a merchant who knows where the action goes understands the setting
 * completely.
 *
 * A server component. Everything is disabled, so there is nothing to hydrate.
 */
export function CapabilityControls({
  row,
  t,
}: {
  readonly row: SystemRow;
  readonly t: Awaited<ReturnType<typeof getTranslations<'systems'>>>;
}) {
  /*
   * A failed policy read is not an empty policy. `stance` is null then, and
   * pre-selecting anything — even "Never" — would show a decision nobody
   * made. `stance-unknown-<slug>` upstream already says we could not check;
   * drawing controls under it would contradict it.
   */
  const known = row.capabilities.filter(
    (capability): capability is CapabilityRow & { stance: NonNullable<CapabilityRow['stance']> } =>
      capability.stance !== null,
  );

  if (known.length === 0) return null;

  /*
   * ── WHY THIS IS COLLAPSED ──
   * Shopify alone carries 68 capabilities, of which exactly one is
   * restricted. Sixty-eight three-state controls expanded by default is 204
   * radios burying everything else on the screen, and it answers a question
   * almost nobody arrives with — the counts above already say what this
   * system may do, and the restricted list already names what somebody
   * decided.
   *
   * `<details>` is native, so this stays a server component with nothing to
   * hydrate, and the full audit surface is one click away rather than absent.
   * The ones in a non-default state sort first: a reader who opens this is
   * looking for a decision, not for an alphabet.
   */
  const ordered = [...known].sort((a, b) => {
    const rank = (stance: string) => (stance === 'allow' ? 1 : 0);
    return rank(a.stance) - rank(b.stance);
  });

  return (
    <details className={styles.tools} data-testid={`tools-${row.slug}`}>
      <summary className={styles.toolsHeading} data-testid={`tools-summary-${row.slug}`}>
        {t('tools.heading', { count: known.length })}
      </summary>

      <ul className={styles.toolList}>
        {ordered.map((capability) => (
          <li
            key={capability.id}
            className={styles.toolRow}
            data-testid={`tool-${capability.slug}`}
          >
            <fieldset className={styles.toolStates} disabled>
              {/*
                The capability's own name is the question these three answer,
                so it is the legend rather than a label beside them.
              */}
              <legend className={styles.toolName}>{capability.name}</legend>

              {(['allow', 'ask', 'never'] as const).map((state) => (
                <label key={state} className={styles.toolState}>
                  <input
                    type="radio"
                    name={`stance-${capability.id}`}
                    value={state}
                    defaultChecked={capability.stance === state}
                    disabled
                  />
                  <span data-testid={`tool-state-${capability.slug}-${state}`}>
                    {state === 'allow'
                      ? t('stance.allowOne')
                      : state === 'ask'
                        ? t('stance.askOne')
                        : t('stance.neverOne')}
                  </span>
                </label>
              ))}
            </fieldset>
          </li>
        ))}
      </ul>

      {/*
        What the middle state actually does. Said once for the whole list
        rather than on every row, because it is a fact about the product and
        not about any one capability.
      */}
      <p className={styles.toolsApprovals} data-testid={`tools-ask-means-${row.slug}`}>
        {t('tools.askMeansQueue')}
      </p>

      {/*
        THE REASON THE SAVE IS GONE, AND IT IS NOT THE SAME REASON TWICE.

        A disconnected system cannot take the write at all — that is the 409,
        and the repair is the one the banner above already describes, so this
        does not restate it. A CONNECTED system could take the write; there is
        simply no editor on this screen yet. Telling a merchant with a working
        shop that their connection is at fault would send them to fix
        something that is not broken.
      */}
      <p className={styles.toolsLocked} data-testid={`tools-locked-${row.slug}`}>
        {row.capabilitiesRunning
          ? t('tools.cannotHere')
          : t('tools.cannotDisconnected', { system: row.name })}
      </p>

      {/*
        The scope of what was just shown. These are workspace-wide; per-employee
        narrowing is Studio's, and this screen says so rather than letting the
        absence read as "it cannot be done".
      */}
      <p className={styles.toolsScope} data-testid={`tools-scope-${row.slug}`}>
        {t('tools.perEmployee')}
      </p>
    </details>
  );
}
