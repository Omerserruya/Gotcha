/**
 * Shopify customer-commerce context section for the conversation panel.
 *
 * Renders ONLY what the verified backend returns (services/ai/.../commerce-context).
 * The frontend never computes order state and never mutates it on click - a
 * quick action shows success only after the backend confirms + verifies. The
 * whole section is hidden when Shopify isn't connected or the customer isn't
 * securely linked (spec §1/§10).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import {
  fetchCommerceContext,
  runCommerceAction,
  commerceIdemKey,
  type CommerceContextResponse,
  type CommerceContext,
  type OrderCard,
  type Money,
  type StatusChip,
  type CommerceActionResponse,
} from "@/lib/api-commerce";

const toneClass: Record<StatusChip["tone"], string> = {
  positive: "bg-emerald-50 text-emerald-700 border-emerald-100",
  warning: "bg-amber-50 text-amber-700 border-amber-100",
  neutral: "bg-gray-100 text-gray-600 border-gray-200",
  danger: "bg-rose-50 text-rose-600 border-rose-100",
};

function money(m: Money | null | undefined): string {
  if (!m) return "";
  return `${m.currency} ${m.amount}`;
}

function Chip({ chip }: { chip: StatusChip | null }) {
  if (!chip) return null;
  return (
    <span className={clsx("inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border", toneClass[chip.tone])}>
      {chip.label}
    </span>
  );
}

interface Props {
  conversationId: string | undefined;
  token: string | null;
  /** Reports the fetched state so the parent can decide whether Shopify is the
   * connected system (and hide the generic CRM sections). `null` = not loaded. */
  onState?: (state: string | null) => void;
}

