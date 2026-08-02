"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { useI18n } from "@/context/I18nContext";
import type { ProductView } from "./ProductCard";

/**
 * Live preview of the storefront widget.
 *
 * This does NOT draw an impression of the widget. It boots the SAME
 * `public/widget/gotcha-shopify-chat.js` the storefront loads, inside an
 * iframe, against the merchant's draft configuration.
 *
 * That choice is the whole point. The previous version was a React
 * re-implementation of the panel, and it drifted exactly as you would
 * expect: it grew a full header the storefront no longer has, never
 * learned about the hero, and kept reading the pre-migration `welcome`
 * block. A merchant tuned the preview and shipped something else.
 *
 * With one renderer there is nothing to keep in sync — a layout change in
 * the widget shows up here on the next load, because it is the same file.
 * The iframe gives it a real viewport too, so "mobile" is a 390px window
 * running the widget's own media queries rather than a narrower <div>.
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
    visitor: "Do you have this in a size 42?",
    assistant: "We do — it is in stock in black and white. Here is the one I would go for:",
    assistantMulti: "Three that suit long runs, lightest first:",
    sampleFixture: "Sample product — connect a store with products to preview your own",
    loading: "Loading preview…",
    failed: "The widget bundle could not be loaded. The preview shows the real widget, so there is nothing to fall back to.",
  },
  he: {
    visitor: "יש לכם את זה במידה 42?",
    assistant: "בהחלט — יש במלאי בשחור ולבן. זה מה שהייתי ממליץ:",
    assistantMulti: "שלושה שמתאימים לריצות ארוכות, מהקל ביותר:",
    sampleFixture: "מוצר לדוגמה — חברו חנות עם מוצרים כדי לראות את שלכם",
    loading: "טוען תצוגה מקדימה…",
    failed: "לא ניתן לטעון את קובץ הווידג׳ט. התצוגה המקדימה מציגה את הווידג׳ט האמיתי, ולכן אין לה תחליף.",
  },
};

const DEVICE = {
  desktop: { width: 400, height: 640 },
  // A real phone viewport, so the widget's own (max-width:560px) rules fire.
  mobile: { width: 390, height: 640 },
};

/**
 * Turn a draft CHANNEL config into the PUBLIC config the widget expects.
 *
 * These are two different shapes and it is easy to miss, because they
 * share several field names. The storefront never sees a channel config:
 * the server projects it in `publicWidgetConfig` — flattening the
 * business-hours block into `offline`, and deriving a `features` block
 * from `routing` and `commerce` that exists nowhere in the stored config.
 *
 * Handing the raw draft straight to the widget is what produced
 * `Cannot read properties of undefined (reading 'humanHandoff')` and a
 * preview that rendered nothing at all.
 *
 * The merchant's entitlements are not known here, so product messaging is
 * assumed available — the preview shows what the configuration WOULD do,
 * and the server remains the authority on what a given plan may actually
 * use.
 */
export function previewWidgetConfig(
  draft: any,
  opts: { language: "en" | "he"; offline: boolean },
) {
  const appearance = draft?.appearance ?? {};
  const welcome = draft?.welcome ?? {};
  const hours = draft?.hours ?? {};
  const routing = draft?.routing ?? {};
  const commerce = draft?.commerce ?? {};
  const privacy = draft?.privacy ?? {};

  return {
    appearance: {
      ...appearance,
      // The preview's own language control, not the merchant's setting:
      // these two switches are what the control is FOR.
      language: opts.language,
      direction: opts.language === "he" ? "rtl" : "ltr",
    },
    welcome: {
      headline: welcome.headline ?? "",
      subline: welcome.subline ?? "",
      assistantName: welcome.assistantName ?? "",
      suggestedQuestions: welcome.suggestedQuestions ?? [],
    },
    offline: {
      active: opts.offline,
      message: hours.offlineMessage ?? "",
      behavior: hours.offlineBehavior ?? "ai",
      formFields: hours.offlineFormFields ?? [],
      consentRequired: !!privacy.requireOfflineConsent,
      consentText: hours.offlineConsentText ?? "",
    },
    features: {
      humanHandoff: !!routing.allowHumanHandoff,
      productMessaging: true,
      addToCart: !!commerce.addToCartEnabled,
    },
    ux: draft?.ux ?? undefined,
  };
}

