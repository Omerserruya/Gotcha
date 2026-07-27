"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import { ProductCard, ProductCarousel, type ProductView } from "./ProductCard";

/**
 * Live preview of the storefront widget.
 *
 * This renders the merchant's ACTUAL configuration — their colours, logo,
 * copy and suggested questions — so "what will my customers see?" is
 * answered before they enable the channel on a live store.
 *
 * The products shown are the merchant's own, fetched from their connected
 * Shopify store. When none can be loaded we fall back to a fixture that
 * is LABELLED as a sample: showing invented products next to a merchant's
 * real branding, unlabelled, is how a preview becomes a lie.
 */

export type PreviewState = "welcome" | "conversation" | "product" | "carousel" | "offline";
export type PreviewDevice = "desktop" | "mobile";

interface Props {
  config: any;
  device: PreviewDevice;
  state: PreviewState;
  language: "en" | "he";
  /** Real products from the connected store, when available. */
  sampleProducts: ProductView[];
  productsAreReal: boolean;
}

const COPY = {
  en: {
    online: "Online",
    offline: "Away",
    placeholder: "Ask us anything",
    poweredBy: "Powered by GOTCHA",
    talkToHuman: "Talk to a person",
    visitor: "Do you have this in a size 42?",
    assistant: "We do — it is in stock in black and white. Here is the one I would go for:",
    assistantMulti: "Three that suit long runs, lightest first:",
    sampleFixture: "Sample product — connect a store with products to preview your own",
  },
  he: {
    online: "זמינים",
    offline: "לא זמינים",
    placeholder: "אפשר לשאול אותנו הכל",
    poweredBy: "מופעל על ידי GOTCHA",
    talkToHuman: "לדבר עם נציג",
    visitor: "יש לכם את זה במידה 42?",
    assistant: "בהחלט — יש במלאי בשחור ולבן. זה מה שהייתי ממליץ:",
    assistantMulti: "שלושה שמתאימים לריצות ארוכות, מהקל ביותר:",
    sampleFixture: "מוצר לדוגמה — חברו חנות עם מוצרים כדי לראות את שלכם",
  },
};

