"use client";

import { useState } from "react";
import { useI18n } from "@/context/I18nContext";
import { useAuth } from "@/context/AuthContext";
import { requestShopifyUninstall } from "@/lib/api";
import { notifyIntegrationsChanged } from "@/lib/integration-events";
import ConfirmModal from "@/components/ConfirmModal";

/**
 * "Disconnect Shopify", with the consequences stated before anything happens.
 *
 * WHY A DIALOG AND NOT JUST A BUTTON
 * This asks Shopify to uninstall the app, which is irreversible from our side
 * and takes the storefront assistant down with it. A merchant is entitled to
 * know that before it happens, and equally entitled to know what does NOT
 * break: Core, WhatsApp, the Inbox and every non-Shopify integration keep
 * working. Most of the fear in a destructive confirmation comes from not being
 * told the second half.
 *
 * WHAT HAPPENS ON CONFIRM
 * The server asks Shopify to uninstall and returns `awaiting_webhook`. That is
 * NOT a disconnect: Shopify's signed `app/uninstalled` webhook completes it.
 * So this reports "waiting" and never "disconnected", and the caller keeps the
 * connection live until the webhook lands.
 */
export default function ShopifyDisconnectDialog({
  open,
  shopDomain,
  onCancel,
  onRequested,
}: {
  open: boolean;
  shopDomain: string;
  onCancel: () => void;
  /** Called once Shopify has ACCEPTED the request, not once it is done. */
  onRequested: () => void;
}) {
  const { t } = useI18n();
  const { token } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestShopifyUninstall(token);
      notifyIntegrationsChanged();
      onRequested();
    } catch {
      // The connection is untouched on failure, so the honest thing is to say
      // so and leave the merchant able to try again rather than stranding them
      // on a "waiting" state with nothing coming.
      setError(t("marketplace.shopifyDisconnect.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <ConfirmModal
        isOpen={open}
        danger
        loading={busy}
        title={t("marketplace.shopifyDisconnect.title")}
        message={t("marketplace.shopifyDisconnect.body").replace("{shop}", shopDomain || "")}
        confirmText={t("marketplace.shopifyDisconnect.confirm")}
        cancelText={t("marketplace.shopifyDisconnect.cancel")}
        onConfirm={confirm}
        // Cancelling mid-request would leave the merchant unsure whether the
        // uninstall was sent. The modal owns the spinner; this owns the guard.
        onCancel={busy ? () => {} : onCancel}
      />
      {error && (
        <div
          role="alert"
          data-testid="shopify-disconnect-error"
          className="fixed bottom-4 inset-x-4 z-[60] mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"
        >
          {error}
        </div>
      )}
    </>
  );
}