/** Messages that put the widget into the state the merchant asked to see. */
function messagesFor(state: PreviewState, products: ProductView[], copy: (typeof COPY)["en"]) {
  const now = new Date().toISOString();
  const visitor = { id: "p1", direction: "INBOUND", body: copy.visitor, messageType: "text", author: null, authorKind: "visitor", createdAt: now, commerce: null };
  const reply = (body: string, commerce: any) => ({
    id: "p2", direction: "OUTBOUND", body, messageType: "text",
    author: "Assistant", authorKind: "ai", createdAt: now, commerce,
  });

  switch (state) {
    case "welcome":
    case "offline":
      return [];
    case "conversation":
      return [visitor, reply(copy.assistant.split(" Here is")[0], null)];
    case "product":
      return [visitor, reply(copy.assistant, products[0] ? { kind: "product", products: [products[0]] } : null)];
    case "carousel":
      return [visitor, reply(copy.assistantMulti, { kind: "carousel", products: products.slice(0, 3) })];
  }
}

export function WidgetPreview({ config, device, state, language, sampleProducts, productsAreReal }: Props) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [bundle, setBundle] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const copy = COPY[language];
  const size = DEVICE[device];

  // The bundle filename is content-hashed, so it is read from the manifest
  // rather than hard-coded — a hard-coded name is how the storefront ended
  // up serving a stale widget once already.
  useEffect(() => {
    let alive = true;
    fetch("/widget/widget-manifest.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m) => { if (alive) setBundle(String(m.chat)); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  // Serialising the config is what makes the effect re-run on every edit,
  // including nested ones a reference check would miss.
  const configKey = useMemo(() => JSON.stringify(config ?? {}), [config]);
  const products = sampleProducts.length ? sampleProducts : PREVIEW_FIXTURE;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !bundle) return;
    const doc = frame.contentDocument;
    const win = frame.contentWindow as any;
    if (!doc || !win) return;

    let cancelled = false;

    // Rebuild from scratch on every change: the widget owns its shadow
    // root and has no re-configure entry point, and a preview that
    // re-mounts is honest about what a shopper's first load will look like.
    doc.open();
    doc.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body style="margin:0;background:#f8fafc"></body></html>');
    doc.close();

    const script = doc.createElement("script");
    script.src = `/widget/${bundle}`;
    script.onload = () => {
      if (cancelled) return;
      const factory = win.__gotchaShopifyChatApp;
      if (typeof factory !== "function") { setFailed(true); return; }

      const host = doc.createElement("div");
      doc.body.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });

      const draft = JSON.parse(configKey);
      const msgs = messagesFor(state, products, copy);
      const widget = previewWidgetConfig(draft, {
        language,
        offline: state === "offline",
      });

      const app = factory({
        api: "", assets: "",
        context: { pageType: "product", productHandle: "preview", locale: language },
        availability: state === "offline" ? "offline" : "online",
        // In-memory only: a preview must never write a visitor session.
        store: (() => { const m: Record<string, string> = {}; return { get: (k: string) => m[k] ?? null, set: (k: string, v: string) => { m[k] = v; }, del: (k: string) => { delete m[k]; } }; })(),
        // No network. Every call resolves locally, so the preview cannot
        // create a conversation or send a message on the merchant's behalf.
        post: async (path: string) => {
          if (path.endsWith("/conversation")) {
            return { data: { conversationId: "preview", status: "OPEN", isHandedOver: false, messages: msgs } };
          }
          return { data: {} };
        },
        shadow,
        setUnread: () => {}, onOpened: () => {}, onClosed: () => {},
        // Sounds are never wired in the preview: a settings page that
        // chimes at the merchant while they type is its own bug.
        widget,
      });
      app.open();
    };
    script.onerror = () => { if (!cancelled) setFailed(true); };
    doc.body.appendChild(script);

    return () => { cancelled = true; };
  }, [bundle, configKey, state, language, device, products, copy]);

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={clsx(
          "relative overflow-hidden rounded-[26px] border border-gray-200 bg-gray-50 shadow-sm",
          device === "mobile" && "rounded-[34px] border-[6px] border-gray-900",
        )}
        style={{ width: size.width, height: size.height }}
      >
        {failed ? (
          <p className="p-6 text-sm text-red-600">{copy.failed}</p>
        ) : (
          <iframe
            ref={frameRef}
            title={t("shopifyChat.previewTitle")}
            className="h-full w-full border-0"
            // The widget is first-party code from this same origin; the
            // sandbox still withholds top-level navigation and forms.
            sandbox="allow-scripts allow-same-origin"
          />
        )}
        {!bundle && !failed && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">{copy.loading}</p>
        )}
      </div>
      {!productsAreReal && (state === "product" || state === "carousel") && (
        <p className="max-w-[380px] text-center text-xs text-gray-500">{copy.sampleFixture}</p>
      )}
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