export function CommerceContextPanel({ conversationId, token, onState }: Props) {
  const { t, locale } = useI18n();
  const [resp, setResp] = useState<CommerceContextResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [busyOrder, setBusyOrder] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ order: OrderCard; action: "cancel" | "refund" } | null>(null);
  const [actionMsg, setActionMsg] = useState<{ orderId: string; text: string; tone: StatusChip["tone"] } | null>(null);

  const load = useCallback(
    async (refresh = false) => {
      if (!token || !conversationId) return;
      setLoading(true);
      try {
        const data = await fetchCommerceContext(token, conversationId, { refresh, locale });
        setResp(data);
      } catch {
        setResp({ state: "unavailable", retryable: true });
      } finally {
        setLoading(false);
      }
    },
    [token, conversationId, locale],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Report the connection state so the parent can hide the generic CRM
  // sections when Shopify is the connected system.
  useEffect(() => {
    onState?.(resp?.state ?? null);
  }, [resp?.state, onState]);

  // Replace one order card in place after a verified action (spec §6).
  function applyExecuted(order: OrderCard) {
    setResp((prev) => {
      if (!prev || prev.state !== "ok") return prev;
      const data: CommerceContext = {
        ...prev.data,
        recentOrders: prev.data.recentOrders.map((o) => (o.orderId === order.orderId ? order : o)),
      };
      return { state: "ok", data };
    });
  }

  async function doAction(order: OrderCard, action: "cancel" | "refund") {
    if (!token || !conversationId) return;
    setConfirm(null);
    setBusyOrder(order.orderId);
    setActionMsg(null);
    try {
      const res: CommerceActionResponse = await runCommerceAction(
        token,
        conversationId,
        { orderId: order.orderId, action, idempotencyKey: commerceIdemKey(conversationId, order.orderId, action) },
        locale,
      );
      if (res.state === "executed") {
        applyExecuted(res.order);
        setActionMsg({ orderId: order.orderId, text: t("commerce.actionDone") || "Done", tone: "positive" });
      } else if (res.state === "pending_approval") {
        setActionMsg({ orderId: order.orderId, text: t("commerce.pendingApproval") || "Sent for approval", tone: "warning" });
      } else if (res.state === "denied") {
        setActionMsg({ orderId: order.orderId, text: (t("commerce.denied") || "Not allowed") + `: ${res.reason}`, tone: "danger" });
      } else {
        setActionMsg({ orderId: order.orderId, text: (t("commerce.unavailable") || "Unavailable") + `: ${res.reason}`, tone: "warning" });
      }
    } catch {
      setActionMsg({ orderId: order.orderId, text: t("commerce.actionFailed") || "Action failed", tone: "danger" });
    } finally {
      setBusyOrder(null);
    }
  }

  if (!conversationId) return null;

  // Loading skeleton (spec §9).
  if (loading && !resp) {
    return (
      <section className="rounded-xl border border-gray-100 bg-white p-3">
        <div className="h-4 w-20 bg-gray-100 rounded animate-pulse mb-2" />
        <div className="h-3 w-40 bg-gray-100 rounded animate-pulse mb-3" />
        <div className="h-16 w-full bg-gray-50 rounded-lg animate-pulse" />
      </section>
    );
  }
  if (!resp) return null;

  // Only fully hide when Shopify is NOT the connected system (the parent then
  // shows the generic CRM sections). When Shopify IS connected but there's no
  // customer data yet, render a compact Shopify card so the section isn't blank.
  if (resp.state === "not_connected") {
    return null;
  }
  if (
    resp.state === "connection_unhealthy" ||
    resp.state === "customer_not_linked" ||
    resp.state === "verification_required"
  ) {
    const note =
      resp.state === "connection_unhealthy"
        ? t("commerce.connectionUnhealthy") || "Shopify connection needs attention."
        : t("commerce.customerNotLinked") || "No linked Shopify customer for this contact yet.";
    return (
      <section className="rounded-xl border border-gray-100 bg-white overflow-hidden">
        <div className="px-3 py-2.5 flex items-center gap-2 border-b border-gray-50">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-lime-500 to-emerald-600 flex items-center justify-center text-white text-[11px] font-bold">S</div>
          <p className="text-xs font-semibold text-gray-900">{t("commerce.title") || "Shopify"}</p>
        </div>
        <div className="px-3 py-3 text-[11px] text-gray-500">{note}</div>
      </section>
    );
  }

  const summary = resp.state === "ok" ? resp.data.summary : resp.state === "no_orders" ? resp.summary : null;
  const caps = resp.state === "ok" ? resp.data.capabilities : null;
  const orders = resp.state === "ok" ? resp.data.recentOrders : [];
  const shown = expanded ? orders : orders.slice(0, 3);

  return (
    <section className="rounded-xl border border-gray-100 bg-white overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2.5 flex items-center justify-between border-b border-gray-50">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-lime-500 to-emerald-600 flex items-center justify-center text-white text-[11px] font-bold">S</div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-gray-900 leading-tight">{t("commerce.title") || "Shopify"}</p>
            {summary && (
              <p className="text-[10px] text-gray-500 leading-tight">
                {(t("commerce.orders") || "Orders")} ({summary.orderCount})
              </p>
            )}
          </div>
        </div>
        <button
          onClick={() => load(true)}
          className="text-[10px] text-gray-400 hover:text-gray-600"
          aria-label={t("commerce.refresh") || "Refresh"}
        >
          ↻
        </button>
      </div>

      {/* Summary */}
      {summary && (
        <div className="px-3 py-2 text-[11px] text-gray-600 border-b border-gray-50 space-y-0.5">
          {summary.shopCurrencyTotal && (
            <div>
              <span className="text-gray-400">{t("commerce.totalSpent") || "Total spent"}:</span>{" "}
              <span className="font-semibold text-gray-800">{money(summary.shopCurrencyTotal)}</span>
              {summary.repeatCustomer && (
                <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-100">
                  {t("commerce.repeat") || "Repeat"}
                </span>
              )}
            </div>
          )}
          {summary.lastOrderAt && (
            <div>
              <span className="text-gray-400">{t("commerce.lastOrder") || "Last order"}:</span>{" "}
              {new Date(summary.lastOrderAt).toLocaleDateString(locale === "he" ? "he-IL" : "en-US", { year: "numeric", month: "short", day: "numeric" })}
            </div>
          )}
          {summary.openOrderCount > 0 && (
            <div>
              <span className="text-gray-400">{t("commerce.openOrders") || "Open orders"}:</span> {summary.openOrderCount}
            </div>
          )}
        </div>
      )}

      {/* Missing scopes banner */}
      {resp.state === "missing_scopes" && (
        <div className="px-3 py-2 text-[11px] text-amber-700 bg-amber-50 border-b border-amber-100">
          {t("commerce.missingScopes") || "Some actions need additional store permissions."}
        </div>
      )}
      {caps && caps.missingScopes.length > 0 && (
        <div className="px-3 py-1.5 text-[10px] text-amber-700 bg-amber-50 border-b border-amber-100">
          {t("commerce.missingScopes") || "Some actions need additional store permissions."}
        </div>
      )}

      {/* No orders */}
      {resp.state === "no_orders" && (
        <div className="px-3 py-3 text-[11px] text-gray-500">
          {t("commerce.noOrders") || "No Shopify orders found for this customer."}
        </div>
      )}

      {/* Unavailable */}
      {resp.state === "unavailable" && (
        <div className="px-3 py-3 text-[11px] text-gray-500 flex items-center justify-between">
          <span>{t("commerce.temporarilyUnavailable") || "Order info is temporarily unavailable."}</span>
          <button onClick={() => load(true)} className="text-indigo-600 hover:underline">
            {t("commerce.retry") || "Retry"}
          </button>
        </div>
      )}

      {/* Orders */}
      {shown.map((o) => (
        <OrderRow
          key={o.orderId}
          order={o}
          caps={caps}
          busy={busyOrder === o.orderId}
          msg={actionMsg?.orderId === o.orderId ? actionMsg : null}
          onAction={(action) => setConfirm({ order: o, action })}
          t={t}
        />
      ))}

      {orders.length > 3 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full py-2 text-[11px] text-indigo-600 hover:bg-gray-50 border-t border-gray-50"
        >
          {expanded ? t("commerce.showLess") || "Show less" : (t("commerce.showMore") || "Show all") + ` (${orders.length})`}
        </button>
      )}

      {/* Confirm dialog */}
      {confirm && (
        <ConfirmDialog
          order={confirm.order}
          action={confirm.action}
          onCancel={() => setConfirm(null)}
          onConfirm={() => doAction(confirm.order, confirm.action)}
          t={t}
        />
      )}
    </section>
  );
}

