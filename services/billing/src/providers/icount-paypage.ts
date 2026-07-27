/**
 * Validation of the iCount PayPage configuration.
 *
 * GOTCHA needs a page that stores a card and nothing else. Two ways that can be
 * wrong, both of which have to fail loudly rather than be discovered in
 * production:
 *
 *   - the page is a normal checkout page (`invrec`), so sending a customer to
 *     it charges them instead of storing their card;
 *   - the page is a standing order (`hk_page`), which would make iCount the
 *     renewal owner alongside GOTCHA, and two systems each billing monthly is
 *     the exact failure this architecture exists to prevent.
 */

/** The page type that stores a reusable card token. */
export const TOKENIZATION_DOCTYPE = "cc_token";

export interface PayPageConfig {
  doctype?: string | null;
  hk_page?: number | string | null;
  is_active?: number | string | boolean | null;
  is_deleted?: number | string | boolean | null;
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

export class PayPageMisconfiguredError extends Error {
  constructor(message: string) {
    super(`[icount] payment page unusable: ${message}`);
    this.name = "PayPageMisconfiguredError";
  }
}

/**
 * Throw unless this page is a usable tokenization page.
 *
 * Order matters: report what the page IS before reporting that it is inactive,
 * because a wrong type is a configuration mistake and inactivity is usually a
 * toggle.
 */
export function assertTokenizationPage(page: PayPageConfig): void {
  const doctype = String(page.doctype ?? "").trim();

  if (doctype !== TOKENIZATION_DOCTYPE) {
    throw new PayPageMisconfiguredError(
      doctype === "invrec"
        ? `doctype "invrec" is an immediate-charge checkout page; tokenization needs "${TOKENIZATION_DOCTYPE}"`
        : `doctype "${doctype || "(none)"}" is not "${TOKENIZATION_DOCTYPE}"`,
    );
  }

  if (truthy(page.hk_page)) {
    throw new PayPageMisconfiguredError(
      "hk_page is set: this is an iCount standing order, which would make iCount a second renewal owner",
    );
  }

  if (truthy(page.is_deleted)) throw new PayPageMisconfiguredError("the page is deleted");
  if (!truthy(page.is_active)) throw new PayPageMisconfiguredError("the page is not active");
}

/** Non-throwing variant, for reporting rather than gating. */
export function tokenizationPageProblem(page: PayPageConfig): string | null {
  try {
    assertTokenizationPage(page);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
