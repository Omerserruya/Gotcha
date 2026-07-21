/**
 * Shopify customer-commerce context section for the conversation Context Panel.
 *
 * ONE order at a time: the header shows the total order count + total spend and
 * previous/next arrows; a single self-contained card shows the selected order's
 * product, statuses, quick actions and verified lifecycle timeline. The frontend
 * never computes or mutates order state - a quick action shows success only
 * after the backend confirms + verifies, and the selected card refreshes in
 * place. Hidden entirely when Shopify isn't the connected system.
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

const NAV_LIMIT = 25; // how many recent orders to load for navigation

const toneText: Record<StatusChip["tone"], string> = {
  positive: "text-emerald-600",
  warning: "text-amber-600",
  neutral: "text-gray-500",
  danger: "text-rose-600",
};

function money(m: Money | null | undefined): string {
  if (!m) return "";
  return `${m.currency} ${m.amount}`;
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
  const dateLocale = locale === "he" ? "he-IL" : "en-US";
  const [resp, setResp] = useState<CommerceContextResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ order: OrderCard; action: "cancel" | "refund" } | null>(null);
  const [actionMsg, setActionMsg] = useState<{ orderId: string; text: string; tone: StatusChip["tone"] } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      if (!token || !conversationId) return;
      setLoading(true);
      try {
        const data = await fetchCommerceContext(token, conversationId, { refresh, locale, limit: NAV_LIMIT });
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

  // Preserve the selected order while the conversation stays open; reset only
  // when the conversation itself changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [conversationId]);

  useEffect(() => {
    onState?.(resp?.state ?? null);
  }, [resp?.state, onState]);

  // Replace the selected order in place after a verified action (spec §6).
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
    setBusy(true);
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
      setBusy(false);
    }
  }

  if (!conversationId) return null;

  if (loading && !resp) {
    return (
      <section className="rounded-xl border border-gray-100 bg-white p-3">
        <div className="h-4 w-24 bg-gray-100 rounded animate-pulse mb-2" />
        <div className="h-3 w-32 bg-gray-100 rounded animate-pulse mb-3" />
        <div className="h-24 w-full bg-gray-50 rounded-lg animate-pulse" />
      </section>
    );
  }
  if (!resp) return null;

  // Not the connected system → hide (parent shows the CRM sections).
  if (resp.state === "not_connected") return null;

  // Shopify connected but no data yet → compact card so the section isn't blank.
  if (resp.state === "connection_unhealthy" || resp.state === "customer_not_linked" || resp.state === "verification_required") {
    const note =
      resp.state === "connection_unhealthy"
        ? t("commerce.connectionUnhealthy") || "Shopify connection needs attention."
        : t("commerce.customerNotLinked") || "No linked Shopify customer for this contact yet.";
    return (
      <section className="rounded-xl border border-gray-100 bg-white overflow-hidden">
        <ShopifyHeaderBar t={t} />
        <div className="px-3 py-3 text-[11px] text-gray-500">{note}</div>
      </section>
    );
  }

  const summary = resp.state === "ok" ? resp.data.summary : resp.state === "no_orders" ? resp.summary : null;
  const caps = resp.state === "ok" ? resp.data.capabilities : null;
  const orders = resp.state === "ok" ? resp.data.recentOrders : [];
  const total = orders.length;
  const idx = total > 0 ? Math.min(selectedIndex, total - 1) : 0;
  const order = orders[idx];

  const totalSpent =
    summary?.shopCurrencyTotal
      ? money(summary.shopCurrencyTotal)
      : summary?.totalSpentByCurrency?.length
      ? summary.totalSpentByCurrency.map(money).join(" · ")
      : "";

  return (
    <section className="rounded-xl border border-gray-100 bg-white overflow-hidden">
      {/* Header: total orders + total spend (stay visible while navigating) + arrows */}
      <div className="px-3 py-2.5 border-b border-gray-50">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-lime-500 to-emerald-600 flex items-center justify-center text-white text-[11px] font-bold shrink-0">S</div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-gray-900 leading-tight">
                {(t("commerce.orders") || "Orders")}{summary ? ` (${summary.orderCount})` : ""}
              </p>
              {totalSpent && (
                <p className="text-[10px] text-gray-500 leading-tight truncate">
                  {(t("commerce.totalSpent") || "Total spent")}: <span className="font-semibold text-gray-700">{totalSpent}</span>
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {total > 1 && (
              <div dir="ltr" className="flex items-center gap-0.5">
                <NavArrow dir="prev" disabled={idx === 0} onClick={() => { setSelectedIndex(idx - 1); setMenuOpen(false); }} label={t("commerce.prevOrder") || "Previous order"} />
                <span className="text-[10px] text-gray-400 tabular-nums px-0.5">{idx + 1}/{total}</span>
                <NavArrow dir="next" disabled={idx === total - 1} onClick={() => { setSelectedIndex(idx + 1); setMenuOpen(false); }} label={t("commerce.nextOrder") || "Next order"} />
              </div>
            )}
            <button onClick={() => load(true)} className="text-[11px] text-gray-400 hover:text-gray-600 px-1" aria-label={t("commerce.refresh") || "Refresh"}>↻</button>
          </div>
        </div>
      </div>

      {/* Missing scopes hint */}
      {(resp.state === "missing_scopes" || (caps && caps.missingScopes.length > 0)) && (
        <div className="px-3 py-1.5 text-[10px] text-amber-700 bg-amber-50 border-b border-amber-100">
          {t("commerce.missingScopes") || "Some actions need additional store permissions."}
        </div>
      )}

      {/* No orders */}
      {resp.state === "no_orders" && (
        <div className="px-3 py-3 text-[11px] text-gray-500">{t("commerce.noOrders") || "No Shopify orders found for this customer."}</div>
      )}

      {/* Unavailable */}
      {resp.state === "unavailable" && (
        <div className="px-3 py-3 text-[11px] text-gray-500 flex items-center justify-between">
          <span>{t("commerce.temporarilyUnavailable") || "Order info is temporarily unavailable."}</span>
          <button onClick={() => load(true)} className="text-indigo-600 hover:underline">{t("commerce.retry") || "Retry"}</button>
        </div>
      )}

      {/* The single selected order card */}
      {order && (
        <SingleOrderCard
          order={order}
          caps={caps}
          busy={busy}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          msg={actionMsg?.orderId === order.orderId ? actionMsg : null}
          onAction={(action) => setConfirm({ order, action })}
          onRefresh={() => load(true)}
          dateLocale={dateLocale}
          t={t}
        />
      )}

      {confirm && (
        <ConfirmDialog order={confirm.order} action={confirm.action} onCancel={() => setConfirm(null)} onConfirm={() => doAction(confirm.order, confirm.action)} t={t} />
      )}
    </section>
  );
}

