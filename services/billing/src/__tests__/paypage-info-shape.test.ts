/**
 * The shape iCount actually returns from paypage/info.
 *
 * Every value below is neutral; only the STRUCTURE is real, read from a live
 * read-only call against the configured account. That structure is the point:
 * the configuration is nested under `paypage_info`, and the unwrapping code
 * looked for `paypage` and `page`, neither of which exists.
 *
 * The consequence was not a degraded message. It returned the envelope, whose
 * `doctype` is absent, so the tokenization guard refused a correctly configured
 * page and said its doctype was "(none)" - sending whoever read that to check
 * the one thing that was already right.
 */
import { describe, it, expect } from "vitest";
import { assertTokenizationPage, tokenizationPageProblem } from "../providers/icount-paypage";

/** The live envelope, values replaced. */
const ENVELOPE = {
  api: { version: 3, module: "paypage", method: "info" },
  status: true,
  reason: "OK",
  paypage_id: "0",
  paypage_info: {
    page_id: "0",
    doctype: "cc_token",
    hk_page: "0",
    is_active: "1",
    is_deleted: "0",
    deleted: "0",
    ipn_url: "",
    post_action_success: "",
  },
};

/** What icount-client does with the response. */
function unwrap(data: any): Record<string, unknown> {
  const info = data?.paypage_info ?? data?.paypage ?? data?.page;
  if (!info || typeof info !== "object") throw new Error("no page configuration");
  return info;
}

describe("the page configuration is found where iCount puts it", () => {
  it("unwraps paypage_info", () => {
    expect(unwrap(ENVELOPE).doctype).toBe("cc_token");
  });

  it("accepts the real page as a tokenization page", () => {
    // The page in the account is doctype cc_token, active, not deleted and not
    // a standing order. Nothing about it should have been refused.
    expect(() => assertTokenizationPage(unwrap(ENVELOPE) as any)).not.toThrow();
    expect(tokenizationPageProblem(unwrap(ENVELOPE) as any)).toBeNull();
  });

  it("shows what the old unwrapping did", () => {
    // The regression, stated as behaviour rather than described in a comment.
    const oldUnwrap = (d: any) => d?.paypage ?? d?.page ?? d ?? {};
    expect(() => assertTokenizationPage(oldUnwrap(ENVELOPE))).toThrow(/not "cc_token"/);
  });

  it("refuses rather than guessing when the envelope has no page at all", () => {
    // Returning the envelope on a miss is how the failure above stayed quiet.
    expect(() => unwrap({ api: {}, status: true })).toThrow();
  });
});
