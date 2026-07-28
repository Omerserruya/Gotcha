"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/context/I18nContext";
import { searchShopifyProducts, sendShopifyProductMessage } from "@/lib/api";
import { ProductCard, type ProductView } from "./ProductCard";

/**
 * Agent-facing Shopify product picker.
 *
 * Deliberately shows the SAME card the shopper will receive, with live
 * price and stock, so an agent never sends something they have not
 * actually looked at. Selecting more than one sends a carousel.
 *
 * Nothing here decides what is legal to send: the server re-resolves
 * every product against the conversation's own store before persisting,
 * so a stale search result cannot become a message.
 */

interface Props {
  conversationId: string;
  maxProducts: number;
  onClose: () => void;
  onSent: () => void;
}

export function ProductPicker({ conversationId, maxProducts, onClose, onSent }: Props) {
  const { token } = useAuth();
  const { t } = useI18n();

  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<ProductView[]>([]);
  const [selected, setSelected] = useState<ProductView[]>([]);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (q: string) => {
      if (!token) return;
      setLoading(true);
      setError(null);
      try {
        const res = await searchShopifyProducts(token, q, { limit: 12 });
        setProducts((res.data.products || []) as ProductView[]);
      } catch (err: any) {
        setError(err.message || t("shopifyChat.pickerUnavailable"));
        setProducts([]);
      } finally {
        setLoading(false);
      }
    },
    [token, t],
  );

  useEffect(() => {
    run("");
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [run]);

  // Debounced search: an agent types mid-conversation and a request per
  // keystroke would burn the tenant's Shopify rate budget.
  useEffect(() => {
    const id = setTimeout(() => run(query), 350);
    return () => clearTimeout(id);
  }, [query, run]);

  function toggle(product: ProductView) {
    setSelected((prev) => {
      const exists = prev.find((p) => p.productId === product.productId);
      if (exists) return prev.filter((p) => p.productId !== product.productId);
      if (prev.length >= maxProducts) {
        setError(t("shopifyChat.maxSelected").replace("{max}", String(maxProducts)));
        return prev;
      }
      setError(null);
      return [...prev, product];
    });
  }

  function chooseVariant(product: ProductView, variantId: string) {
    const apply = (p: ProductView) =>
      p.productId === product.productId ? { ...p, selectedVariantId: variantId } : p;
    setProducts((prev) => prev.map(apply));
    setSelected((prev) => prev.map(apply));
  }

  async function send() {
    if (!token || !selected.length) return;
    setSending(true);
    setError(null);
    try {
      await sendShopifyProductMessage(token, conversationId, {
        products: selected.map((p) => ({
          productId: p.productId,
          variantId: p.selectedVariantId || undefined,
        })),
        text: note.trim() || undefined,
      });
      onSent();
      onClose();
    } catch (err: any) {
      setError(err.message || t("common.error"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("shopifyChat.pickerTitle")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-xl flex flex-col max-h-[85vh]"
      >
        <div className="p-4 border-b border-gray-100">
          <h3 className="font-bold text-gray-900">{t("shopifyChat.pickerTitle")}</h3>
          <p className="text-xs text-gray-400 mt-0.5">{t("shopifyChat.pickerHint")}</p>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("shopifyChat.searchProducts")}
            aria-label={t("shopifyChat.searchProducts")}
            className="mt-3 w-full text-sm px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-200"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
            </div>
          ) : products.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">{t("shopifyChat.noProducts")}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {products.map((p) => (
                <ProductCard
                  key={p.productId}
                  product={p}
                  compact
                  selected={!!selected.find((s) => s.productId === p.productId)}
                  onSelect={toggle}
                  onVariantChange={chooseVariant}
                />
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100 space-y-2">
          {error && <p className="text-xs text-red-600">{error}</p>}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("shopifyChat.addNote")}
            aria-label={t("shopifyChat.addNote")}
            className="w-full text-sm px-3 py-2 border border-gray-200 rounded-xl"
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-gray-500">
              {t("shopifyChat.selectedCount").replace("{count}", String(selected.length))}
            </span>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="text-sm px-3 py-2 rounded-xl text-gray-600 hover:bg-gray-50"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={send}
                disabled={!selected.length || sending}
                className={clsx(
                  "text-sm font-medium px-4 py-2 rounded-xl text-white transition",
                  !selected.length || sending
                    ? "bg-gray-300 cursor-not-allowed"
                    : "bg-primary-500 hover:bg-primary-600",
                )}
              >
                {t("shopifyChat.sendProducts")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