function ShopifyHeaderBar({ t }: { t: (k: string) => string }) {
  return (
    <div className="px-3 py-2.5 flex items-center gap-2 border-b border-gray-50">
      <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-lime-500 to-emerald-600 flex items-center justify-center text-white text-[11px] font-bold">S</div>
      <p className="text-xs font-semibold text-gray-900">{t("commerce.title") || "Shopify"}</p>
    </div>
  );
}

function NavArrow({ dir, disabled, onClick, label }: { dir: "prev" | "next"; disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={clsx("w-5 h-5 rounded-md flex items-center justify-center text-gray-500 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent")}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d={dir === "prev" ? "M15.75 19.5L8.25 12l7.5-7.5" : "M8.25 4.5l7.5 7.5-7.5 7.5"} />
      </svg>
    </button>
  );
}

/** Concise status line: payment · fulfillment (+ refund / cancelled when relevant). */
function StatusLine({ order, t }: { order: OrderCard; t: (k: string) => string }) {
  const parts: StatusChip[] = [];
  if (order.cancelled) {
    parts.push({ key: "cancelled", label: t("commerce.cancelled") || "Cancelled", tone: "danger" });
    if (order.refund) parts.push(order.refund); // e.g. "Refunded" alongside "Cancelled"
  } else {
    if (order.financial) parts.push(order.financial);
    if (order.fulfillment) parts.push(order.fulfillment);
    if (order.refund) parts.push(order.refund);
    if (order.shipping && order.shipping.key === "delivered") parts.push(order.shipping);
  }
  if (!parts.length) return null;
  return (
    <div className="text-[11px] font-medium mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-0.5">
      {parts.map((p, i) => (
        <span key={p.key} className="inline-flex items-center">
          {i > 0 && <span className="text-gray-300 mx-1">·</span>}
          <span className={toneText[p.tone]}>{p.label}</span>
        </span>
      ))}
    </div>
  );
}