export function WidgetPreview({
  config,
  device,
  state,
  language,
  sampleProducts,
  productsAreReal,
}: Props) {
  const { t } = useI18n();
  const [openPanel, setOpenPanel] = useState(true);
  const copy = COPY[language];
  const appearance = config?.appearance ?? {};
  const welcome = config?.welcome ?? {};
  const dir = appearance.direction === "auto" ? (language === "he" ? "rtl" : "ltr") : appearance.direction;

  const brand = appearance.primaryColor || "#111827";
  const onBrand = appearance.contrastColor || "#ffffff";
  const radius = Math.max(0, Math.min(28, Number(appearance.cornerRadius ?? 20)));

  const products = useMemo(
    () => (state === "carousel" ? sampleProducts.slice(0, 3) : sampleProducts.slice(0, 1)),
    [sampleProducts, state],
  );

  const frameClass =
    device === "mobile"
      ? "w-[320px] h-[600px] rounded-[28px] border-8 border-gray-900 bg-white"
      : "w-[392px] h-[560px] rounded-2xl border border-gray-200 bg-white shadow-xl";

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        dir={dir}
        lang={language}
        className={clsx("overflow-hidden flex flex-col", frameClass)}
        style={{ borderRadius: device === "mobile" ? 28 : radius }}
        role="img"
        aria-label={t("shopifyChat.previewAria")}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 shrink-0">
          {appearance.logoUrl || appearance.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={appearance.logoUrl || appearance.avatarUrl}
              alt=""
              className="w-10 h-10 rounded-xl object-cover"
            />
          ) : (
            <div className="w-10 h-10 rounded-xl" style={{ background: brand }} aria-hidden="true" />
          )}
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm text-gray-900 truncate">
              {welcome.assistantName || "Store Assistant"}
            </p>
            <p className="flex items-center gap-1.5 text-[12px] text-gray-500">
              <span
                className="w-[7px] h-[7px] rounded-full"
                style={{ background: state === "offline" ? "#cbd5e1" : "#16a34a" }}
              />
              {state === "offline" ? copy.offline : copy.online}
            </p>
          </div>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="w-8 h-8 rounded-lg text-gray-400"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {state === "welcome" || state === "offline" ? (
            <div className="space-y-4">
              {appearance.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={appearance.logoUrl} alt="" className="w-12 h-12 rounded-xl object-contain bg-gray-50" />
              )}
              <h3 className="text-[26px] leading-tight font-bold tracking-tight text-gray-900">
                {welcome.headline || "Hi there"}
              </h3>
              <p className="text-[15px] text-gray-600">{welcome.subline || ""}</p>
              {state === "offline" && config?.hours?.offlineMessage && (
                <p className="text-[14px] text-gray-500">{config.hours.offlineMessage}</p>
              )}
              <div className="flex flex-col gap-2">
                {(welcome.suggestedQuestions || []).map((q: string, i: number) => (
                  <span
                    key={i}
                    className="border border-gray-200 rounded-2xl px-3.5 py-3 text-[14px] text-gray-900"
                  >
                    {q}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-2.5">
              <div className="flex justify-end">
                <span
                  className="max-w-[84%] px-3 py-2 rounded-2xl text-[14px]"
                  style={{ background: brand, color: onBrand }}
                >
                  {copy.visitor}
                </span>
              </div>
              <div className="flex flex-col items-start gap-1">
                <span className="text-[11px] text-gray-400 px-1">
                  {welcome.assistantName || "Store Assistant"}
                </span>
                <span className="max-w-[84%] px-3 py-2 rounded-2xl bg-gray-100 text-[14px] text-gray-900">
                  {state === "carousel" ? copy.assistantMulti : copy.assistant}
                </span>
              </div>
              {(state === "product" || state === "carousel") && products.length > 0 && (
                <div className="pt-1">
                  {state === "carousel" ? (
                    <ProductCarousel products={products} />
                  ) : (
                    <ProductCard product={products[0]} />
                  )}
                  {!productsAreReal && (
                    <p className="mt-1.5 text-[11px] text-amber-700 bg-amber-50 rounded-lg px-2 py-1">
                      {copy.sampleFixture}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-gray-100 px-3.5 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <span className="flex-1 border border-gray-200 rounded-2xl px-3 py-2.5 text-[14px] text-gray-400">
              {copy.placeholder}
            </span>
            <span
              className="w-10 h-10 rounded-xl flex items-center justify-center text-sm"
              style={{ background: brand, color: onBrand }}
              aria-hidden="true"
            >
              {dir === "rtl" ? "←" : "→"}
            </span>
          </div>
          <div className="flex items-center justify-between mt-2">
            {config?.routing?.allowHumanHandoff ? (
              <span className="text-[12px] text-gray-500 underline">{copy.talkToHuman}</span>
            ) : (
              <span />
            )}
            {appearance.showPoweredBy && (
              <span className="text-[11px] text-gray-400">{copy.poweredBy}</span>
            )}
          </div>
        </div>
      </div>

      {/* Launcher */}
      <div
        className="flex w-full"
        style={{ justifyContent: appearance.launcherPosition === "left" ? "flex-start" : "flex-end" }}
      >
        <button
          type="button"
          onClick={() => setOpenPanel((v) => !v)}
          className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg"
          style={{ background: brand, color: onBrand }}
          aria-label={t("shopifyChat.previewLauncher")}
        >
          <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            {appearance.launcherIcon === "sparkle" ? (
              <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
            ) : appearance.launcherIcon === "bag" ? (
              <path d="M6 8h12l-1 12H7L6 8Zm3 0V6a3 3 0 1 1 6 0v2" />
            ) : appearance.launcherIcon === "question" ? (
              <path d="M12 17h.01M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" />
            ) : (
              <path d="M12 3c5 0 9 3.36 9 7.5S17 18 12 18a10.7 10.7 0 0 1-3-.42L5 19l1.2-3.2A7.9 7.9 0 0 1 3 10.5C3 6.36 7 3 12 3Z" />
            )}
          </svg>
        </button>
      </div>
      {!openPanel && <span className="sr-only">{t("shopifyChat.previewLauncher")}</span>}
    </div>
  );
}

/**
 * Clearly-labelled placeholder used only when the connected store has no
 * products to preview with. Prices are round and obviously illustrative.
 */
export const PREVIEW_FIXTURE: ProductView[] = [
  {
    productId: "sample-1",
    handle: "sample-product",
    title: "Sample Product",
    imageUrl: null,
    productUrl: "#",
    currency: "USD",
    price: "120.00",
    compareAtPrice: "150.00",
    available: true,
    published: true,
    selectedVariantId: null,
    optionNames: ["Size"],
    variants: [
      { variantId: "s1", title: "41", price: "120.00", compareAtPrice: "150.00", available: true },
      { variantId: "s2", title: "42", price: "120.00", compareAtPrice: "150.00", available: true },
      { variantId: "s3", title: "43", price: "120.00", compareAtPrice: "150.00", available: false },
    ],
    reason: null,
  },
  {
    productId: "sample-2",
    handle: "sample-product-2",
    title: "Sample Product Two",
    imageUrl: null,
    productUrl: "#",
    currency: "USD",
    price: "89.00",
    compareAtPrice: null,
    available: true,
    published: true,
    selectedVariantId: null,
    optionNames: [],
    variants: [{ variantId: "s4", title: "Default", price: "89.00", compareAtPrice: null, available: true }],
    reason: null,
  },
  {
    productId: "sample-3",
    handle: "sample-product-3",
    title: "Sample Product Three",
    imageUrl: null,
    productUrl: "#",
    currency: "USD",
    price: "210.00",
    compareAtPrice: null,
    available: false,
    published: true,
    selectedVariantId: null,
    optionNames: [],
    variants: [{ variantId: "s5", title: "Default", price: "210.00", compareAtPrice: null, available: false }],
    reason: null,
  },
];
