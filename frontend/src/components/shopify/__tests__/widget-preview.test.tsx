/**
 * Shopify Live Chat — dashboard UI.
 *
 * Covers what a merchant and an agent actually see: the branded welcome
 * state in both directions, product cards that tell the truth about
 * stock, a carousel that cannot widen the page, and keyboard access.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import { WidgetPreview, PREVIEW_FIXTURE } from "../WidgetPreview";
import { ProductCard, ProductCarousel, formatMoney, type ProductView } from "../ProductCard";

// The I18n provider reads a token from localStorage and hits the API on
// mount. Stub it: these tests are about layout and semantics, not the
// locale resolver, which has its own coverage.
vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => key.split(".").pop() ?? key,
    locale: "en",
    dir: "ltr",
  }),
}));

function config(overrides: Record<string, any> = {}) {
  return {
    enabled: true,
    shopDomain: "demo-store.myshopify.com",
    appearance: {
      primaryColor: "#111827",
      contrastColor: "#ffffff",
      logoUrl: null,
      avatarUrl: null,
      launcherIcon: "chat",
      launcherPosition: "right",
      cornerRadius: 20,
      language: "auto",
      direction: "auto",
      showPoweredBy: true,
      ...(overrides.appearance ?? {}),
    },
    welcome: {
      headline: "Hi there",
      subline: "Ask us anything about our products.",
      assistantName: "Store Assistant",
      suggestedQuestions: ["Which product is right for me?", "What is currently in stock?"],
      ...(overrides.welcome ?? {}),
    },
    hours: { offlineMessage: "We are away right now.", ...(overrides.hours ?? {}) },
    routing: { allowHumanHandoff: true, ...(overrides.routing ?? {}) },
    commerce: { addToCartEnabled: true },
  };
}

const IN_STOCK: ProductView = {
  productId: "111",
  handle: "cloud-pro",
  title: "Cloud Pro Runner",
  imageUrl: "https://cdn.shopify.com/s/files/1/x.jpg",
  productUrl: "https://demo-store.myshopify.com/products/cloud-pro",
  currency: "USD",
  price: "120.00",
  compareAtPrice: "150.00",
  available: true,
  published: true,
  selectedVariantId: "9001",
  optionNames: ["Size"],
  variants: [
    { variantId: "9001", title: "41", price: "120.00", compareAtPrice: "150.00", available: true },
    { variantId: "9002", title: "42", price: "120.00", compareAtPrice: null, available: false },
  ],
  reason: "Lighter cushioning for long runs.",
};

// ─── Welcome state ──────────────────────────────────────────

describe("preview shell", () => {
  // The preview no longer draws its own version of the panel. It boots
  // the real `public/widget/gotcha-shopify-chat.js` in an iframe, so the
  // things worth asserting here are that it loads the RIGHT bundle, in a
  // real viewport, and never falls back to an imitation. What the widget
  // then renders is covered against the actual file in
  // storefront-widget.test.ts.
  function mountWith(props: Record<string, any> = {}) {
    return render(
      <WidgetPreview
        config={config()}
        device="desktop"
        state="welcome"
        language="en"
        sampleProducts={PREVIEW_FIXTURE}
        productsAreReal={false}
        {...props}
      />,
    );
  }

  beforeEach(() => {
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ chat: "gotcha-shopify-chat.abc123abc123.js" }),
    }));
  });

  it("renders the real widget in a frame instead of a copy of it", () => {
    // (case 57) The old preview was a React re-implementation and drifted:
    // it kept a full header the storefront had dropped and never learned
    // about the hero. A frame cannot drift, because it is the same file.
    const { container } = mountWith();
    expect(container.querySelector("iframe")).toBeTruthy();
    // No hand-built panel markup left behind.
    expect(screen.queryByText("Hi there")).toBeNull();
  });

  it("loads the content-hashed bundle named by the manifest", async () => {
    mountWith();
    await waitFor(() => expect((globalThis as any).fetch).toHaveBeenCalled());
    const [url, init] = (globalThis as any).fetch.mock.calls[0];
    expect(url).toBe("/widget/widget-manifest.json");
    // Hard-coding the bundle name is exactly how a stale widget reached a
    // live storefront once already.
    expect(init).toMatchObject({ cache: "no-cache" });
  });

  it("sandboxes the frame but keeps it same-origin so the widget can run", () => {
    const { container } = mountWith();
    const sandbox = container.querySelector("iframe")!.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
    // Withheld: the preview must not be able to navigate the dashboard.
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-popups");
  });

  it("gives mobile a real phone viewport rather than a narrow box", () => {
    // The widget switches layout on its own (max-width:560px) query, which
    // only fires if the frame is genuinely narrow.
    const { container } = mountWith({ device: "mobile" });
    const frame = container.querySelector("iframe")!.parentElement as HTMLElement;
    expect(frame.style.width).toBe("390px");
  });

  it("labels sample products, and says nothing when they are the merchant's own", () => {
    const sample = mountWith({ state: "product" });
    expect(screen.getByText(/Sample product/i)).toBeInTheDocument();
    sample.unmount();

    mountWith({ state: "product", productsAreReal: true });
    expect(screen.queryByText(/Sample product/i)).toBeNull();
  });

  it("says the preview is unavailable rather than drawing an imitation", async () => {
    // Showing a plausible-looking fake when the real widget cannot load is
    // worse than showing nothing: the merchant would tune and ship it.
    (globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    const { container } = mountWith();
    await waitFor(() => expect(container.querySelector("iframe")).toBeNull());
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });
});

describe("product card", () => {
  it("shows price, sale price and the recommendation reason", () => {
    // (case 22)
    render(<ProductCard product={IN_STOCK} />);
    expect(screen.getByText("Cloud Pro Runner")).toBeInTheDocument();
    expect(screen.getByText("$120")).toBeInTheDocument();
    expect(screen.getByText("$150")).toBeInTheDocument();
    expect(screen.getByText("-20%")).toBeInTheDocument();
    expect(screen.getByText("Lighter cushioning for long runs.")).toBeInTheDocument();
  });

  it("marks the sold-out variant and keeps it visible", () => {
    // (case 26) A hidden option reads as "we don't make that".
    render(<ProductCard product={IN_STOCK} />);
    const soldOutOption = screen.getByRole("button", { name: "42" });
    expect(soldOutOption).toBeDisabled();
    expect(screen.getByRole("button", { name: "41" })).toHaveAttribute("aria-pressed", "true");
  });

  it("presents Add to Cart as unavailable for an out-of-stock product", () => {
    const soldOut: ProductView = {
      ...IN_STOCK,
      available: false,
      selectedVariantId: "9002",
      variants: [{ variantId: "9002", title: "42", price: "120.00", compareAtPrice: null, available: false }],
    };
    render(<ProductCard product={soldOut} />);
    expect(screen.getByText("soldOut")).toBeInTheDocument();
    expect(screen.getByText("addToCart").className).toMatch(/text-gray-400/);
  });

  it("marks an unpublished product", () => {
    // (case 30)
    render(<ProductCard product={{ ...IN_STOCK, published: false, status: "draft" }} />);
    expect(screen.getByText("notPublished")).toBeInTheDocument();
  });

  it("opens the product in a new tab safely", () => {
    // (case 53)
    render(<ProductCard product={IN_STOCK} />);
    const link = screen.getByText("viewProduct").closest("a")!;
    expect(link).toHaveAttribute("href", IN_STOCK.productUrl);
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("lazy-loads product imagery", () => {
    // (case 21 of the performance list)
    const { container } = render(<ProductCard product={IN_STOCK} />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
  });

  it("renders without an image rather than breaking", () => {
    const { container } = render(<ProductCard product={{ ...IN_STOCK, imageUrl: null }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Cloud Pro Runner")).toBeInTheDocument();
  });

  it("is selectable as a button when used in the agent picker", () => {
    // (case 60)
    const onSelect = vi.fn();
    render(<ProductCard product={IN_STOCK} onSelect={onSelect} selected />);
    const card = screen.getAllByRole("button").find((b) => b.getAttribute("aria-pressed") === "true" && b.textContent?.includes("Cloud Pro"));
    expect(card).toBeTruthy();
  });
});

// ─── Carousel ───────────────────────────────────────────────

describe("product carousel", () => {
  it("renders every product", () => {
    // (case 23)
    render(
      <ProductCarousel
        products={[IN_STOCK, { ...IN_STOCK, productId: "222", title: "Trail Light" }, { ...IN_STOCK, productId: "333", title: "Road Max" }]}
      />,
    );
    expect(screen.getByText("Cloud Pro Runner")).toBeInTheDocument();
    expect(screen.getByText("Trail Light")).toBeInTheDocument();
    expect(screen.getByText("Road Max")).toBeInTheDocument();
  });

  it("scrolls inside its own container so it cannot widen the page", () => {
    // (case 62) A conversation column that scrolls sideways is broken.
    const { container } = render(<ProductCarousel products={[IN_STOCK, { ...IN_STOCK, productId: "222" }]} />);
    const scroller = container.querySelector(".overflow-x-auto")!;
    expect(scroller).toBeTruthy();
    expect(scroller.className).toContain("max-w-full");
  });
});

// ─── Money formatting ───────────────────────────────────────

describe("money", () => {
  it("formats in the product's own currency", () => {
    expect(formatMoney("120.00", "USD", "en")).toBe("$120");
    expect(formatMoney("120.50", "USD", "en")).toBe("$120.50");
  });

  it("renders nothing rather than NaN for a missing price", () => {
    expect(formatMoney(null, "USD", "en")).toBe("");
    expect(formatMoney("not-a-number", "USD", "en")).toBe("");
  });
});