function OrderRow({
  order,
  caps,
  busy,
  msg,
  onAction,
  t,
}: {
  order: OrderCard;
  caps: CommerceContext["capabilities"] | null;
  busy: boolean;
  msg: { text: string; tone: StatusChip["tone"] } | null;
  onAction: (a: "cancel" | "refund") => void;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const item = order.items[0];
  return (
    <div className="px-3 py-2.5 border-b border-gray-50 last:border-b-0">
      <div className="flex items-start gap-2.5">
        <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center overflow-hidden flex-shrink-0">
          {item?.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="text-gray-300 text-lg">🛍️</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-gray-900 truncate">{item?.title || order.orderNumber}</span>
            <span className="text-[11px] font-semibold text-gray-700 flex-shrink-0">{money(order.total)}</span>
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5">
            {order.orderNumber}
            {order.extraItemCount > 0 && ` · +${order.extraItemCount} ${t("commerce.items") || "items"}`}
            {" · "}
            {new Date(order.createdAt).toLocaleDateString()}
          </div>
          <div className="flex flex-wrap gap-1 mt-1.5">
            {order.cancelled ? (
              <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border bg-rose-50 text-rose-600 border-rose-100">
                {t("commerce.cancelled") || "Cancelled"}
              </span>
            ) : (
              <>
                <Chip chip={order.financial} />
                <Chip chip={order.fulfillment} />
                <Chip chip={order.refund} />
                <Chip chip={order.shipping} />
              </>
            )}
          </div>

          {/* Compact timeline */}
          {order.timeline.length > 0 && (
            <div className="flex items-center gap-1 mt-1.5">
              {order.timeline.map((m) => (
                <span
                  key={m.key}
                  title={m.label}
                  className={clsx("w-1.5 h-1.5 rounded-full", m.reached ? "bg-emerald-400" : "bg-gray-200")}
                />
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 mt-2">
            <a
              href={order.adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-indigo-600 hover:underline"
            >
              {t("commerce.openInShopify") || "Open in Shopify"}
            </a>
            {caps?.canRefund && order.eligibility.refundable && (
              <button
                disabled={busy}
                onClick={() => onAction("refund")}
                className="text-[10px] text-amber-700 hover:underline disabled:opacity-40"
              >
                {t("commerce.refund") || "Refund"}
              </button>
            )}
            {caps?.canCancel && order.eligibility.cancellable && (
              <button
                disabled={busy}
                onClick={() => onAction("cancel")}
                className="text-[10px] text-rose-600 hover:underline disabled:opacity-40"
              >
                {t("commerce.cancel") || "Cancel"}
              </button>
            )}
            {busy && <span className="text-[10px] text-gray-400">…</span>}
          </div>

          {msg && (
            <div className={clsx("mt-1.5 text-[10px] px-1.5 py-1 rounded border", toneClass[msg.tone])}>{msg.text}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfirmDialog({
  order,
  action,
  onConfirm,
  onCancel,
  t,
}: {
  order: OrderCard;
  action: "cancel" | "refund";
  onConfirm: () => void;
  onCancel: () => void;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const isRefund = action === "refund";
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-xl max-w-xs w-full p-4" onClick={(e) => e.stopPropagation()}>
        <p className="text-sm font-semibold text-gray-900 mb-1">
          {isRefund ? t("commerce.confirmRefund") || "Refund this order?" : t("commerce.confirmCancel") || "Cancel this order?"}
        </p>
        <div className="text-[11px] text-gray-600 space-y-1 mb-3">
          <div>
            <span className="text-gray-400">{t("commerce.order") || "Order"}:</span> {order.orderNumber}
          </div>
          <div>
            <span className="text-gray-400">{t("commerce.total") || "Total"}:</span> {money(order.total)}
          </div>
          <div>
            <Chip chip={order.financial} /> <Chip chip={order.fulfillment} />
          </div>
          {isRefund && (
            <div className="text-amber-700">
              {t("commerce.refundableUpTo") || "Refundable up to"}: {money(order.refundableMaximum)}
            </div>
          )}
          <div className="text-gray-400 text-[10px] pt-1">
            {t("commerce.actionSubjectToApproval") || "Subject to your store's rules and may require approval."}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100">
            {t("commerce.back") || "Back"}
          </button>
          <button
            onClick={onConfirm}
            className={clsx(
              "text-xs px-3 py-1.5 rounded-lg text-white",
              isRefund ? "bg-amber-600 hover:bg-amber-700" : "bg-rose-600 hover:bg-rose-700",
            )}
          >
            {isRefund ? t("commerce.refund") || "Refund" : t("commerce.cancel") || "Cancel order"}
          </button>
        </div>
      </div>
    </div>
  );
}