function SingleOrderCard({
  order, caps, busy, menuOpen, setMenuOpen, msg, onAction, onRefresh, dateLocale, t,
}: {
  order: OrderCard;
  caps: CommerceContext["capabilities"] | null;
  busy: boolean;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  msg: { text: string; tone: StatusChip["tone"] } | null;
  onAction: (a: "cancel" | "refund") => void;
  onRefresh: () => void;
  dateLocale: string;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const item = order.items[0];
  const reached = order.timeline.filter((m) => m.reached);
  return (
    <div className="p-3">
      <div className="rounded-xl border border-gray-100 bg-gray-50/40 overflow-hidden">
        {/* Card header: store indicator + order number + external link */}
        <div className="px-3 py-2 flex items-center justify-between border-b border-gray-100/70">
          <span className="text-[10px] font-semibold text-emerald-700">{t("commerce.title") || "Shopify"}</span>
          <a href={order.adminUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] font-semibold text-gray-700 hover:text-indigo-600 inline-flex items-center gap-1" dir="ltr">
            {order.orderNumber}
            <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </a>
        </div>

        {/* Product + total */}
        <div className="px-3 py-2.5 flex items-start gap-2.5">
          <div className="w-11 h-11 rounded-lg bg-white border border-gray-100 flex items-center justify-center overflow-hidden shrink-0">
            {item?.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-gray-300 text-xl">🛍️</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs font-semibold text-gray-900 leading-snug line-clamp-2" dir="ltr" style={{ textAlign: "start" }}>
                {item?.title || order.orderNumber}
                {order.extraItemCount > 0 && (
                  <span className="text-gray-400 font-normal"> +{order.extraItemCount} {t("commerce.items") || "items"}</span>
                )}
              </span>
              <span className="text-xs font-bold text-gray-900 shrink-0" dir="ltr">{money(order.total)}</span>
            </div>
            <div className="text-[10px] text-gray-400 mt-1" dir="ltr" style={{ textAlign: "start" }}>
              {new Date(order.createdAt).toLocaleDateString(dateLocale, { day: "2-digit", month: "2-digit", year: "numeric" })}
            </div>
            <StatusLine order={order} t={t} />
          </div>
        </div>

        {/* Quick actions (wrap cleanly) */}
        <div className="px-3 pb-2.5 flex flex-wrap items-center gap-1.5">
          {caps?.canOpen !== false && (
            <a href={order.adminUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] font-medium px-2 py-1 rounded-md bg-white border border-gray-200 text-gray-700 hover:border-indigo-300 hover:text-indigo-600">
              {t("commerce.openInShopify") || "Open in Shopify"}
            </a>
          )}
          {caps?.canRefund && order.eligibility.refundable && (
            <button disabled={busy} onClick={() => onAction("refund")} className="text-[10px] font-medium px-2 py-1 rounded-md bg-white border border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-40">
              {t("commerce.refund") || "Refund"}
            </button>
          )}
          {caps?.canCancel && order.eligibility.cancellable && (
            <button disabled={busy} onClick={() => onAction("cancel")} className="text-[10px] font-medium px-2 py-1 rounded-md bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40">
              {t("commerce.cancel") || "Cancel"}
            </button>
          )}
          <div className="relative">
            <button onClick={() => setMenuOpen(!menuOpen)} aria-label={t("commerce.more") || "More"} className="text-[11px] px-2 py-1 rounded-md bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 leading-none">⋯</button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-[55]" onClick={() => setMenuOpen(false)} />
                <div className="absolute end-0 mt-1 z-[56] w-40 rounded-lg border border-gray-100 bg-white shadow-lg py-1 text-[11px]">
                  <a href={order.adminUrl} target="_blank" rel="noopener noreferrer" className="block px-3 py-1.5 text-gray-700 hover:bg-gray-50" onClick={() => setMenuOpen(false)}>
                    {t("commerce.openInShopify") || "Open in Shopify"}
                  </a>
                  <button className="block w-full text-start px-3 py-1.5 text-gray-700 hover:bg-gray-50" onClick={() => { setMenuOpen(false); onRefresh(); }}>
                    {t("commerce.refreshOrder") || "Refresh this order"}
                  </button>
                  <button
                    className="block w-full text-start px-3 py-1.5 text-gray-700 hover:bg-gray-50"
                    onClick={() => { setMenuOpen(false); try { navigator.clipboard?.writeText(order.orderNumber); } catch { /* clipboard may be unavailable */ } }}
                  >
                    {t("commerce.copyOrderNumber") || "Copy order number"}
                  </button>
                </div>
              </>
            )}
          </div>
          {busy && <span className="text-[10px] text-gray-400">…</span>}
        </div>

        {msg && (
          <div className="px-3 pb-2.5">
            <div className={clsx("text-[10px] px-2 py-1 rounded", msg.tone === "positive" ? "bg-emerald-50 text-emerald-700" : msg.tone === "danger" ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-700")}>{msg.text}</div>
          </div>
        )}

        {/* Order lifecycle timeline (verified Shopify data - not Shopify's native Timeline) */}
        {reached.length > 0 && (
          <div className="px-3 py-2.5 border-t border-gray-100/70 bg-white/60">
            <ul className="space-y-1.5">
              {reached.map((m, i) => (
                <li key={m.key} className="flex items-center gap-2">
                  <span className={clsx("w-2 h-2 rounded-full shrink-0", i === reached.length - 1 ? "bg-emerald-500" : "bg-emerald-300")} />
                  <span className="text-[11px] text-gray-700">
                    {m.label}
                    {m.at && (i === 0 || m.key === "cancelled" || m.key === "refunded") && (
                      <span className="text-gray-400"> · {new Date(m.at).toLocaleDateString(dateLocale, { day: "numeric", month: "short", year: "numeric" })}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function ConfirmDialog({
  order, action, onConfirm, onCancel, t,
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
          <div><span className="text-gray-400">{t("commerce.order") || "Order"}:</span> <span dir="ltr">{order.orderNumber}</span></div>
          <div><span className="text-gray-400">{t("commerce.total") || "Total"}:</span> <span dir="ltr">{money(order.total)}</span></div>
          <div className="text-[11px]"><StatusLine order={order} t={t} /></div>
          {isRefund && (
            <div className="text-amber-700">{t("commerce.refundableUpTo") || "Refundable up to"}: <span dir="ltr">{money(order.refundableMaximum)}</span></div>
          )}
          <div className="text-gray-400 text-[10px] pt-1">{t("commerce.actionSubjectToApproval") || "Subject to your store's rules and may require approval."}</div>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100">{t("commerce.back") || "Back"}</button>
          <button onClick={onConfirm} className={clsx("text-xs px-3 py-1.5 rounded-lg text-white", isRefund ? "bg-amber-600 hover:bg-amber-700" : "bg-rose-600 hover:bg-rose-700")}>
            {isRefund ? t("commerce.refund") || "Refund" : t("commerce.cancel") || "Cancel order"}
          </button>
        </div>
      </div>
    </div>
  );
}
