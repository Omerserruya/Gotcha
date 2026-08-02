"use client";

import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";

/**
 * Shopify product card — the dashboard-side renderer.
 *
 * Shared by three surfaces on purpose: the inbox (where an agent reads
 * what the AI sent), the channel settings preview, and the agent's own
 * product picker. One renderer means an agent is looking at the same card
 * the shopper is, which is the whole point of showing it in the inbox at
 * all.
 *
 * The storefront widget has its own vanilla-JS implementation — it lives
 * inside a Shadow DOM on a merchant's theme and cannot import React. The
 * two are kept visually in step deliberately; this one is read-only and
 * never performs a cart action.
 */

export interface ProductVariantView {
  variantId: string;
  title: string;
  price: string | null;
  compareAtPrice: string | null;
  available: boolean;
  options?: string[];
  requiresSellingPlan?: boolean;
}

export interface ProductView {
  productId: string;
  handle: string;
  title: string;
  imageUrl: string | null;
  productUrl: string;
  currency: string;
  price: string | null;
  compareAtPrice: string | null;
  available: boolean;
  published?: boolean;
  status?: string;
  vendor?: string | null;
  selectedVariantId: string | null;
  optionNames: string[];
  variants: ProductVariantView[];
  reason?: string | null;
}

export function formatMoney(amount: string | null, currency: string, locale: string): string {
  if (amount == null) return "";
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat(locale === "he" ? "he-IL" : "en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

interface Props {
  product: ProductView;
  compact?: boolean;
  /** Rendered inside a horizontally scrolling carousel. */
  inCarousel?: boolean;
  selected?: boolean;
  onSelect?: (product: ProductView) => void;
  onVariantChange?: (product: ProductView, variantId: string) => void;
}

export function ProductCard({
  product,
  compact,
  inCarousel,
  selected,
  onSelect,
  onVariantChange,
}: Props) {
  const { t, locale } = useI18n();
  const variant =
    product.variants.find((v) => v.variantId === product.selectedVariantId) ?? null;

  const price = variant?.price ?? product.price;
  const wasPrice = variant?.compareAtPrice ?? product.compareAtPrice;
  const onSale = !!wasPrice && Number(wasPrice) > Number(price);
  const available = variant ? variant.available : product.available;
  const isPublished = product.published !== false && product.status !== "draft" && product.status !== "archived";
  const needsChoice = product.optionNames.length > 0 && product.variants.length > 1;

  const Wrapper: any = onSelect ? "button" : "div";

  return (
    <Wrapper
      type={onSelect ? "button" : undefined}
      onClick={onSelect ? () => onSelect(product) : undefined}
      className={clsx(
        "text-start bg-white border rounded-2xl overflow-hidden transition",
        inCarousel ? "w-[190px] shrink-0" : "w-full max-w-sm",
        selected ? "border-primary-500 ring-2 ring-primary-100" : "border-gray-200",
        onSelect && "hover:border-primary-300 cursor-pointer",
      )}
      aria-pressed={onSelect ? !!selected : undefined}
    >
      <div className={clsx("flex gap-3 p-3", inCarousel && "flex-col")}>
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className={clsx(
              "object-cover rounded-xl bg-gray-100 shrink-0",
              inCarousel ? "w-full h-28" : compact ? "w-14 h-14" : "w-[72px] h-[72px]",
            )}
          />
        ) : (
          <div
            className={clsx(
              "rounded-xl bg-gray-100 shrink-0",
              inCarousel ? "w-full h-28" : compact ? "w-14 h-14" : "w-[72px] h-[72px]",
            )}
            aria-hidden="true"
          />
        )}

        <div className="flex-1 min-w-0 space-y-1">
          <p className="font-semibold text-[13.5px] leading-snug text-gray-900 line-clamp-2">
            {product.title}
          </p>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-semibold text-sm text-gray-900">
              {formatMoney(price, product.currency, locale)}
            </span>
            {onSale && (
              <>
                <span className="text-[11px] text-gray-400 line-through">
                  {formatMoney(wasPrice, product.currency, locale)}
                </span>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">
                  -{Math.round((1 - Number(price) / Number(wasPrice)) * 100)}%
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {!available && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                {t("shopifyChat.soldOut")}
              </span>
            )}
            {!isPublished && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700">
                {t("shopifyChat.notPublished")}
              </span>
            )}
            {product.vendor && !inCarousel && (
              <span className="text-[10px] text-gray-400">{product.vendor}</span>
            )}
          </div>
        </div>
      </div>

      {product.reason && (
        <p className="px-3 pb-2 text-[12px] text-gray-500 leading-snug">{product.reason}</p>
      )}

      {needsChoice && (
        <div className="px-3 pb-2 space-y-1.5">
          <p className="text-[10.5px] text-gray-400">
            {product.optionNames.join(" · ")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {product.variants.slice(0, 12).map((v) => (
              <button
                key={v.variantId}
                type="button"
                disabled={!v.available}
                aria-pressed={v.variantId === product.selectedVariantId}
                onClick={(e) => {
                  e.stopPropagation();
                  onVariantChange?.(product, v.variantId);
                }}
                className={clsx(
                  "text-[11px] px-2 py-1 rounded-full border transition",
                  v.variantId === product.selectedVariantId
                    ? "border-primary-500 bg-primary-500 text-white"
                    : "border-gray-200 text-gray-700 hover:border-gray-300",
                  !v.available && "opacity-40 line-through cursor-not-allowed",
                )}
              >
                {v.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="px-3 pb-3 flex gap-2">
        <span
          className={clsx(
            "flex-1 text-center text-[12px] font-semibold py-1.5 rounded-lg",
            available && isPublished
              ? "bg-gray-900 text-white"
              : "bg-gray-100 text-gray-400",
          )}
        >
          {t("shopifyChat.addToCart")}
        </span>
        <a
          href={product.productUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="flex-1 text-center text-[12px] font-semibold py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:border-gray-300"
        >
          {t("shopifyChat.viewProduct")}
        </a>
      </div>
    </Wrapper>
  );
}

/**
 * Carousel of product cards. Scrolls horizontally inside its own
 * container so a long list never widens the conversation column — an
 * inbox that scrolls sideways is an inbox nobody trusts.
 */
export function ProductCarousel({ products }: { products: ProductView[] }) {
  return (
    <div className="max-w-full overflow-x-auto">
      <div className="flex gap-2 pb-1">
        {products.map((p) => (
          <ProductCard key={p.productId + (p.selectedVariantId ?? "")} product={p} inCarousel />
        ))}
      </div>
    </div>
  );
}
