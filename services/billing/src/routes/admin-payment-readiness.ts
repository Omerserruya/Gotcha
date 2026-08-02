/**
 * System Admin: can this deployment take a payment, and if not, why not.
 *
 * Platform tier only. The body names capabilities, environment variables and a
 * provider, which is exactly the detail a customer must never receive and
 * exactly the detail an operator needs. No secret value appears in any
 * response - only whether one is configured.
 */
import { Router } from "express";
import {
  authenticate,
  requirePlatformPermission,
  PLATFORM_PERMISSIONS,
} from "@chatcenter/shared";
import { paymentReadiness } from "../services/payment-readiness.service";
import { icountMode, icountPaymentPageId } from "../providers/icount-config";
import { authInfo, paypageInfo } from "../providers/icount-client";
import { appPublicUrl } from "../lib/public-url";

const router = Router();
const P = PLATFORM_PERMISSIONS;

/**
 * The IPN url the cc_token PayPage must be configured with.
 *
 * Derived from the deployment's own public origin so it cannot drift from where
 * the notification would actually arrive. The verified configuration mode is
 * STATIC_ON_CC_TOKEN_PAGE: one url set once in the iCount UI, not a per-
 * transaction value, because iCount has no verified per-sale IPN parameter.
 */
export function expectedIpnUrl(): string | null {
  try {
    return `${appPublicUrl()}/api/billing/providers/icount/ipn`;
  } catch {
    return null;
  }
}

router.get(
  "/admin/billing/payment-readiness",
  authenticate,
  requirePlatformPermission(P.PRICING_READ),
  async (_req, res) => {
    const readiness = await paymentReadiness();

    // Provider-side facts are gathered separately and never allowed to fail the
    // whole response: this panel's main job is diagnosing a provider that is
    // unreachable, so it has to survive one being unreachable.
    let account: { ok: boolean; accountId?: string; companyName?: string; error?: string } | null = null;
    let paypage: {
      ok: boolean;
      pageId?: string;
      doctype?: string;
      ipnUrl?: string | null;
      ipnConfigured?: boolean;
      error?: string;
    } | null = null;

    if (icountMode() === "test" || icountMode() === "live") {
      try {
        const identity = await authInfo();
        account = { ok: true, accountId: identity.accountId, companyName: identity.companyName };
      } catch (err) {
        account = { ok: false, error: (err as Error).message };
      }

      const pageId = icountPaymentPageId();
      if (pageId) {
        try {
          const info = (await paypageInfo(pageId)) as Record<string, unknown>;
          const ipn = info.ipn_url == null ? null : String(info.ipn_url).trim() || null;
          paypage = {
            ok: true,
            pageId,
            doctype: info.doctype == null ? undefined : String(info.doctype),
            ipnUrl: ipn,
            ipnConfigured: Boolean(ipn),
          };
        } catch (err) {
          paypage = { ok: false, pageId, error: (err as Error).message };
        }
      }
    }

    res.json({
      data: {
        ...readiness,
        account,
        paypage,
        // What an operator would have to do BY HAND. iCount has no verified API
        // for writing a PayPage's IPN url, and this deliberately does not
        // attempt one: silently mutating a payment page's configuration is not
        // something a status endpoint should ever do.
        manualAction:
          paypage && paypage.ok && !paypage.ipnConfigured
            ? {
                where: "iCount UI - the cc_token PayPage settings",
                set: "ipn_url",
                to: expectedIpnUrl(),
                why: "Without it the provider never notifies this deployment, so a completed payment is only noticed when the customer's browser returns - and a browser returning is not proof of payment.",
              }
            : null,
      },
    });
  },
);

export default router;
