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
  type CommerceActionInput,
  type CommerceSummary,
  type OrderDetail,
} from "@/lib/api-commerce";

const NAV_LIMIT = 25; // how many recent orders to load for navigation
/** Message scope for customer-level actions, which have no order id. */
const CUSTOMER_SCOPE = "__customer__";

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
  // Customer tags, seeded from the context and replaced by the VERIFIED list the
  // server returns after a change - never patched locally.
  const [tags, setTags] = useState<string[] | null>(null);
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
    setTags(null);
  }, [conversationId]);

  useEffect(() => {
    onState?.(resp?.state ?? null);
  }, [resp?.state, onState]);

  // Seed the tag list from the loaded context. `undefined` from the server means
  // "could not read them", which stays null here - the UI says "not loaded"
  // rather than the much more confident, and possibly wrong, "no tags".
  useEffect(() => {
    if (resp?.state === "ok") setTags(resp.data.customer.tags ?? null);
  }, [resp]);

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

  /**
   * One dispatch for every action, order-scoped or customer-scoped.
   *
   * Nothing here is optimistic. The row/tag list updates only from the verified
   * result the backend returns, and every non-executed outcome is reported with
   * the server's own reason rather than collapsed into "failed" - "you may not
   * refund" and "Shopify is unreachable" are different facts for the agent.
   */
  async function doAction(
    input: CommerceActionInput,
    msgScope: string,
  ) {
    if (!token || !conversationId) return;
    setConfirm(null);
    setBusy(true);
    setActionMsg(null);
    try {
      const res: CommerceActionResponse = await runCommerceAction(token, conversationId, input, locale);
      if (res.state === "executed") {
        applyExecuted(res.order);
        setActionMsg({ orderId: msgScope, text: t("commerce.actionDone") || "Done", tone: "positive" });
      } else if (res.state === "executed_customer") {
        if (res.tags) setTags(res.tags);
        setActionMsg({
          orderId: msgScope,
          text: res.noteAdded
            ? t("commerce.noteAdded") || "Note added"
            : t("commerce.actionDone") || "Done",
          tone: "positive",
        });
      } else if (res.state === "pending_approval") {
        setActionMsg({ orderId: msgScope, text: t("commerce.pendingApproval") || "Sent for approval", tone: "warning" });
      } else if (res.state === "denied") {
        setActionMsg({ orderId: msgScope, text: (t("commerce.denied") || "Not allowed") + `: ${res.reason}`, tone: "danger" });
      } else {
        setActionMsg({ orderId: msgScope, text: (t("commerce.unavailable") || "Unavailable") + `: ${res.reason}`, tone: "warning" });
      }
    } catch {
      setActionMsg({ orderId: msgScope, text: t("commerce.actionFailed") || "Action failed", tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  function runOrderAction(order: OrderCard, action: "cancel" | "refund", params: CommerceActionInput["params"]) {
    void doAction(
      {
        orderId: order.orderId,
        action,
        idempotencyKey: commerceIdemKey(conversationId!, order.orderId, action),
        params,
      },
      order.orderId,
    );
  }

  function runCustomerAction(action: "add_tag" | "remove_tag" | "add_note", params: CommerceActionInput["params"]) {
    void doAction(
      {
        action,
        idempotencyKey: commerceIdemKey(conversationId!, params?.tag || "note", action),
        params,
      },
      CUSTOMER_SCOPE,
    );
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

      {/* Customer summary (spec §14). Only fields the provider actually
          returned - an absent one says so rather than showing a blank. */}
      {summary && <CustomerSummaryCard summary={summary} dateLocale={dateLocale} t={t} />}

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

      {/* Customer-record actions: tags + internal note. Separate block because
          they act on the CUSTOMER, not the selected order. */}
      {(caps?.canTag || caps?.canNote) && resp.state === "ok" && (
        <CustomerActions
          caps={caps}
          tags={tags}
          busy={busy}
          msg={actionMsg?.orderId === CUSTOMER_SCOPE ? actionMsg : null}
          onAddTag={(tag) => runCustomerAction("add_tag", { tag })}
          onRemoveTag={(tag) => runCustomerAction("remove_tag", { tag })}
          onAddNote={(note) => runCustomerAction("add_note", { note })}
          t={t}
        />
      )}

      {confirm?.action === "refund" && (
        <RefundDialog
          order={confirm.order}
          onCancel={() => setConfirm(null)}
          onConfirm={(params) => runOrderAction(confirm.order, "refund", params)}
          t={t}
        />
      )}
      {confirm?.action === "cancel" && (
        <CancelDialog
          order={confirm.order}
          onCancel={() => setConfirm(null)}
          onConfirm={(params) => runOrderAction(confirm.order, "cancel", params)}
          t={t}
        />
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

        {order.detail && <OrderDetailSection detail={order.detail} dateLocale={dateLocale} t={t} />}

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

/** Parse a decimal string like "129.90" into a number, or null. */
function toAmount(v: string): number | null {
  const n = Number(v.replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Refund modal - full OR partial.
 *
 * The refundable maximum is the server's authoritative ceiling, so the field is
 * validated against it here purely to give the agent an answer before a round
 * trip; the backend refuses an over-max amount regardless. Restock and notify
 * are explicit choices, never silent defaults, because both have consequences
 * outside this screen (inventory, and an email to the customer).
 */
function RefundDialog({
  order, onConfirm, onCancel, t,
}: {
  order: OrderCard;
  onConfirm: (params: CommerceActionInput["params"]) => void;
  onCancel: () => void;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const max = toAmount(order.refundableMaximum?.amount ?? "") ?? 0;
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [amount, setAmount] = useState("");
  const [restock, setRestock] = useState(false);
  const [refundShipping, setRefundShipping] = useState(false);
  const [notify, setNotify] = useState(true);
  const [reason, setReason] = useState("");

  const parsed = toAmount(amount);
  const overMax = mode === "partial" && parsed !== null && parsed > max + 0.005;
  const invalid = mode === "partial" && (parsed === null || overMax);

  return (
    <Modal onCancel={onCancel} titleId="refund-title">
      <p id="refund-title" className="text-sm font-semibold text-gray-900 mb-1">
        {t("commerce.confirmRefund") || "Refund this order?"}
      </p>
      <div className="text-[11px] text-gray-600 space-y-1 mb-3">
        <div><span className="text-gray-400">{t("commerce.order") || "Order"}:</span> <span dir="ltr">{order.orderNumber}</span></div>
        <div><span className="text-gray-400">{t("commerce.total") || "Total"}:</span> <span dir="ltr">{money(order.total)}</span></div>
        <div className="text-amber-700">
          {t("commerce.refundableUpTo") || "Refundable up to"}: <span dir="ltr">{money(order.refundableMaximum)}</span>
        </div>
      </div>

      <div className="flex gap-1 mb-2 bg-gray-100 rounded-lg p-0.5" role="radiogroup" aria-label={t("commerce.refundAmount") || "Refund amount"}>
        {(["full", "partial"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            data-testid={`refund-mode-${m}`}
            onClick={() => setMode(m)}
            className={clsx(
              "flex-1 text-[11px] font-medium py-1 rounded-md transition",
              mode === m ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
            )}
          >
            {m === "full" ? t("commerce.refundFull") || "Full" : t("commerce.refundPartial") || "Partial"}
          </button>
        ))}
      </div>

      {mode === "partial" && (
        <div className="mb-2">
          <label className="block text-[10px] text-gray-500 mb-1" htmlFor="refund-amount">
            {t("commerce.refundAmount") || "Refund amount"} ({order.refundableMaximum?.currency})
          </label>
          <input
            id="refund-amount"
            data-testid="refund-amount"
            inputMode="decimal"
            dir="ltr"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={order.refundableMaximum?.amount ?? "0.00"}
            aria-invalid={invalid || undefined}
            className={clsx(
              "w-full px-2 py-1.5 rounded-lg border text-xs outline-none",
              overMax ? "border-rose-300 bg-rose-50" : "border-gray-200 focus:border-indigo-300",
            )}
          />
          {overMax && (
            <p className="text-[10px] text-rose-600 mt-1" data-testid="refund-over-max">
              {t("commerce.refundOverMax") || "More than this order can be refunded."}
            </p>
          )}
        </div>
      )}

      <div className="space-y-1.5 mb-3">
        <Check id="refund-restock" checked={restock} onChange={setRestock} label={t("commerce.restock") || "Return items to inventory"} />
        <Check id="refund-shipping" checked={refundShipping} onChange={setRefundShipping} label={t("commerce.refundShipping") || "Also refund shipping"} />
        <Check id="refund-notify" checked={notify} onChange={setNotify} label={t("commerce.notifyCustomer") || "Email the customer"} />
      </div>

      <input
        data-testid="refund-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("commerce.reasonOptional") || "Reason (optional)"}
        className="w-full px-2 py-1.5 rounded-lg border border-gray-200 text-xs outline-none focus:border-indigo-300 mb-3"
      />

      <p className="text-gray-400 text-[10px] mb-3">{t("commerce.actionSubjectToApproval") || "Subject to your store's rules and may require approval."}</p>

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100">{t("commerce.back") || "Back"}</button>
        <button
          data-testid="refund-submit"
          disabled={invalid}
          onClick={() =>
            onConfirm({
              ...(mode === "partial" && parsed !== null ? { amount: parsed } : {}),
              restock,
              refundShipping,
              notify,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            })
          }
          className="text-xs px-3 py-1.5 rounded-lg text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-40"
        >
          {t("commerce.refund") || "Refund"}
        </button>
      </div>
    </Modal>
  );
}

/** Cancel modal. Cancelling never silently refunds - that is its own action. */
function CancelDialog({
  order, onConfirm, onCancel, t,
}: {
  order: OrderCard;
  onConfirm: (params: CommerceActionInput["params"]) => void;
  onCancel: () => void;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const [restock, setRestock] = useState(true);
  const [reason, setReason] = useState("");
  return (
    <Modal onCancel={onCancel} titleId="cancel-title">
      <p id="cancel-title" className="text-sm font-semibold text-gray-900 mb-1">
        {t("commerce.confirmCancel") || "Cancel this order?"}
      </p>
      <div className="text-[11px] text-gray-600 space-y-1 mb-3">
        <div><span className="text-gray-400">{t("commerce.order") || "Order"}:</span> <span dir="ltr">{order.orderNumber}</span></div>
        <div><span className="text-gray-400">{t("commerce.total") || "Total"}:</span> <span dir="ltr">{money(order.total)}</span></div>
        <StatusLine order={order} t={t} />
      </div>

      <div className="space-y-1.5 mb-2">
        <Check id="cancel-restock" checked={restock} onChange={setRestock} label={t("commerce.restock") || "Return items to inventory"} />
      </div>
      {/* Said out loud, because the opposite is what people assume. */}
      <p className="text-[10px] text-gray-500 mb-3">{t("commerce.cancelDoesNotRefund") || "Cancelling does not refund. Refund is a separate action."}</p>

      <input
        data-testid="cancel-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("commerce.reasonOptional") || "Reason (optional)"}
        className="w-full px-2 py-1.5 rounded-lg border border-gray-200 text-xs outline-none focus:border-indigo-300 mb-3"
      />

      <p className="text-gray-400 text-[10px] mb-3">{t("commerce.actionSubjectToApproval") || "Subject to your store's rules and may require approval."}</p>

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-lg text-gray-600 hover:bg-gray-100">{t("commerce.back") || "Back"}</button>
        <button
          data-testid="cancel-submit"
          onClick={() => onConfirm({ restock, ...(reason.trim() ? { reason: reason.trim() } : {}) })}
          className="text-xs px-3 py-1.5 rounded-lg text-white bg-rose-600 hover:bg-rose-700"
        >
          {t("commerce.cancel") || "Cancel order"}
        </button>
      </div>
    </Modal>
  );
}

function Modal({ children, onCancel, titleId }: { children: React.ReactNode; onCancel: () => void; titleId: string }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-white rounded-xl shadow-xl max-w-xs w-full p-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Check({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-[11px] text-gray-700 cursor-pointer">
      <input id={id} data-testid={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="rounded border-gray-300" />
      {label}
    </label>
  );
}

/**
 * Customer tags and internal note.
 *
 * The tag list shown is whatever the server last verified. Adding a tag does
 * not append locally - the panel waits for the re-read list, so a tag that
 * silently failed to save can never appear to have saved.
 */
function CustomerActions({
  caps, tags, busy, msg, onAddTag, onRemoveTag, onAddNote, t,
}: {
  caps: CommerceContext["capabilities"];
  tags: string[] | null;
  busy: boolean;
  msg: { text: string; tone: StatusChip["tone"] } | null;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onAddNote: (note: string) => void;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const [tagDraft, setTagDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);

  return (
    <div className="px-3 pb-3 pt-1 border-t border-gray-50" data-testid="customer-actions">
      {caps.canTag && (
        <>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
            {t("commerce.customerTags") || "Customer tags"}
          </p>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {tags === null ? (
              <span className="text-[10px] text-gray-400">{t("commerce.tagsUnknown") || "Not loaded"}</span>
            ) : tags.length === 0 ? (
              <span className="text-[10px] text-gray-400">{t("commerce.noTags") || "No tags"}</span>
            ) : (
              tags.map((tag) => (
                <span key={tag} data-testid={`customer-tag-${tag}`} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-700">
                  {tag}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`${t("commerce.removeTag") || "Remove tag"} ${tag}`}
                    onClick={() => onRemoveTag(tag)}
                    className="text-gray-400 hover:text-rose-600 disabled:opacity-40 leading-none"
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="flex gap-1 mb-2">
            <input
              data-testid="tag-input"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && tagDraft.trim()) { onAddTag(tagDraft.trim()); setTagDraft(""); }
              }}
              placeholder={t("commerce.addTag") || "Add a tag"}
              className="flex-1 min-w-0 px-2 py-1 rounded-md border border-gray-200 text-[11px] outline-none focus:border-indigo-300"
            />
            <button
              type="button"
              data-testid="tag-add"
              disabled={busy || !tagDraft.trim()}
              onClick={() => { onAddTag(tagDraft.trim()); setTagDraft(""); }}
              className="text-[10px] font-medium px-2 py-1 rounded-md bg-white border border-gray-200 text-gray-700 hover:border-indigo-300 disabled:opacity-40"
            >
              {t("commerce.add") || "Add"}
            </button>
          </div>
        </>
      )}

      {caps.canNote && (
        noteOpen ? (
          <div className="flex flex-col gap-1">
            <textarea
              data-testid="note-input"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              rows={2}
              placeholder={t("commerce.notePlaceholder") || "Internal note about this customer"}
              className="w-full px-2 py-1 rounded-md border border-gray-200 text-[11px] outline-none focus:border-indigo-300 resize-none"
            />
            <div className="flex justify-end gap-1">
              <button type="button" onClick={() => { setNoteOpen(false); setNoteDraft(""); }} className="text-[10px] px-2 py-1 rounded-md text-gray-500 hover:bg-gray-100">
                {t("commerce.back") || "Back"}
              </button>
              <button
                type="button"
                data-testid="note-save"
                disabled={busy || !noteDraft.trim()}
                onClick={() => { onAddNote(noteDraft.trim()); setNoteDraft(""); setNoteOpen(false); }}
                className="text-[10px] font-medium px-2 py-1 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                {t("commerce.saveNote") || "Save note"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-testid="note-open"
            onClick={() => setNoteOpen(true)}
            className="text-[10px] font-medium px-2 py-1 rounded-md bg-white border border-gray-200 text-gray-700 hover:border-indigo-300"
          >
            {t("commerce.addNote") || "Add a note"}
          </button>
        )
      )}

      {msg && (
        <div className={clsx("mt-2 text-[10px] px-2 py-1 rounded", msg.tone === "positive" ? "bg-emerald-50 text-emerald-700" : msg.tone === "danger" ? "bg-rose-50 text-rose-600" : "bg-amber-50 text-amber-700")} data-testid="customer-action-msg">
          {msg.text}
        </div>
      )}
    </div>
  );
}

/** One label/value line. Renders nothing at all when there is no value, so the
 *  panel never shows a field with a blank beside it. */
function Field({ label, value, testId }: { label: string; value?: string | null; testId?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-1.5 min-w-0" data-testid={testId}>
      <span className="text-[10px] text-gray-400 shrink-0">{label}</span>
      <span className="text-[11px] text-gray-700 truncate" dir="auto">{value}</span>
    </div>
  );
}

/**
 * Customer summary (spec §14).
 *
 * Every field is conditional. Shopify omits plenty depending on the account
 * and the granted scopes, and an agent reading "Total spent: 0.00" would draw
 * a conclusion the data does not support - so a missing value is simply not
 * shown, and the section collapses to whatever is genuinely known.
 */
function CustomerSummaryCard({
  summary, dateLocale, t,
}: {
  summary: CommerceSummary;
  dateLocale: string;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const [open, setOpen] = useState(false);
  const date = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleDateString(dateLocale, { day: "numeric", month: "short", year: "numeric" }) : undefined;

  const extras = [
    summary.email, summary.phone, summary.defaultAddress,
    summary.customerSince, summary.note, summary.averageOrderValue,
  ].filter(Boolean).length;

  return (
    <div className="px-3 py-2.5 border-b border-gray-50" data-testid="customer-summary">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {summary.name && (
            <p className="text-xs font-semibold text-gray-900 truncate" dir="auto" data-testid="customer-name">{summary.name}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
            <span className="text-[10px] text-gray-500 tabular-nums">
              {t("commerce.orders") || "Orders"}: <span className="font-semibold text-gray-700">{summary.orderCount}</span>
            </span>
            {summary.repeatCustomer && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-50 text-emerald-700">{t("commerce.repeatCustomer") || "Repeat"}</span>
            )}
            {summary.acceptsMarketing === true && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-indigo-50 text-indigo-700">{t("commerce.subscribed") || "Subscribed"}</span>
            )}
          </div>
        </div>
        {extras > 0 && (
          <button
            type="button"
            data-testid="customer-summary-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="text-[10px] text-gray-400 hover:text-gray-600 shrink-0"
          >
            {open ? t("commerce.less") || "Less" : t("commerce.more") || "More"}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-0.5" data-testid="customer-summary-details">
          <Field label={t("commerce.email") || "Email"} value={summary.email} testId="cs-email" />
          <Field label={t("commerce.phone") || "Phone"} value={summary.phone} testId="cs-phone" />
          <Field
            label={t("commerce.averageOrder") || "Average order"}
            value={summary.averageOrderValue ? money(summary.averageOrderValue) : undefined}
            testId="cs-aov"
          />
          <Field label={t("commerce.customerSince") || "Customer since"} value={date(summary.customerSince)} testId="cs-since" />
          <Field label={t("commerce.lastOrder") || "Last order"} value={date(summary.lastOrderAt)} testId="cs-last" />
          <Field label={t("commerce.defaultAddress") || "Address"} value={summary.defaultAddress} testId="cs-address" />
          <Field label={t("commerce.customerNote") || "Note"} value={summary.note} testId="cs-note" />
        </div>
      )}
    </div>
  );
}

/**
 * Expandable order detail (spec §16).
 *
 * Money lines are rendered only when the provider returned them. A refund
 * decision made against an invented subtotal is worse than one made with the
 * line simply absent.
 */
function OrderDetailSection({
  detail, dateLocale, t,
}: {
  detail: OrderDetail;
  dateLocale: string;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const [open, setOpen] = useState(false);
  const row = (label: string, m?: { amount: string; currency: string }, testId?: string) =>
    m ? (
      <div className="flex items-center justify-between text-[11px]" data-testid={testId}>
        <span className="text-gray-500">{label}</span>
        <span className="text-gray-800 tabular-nums" dir="ltr">{money(m)}</span>
      </div>
    ) : null;

  return (
    <div className="px-3 pb-2.5">
      <button
        type="button"
        data-testid="order-detail-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-[10px] font-medium text-gray-500 hover:text-gray-700"
      >
        {open ? t("commerce.hideDetails") || "Hide details" : t("commerce.showDetails") || "Show details"}
        {detail.itemCount > 0 && <span className="text-gray-400"> · {detail.itemCount} {t("commerce.items") || "items"}</span>}
      </button>

      {open && (
        <div className="mt-2 space-y-2" data-testid="order-detail">
          {/* Line items */}
          {detail.lineItems.length > 0 && (
            <ul className="space-y-1">
              {detail.lineItems.map((li, i) => (
                <li key={`${li.title}-${i}`} className="flex items-start justify-between gap-2 text-[11px]" data-testid="order-line">
                  <span className="min-w-0 text-gray-700" dir="auto">
                    <span className="tabular-nums text-gray-400">{li.quantity}× </span>
                    {li.title}
                    {li.variantTitle && <span className="text-gray-400"> · {li.variantTitle}</span>}
                  </span>
                  <span className="shrink-0 text-gray-800 tabular-nums" dir="ltr">{money(li.lineTotal)}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Money breakdown */}
          <div className="space-y-0.5 pt-1.5 border-t border-gray-100">
            {row(t("commerce.subtotal") || "Subtotal", detail.subtotal, "od-subtotal")}
            {row(t("commerce.discounts") || "Discounts", detail.discounts, "od-discounts")}
            {row(t("commerce.shippingCost") || "Shipping", detail.shipping, "od-shipping")}
            {row(t("commerce.tax") || "Tax", detail.tax, "od-tax")}
            {row(t("commerce.paid") || "Paid", detail.paid, "od-paid")}
            {detail.outstanding && Number(detail.outstanding.amount) > 0 &&
              row(t("commerce.outstanding") || "Outstanding", detail.outstanding, "od-outstanding")}
          </div>

          {/* Tracking */}
          {detail.tracking.length > 0 && (
            <div className="space-y-0.5" data-testid="order-tracking">
              {detail.tracking.map((tr, i) => (
                <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-gray-500 shrink-0">{tr.company || t("commerce.tracking") || "Tracking"}</span>
                  <span className="flex items-center gap-1.5 min-w-0">
                    {tr.url ? (
                      <a href={tr.url} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline truncate" dir="ltr">{tr.number || t("commerce.track") || "Track"}</a>
                    ) : (
                      <span className="text-gray-700 truncate" dir="ltr">{tr.number}</span>
                    )}
                    {tr.number && (
                      <button
                        type="button"
                        data-testid="copy-tracking"
                        aria-label={t("commerce.copyTracking") || "Copy tracking number"}
                        onClick={() => { try { navigator.clipboard?.writeText(tr.number!); } catch { /* clipboard may be unavailable */ } }}
                        className="text-gray-400 hover:text-gray-600 shrink-0"
                      >
                        ⧉
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          <Field label={t("commerce.shipTo") || "Ship to"} value={detail.shippingAddress} testId="od-ship-to" />
          <Field label={t("commerce.billTo") || "Bill to"} value={detail.billingAddress} testId="od-bill-to" />
          <Field label={t("commerce.orderSource") || "Source"} value={detail.sourceName} testId="od-source" />
          <Field label={t("commerce.cancelReason") || "Cancellation reason"} value={detail.cancelReason} testId="od-cancel-reason" />

          {detail.tags.length > 0 && (
            <div className="flex flex-wrap gap-1" data-testid="order-tags">
              {detail.tags.map((tag) => (
                <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-600">{tag}</span>
              ))}
            </div>
          )}

          {detail.refunds.length > 0 && (
            <ul className="space-y-0.5 pt-1.5 border-t border-gray-100" data-testid="order-refunds">
              {detail.refunds.map((r, i) => (
                <li key={i} className="flex items-center justify-between text-[11px]">
                  <span className="text-gray-500">
                    {t("commerce.refunded") || "Refunded"}
                    <span className="text-gray-400"> · {new Date(r.at).toLocaleDateString(dateLocale, { day: "numeric", month: "short" })}</span>
                  </span>
                  <span className="text-gray-800 tabular-nums" dir="ltr">{money(r.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
