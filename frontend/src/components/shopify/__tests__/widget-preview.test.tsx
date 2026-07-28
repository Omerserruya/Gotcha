/**
 * Shopify Live Chat — dashboard UI.
 *
 * Covers what a merchant and an agent actually see: the branded welcome
 * state in both directions, product cards that tell the truth about
 * stock, a carousel that cannot widen the page, and keyboard access.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

describe("welcome state", () => {
  it("renders the merchant's branding and suggested questions in English LTR", () => {
    // (case 57)
    const { container } = render(
      <WidgetPreview
        config={config()}
        device="desktop"
        state="welcome"
        language="en"
        sampleProducts={PREVIEW_FIXTURE}
        productsAreReal={false}
      />,
    );
    expect(screen.getByText("Hi there")).toBeInTheDocument();
    expect(screen.getByText("Store Assistant")).toBeInTheDocument();
    expect(screen.getByText("Which product is right for me?")).toBeInTheDocument();
    expect(container.querySelector('[dir="ltr"]')).toBeTruthy();
    expect(screen.getByText("Online")).toBeInTheDocument();
  });

  it("renders right to left for Hebrew", () => {
    // (case 56)
    const { container } = render(
      <WidgetPreview
        config={config()}
        device="desktop"
        state="welcome"
        language="he"
        sampleProducts={PREVIEW_FIXTURE}
        productsAreReal={false}
      />,
    );
    const panel = container.querySelector('[dir="rtl"]');
    expect(panel).toBeTruthy();
    expect(panel!.getAttribute("lang")).toBe("he");
    expect(screen.getByText("זמינים")).toBeInTheDocument();
  });

  it("shows the away message and status when outside business hours", () => {
    // (case 21)
    render(
      <WidgetPreview
        config={config()}
        device="desktop"
        state="offline"
        language="en"
        sampleProducts={PREVIEW_FIXTURE}
        productsAreReal={false}
      />,
    );
    expect(screen.getByText("Away")).toBeInTheDocument();
    expect(screen.getByText("We are away right now.")).toBeInTheDocument();
  });

  it("uses a full-height frame on mobile and a compact panel on desktop", () => {
    // (cases 58, 59)
    const mobile = render(
      <WidgetPreview config={config()} device="mobile" state="welcome" language="en" sampleProducts={PREVIEW_FIXTURE} productsAreReal={false} />,
    );
    expect(mobile.container.querySelector(".h-\\[600px\\]")).toBeTruthy();
    mobile.unmount();

    const desktop = render(
      <WidgetPreview config={config()} device="desktop" state="welcome" language="en" sampleProducts={PREVIEW_FIXTURE} productsAreReal={false} />,
    );
    expect(desktop.container.querySelector(".w-\\[392px\\]")).toBeTruthy();
  });

  it("hides the powered-by line when the merchant turned it off", () => {
    render(
      <WidgetPreview
        config={config({ appearance: { showPoweredBy: false } })}
        device="desktop"
        state="welcome"
        language="en"
        sampleProducts={PREVIEW_FIXTURE}
        productsAreReal={false}
      />,
    );
    expect(screen.queryByText("Powered by GOTCHA")).not.toBeInTheDocument();
  });

  it("labels a fixture product as a sample rather than passing it off as real", () => {
    // A preview that shows invented products unlabelled is a lie.
    render(
      <WidgetPreview
        config={config()}
        device="desktop"
        state="product"
        language="en"
        sampleProducts={PREVIEW_FIXTURE}
        productsAreReal={false}
      />,
    );
    expect(screen.getByText(/connect a store with products to preview your own/i)).toBeInTheDocument();
  });

  it("says nothing about samples when the products are the merchant's own", () => {
    render(
      <WidgetPreview
        config={config()}
        device="desktop"
        state="product"
        language="en"
        sampleProducts={[IN_STOCK]}
        productsAreReal
      />,
    );
    expect(screen.queryByText(/connect a store with products/i)).not.toBeInTheDocument();
    expect(screen.getByText("Cloud Pro Runner")).toBeInTheDocument();
  });
});

// ─── Product card ───────────────────────────────────────────

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
