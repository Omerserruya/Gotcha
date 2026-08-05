/**
 * The agent composer preview.
 *
 * The failure it exists to prevent: the agent approves a generic text
 * list and the customer receives a carousel, or the agent selects five
 * products for WhatsApp and only three arrive. Either way the one person
 * who could have caught it was looking at something else.
 */
import { describe, it, expect, vi } from "vitest";
// fireEvent, not user-event: the repo has no new-dependency budget and a
// click is a click.
import { render, screen, within, fireEvent } from "@testing-library/react";
import { RecommendationPreview } from "../RecommendationPreview";
import type { ProductView } from "../ProductCard";

const SHOP = "demo-store.myshopify.com";

function product(i: number, overrides: Partial<ProductView> = {}): ProductView {
  return {
    productId: String(100 + i),
    handle: `p-${i}`,
    title: `Product ${i}`,
    imageUrl: `https://cdn.shopify.com/s/files/1/${i}.jpg`,
    productUrl: `https://${SHOP}/products/p-${i}`,
    currency: "ILS",
    price: "120.00",
    compareAtPrice: null,
    available: true,
    published: true,
    selectedVariantId: null,
    optionNames: [],
    variants: [],
    reason: null,
    ...overrides,
  } as ProductView;
}

function setup(channel: string, products: ProductView[]) {
  const onRemove = vi.fn();
  const onReorder = vi.fn();
  render(
    <RecommendationPreview
      channel={channel}
      products={products}
      onRemove={onRemove}
      onReorder={onReorder}
    />,
  );
  return { onRemove, onReorder };
}

describe("presentation is named, not implied", () => {
  it("says carousel on the storefront", () => {
    setup("SHOPIFY_LIVE_CHAT", [product(1), product(2)]);
    expect(screen.getByTestId("recommendation-preview")).toHaveAttribute(
      "data-presentation",
      "native_carousel",
    );
    expect(screen.getByText("Product carousel")).toBeInTheDocument();
  });

  it("says image cards on WhatsApp, because that is what arrives", () => {
    setup("WHATSAPP", [product(1), product(2)]);
    expect(screen.getByTestId("recommendation-preview")).toHaveAttribute(
      "data-presentation",
      "image_cards",
    );
    expect(screen.getByText("Image cards")).toBeInTheDocument();
  });

  it("says text list on SMS", () => {
    setup("SMS", [product(1)]);
    expect(screen.getByText("Text list")).toBeInTheDocument();
  });

  it("says HTML cards on email", () => {
    setup("EMAIL", [product(1), product(2)]);
    expect(screen.getByText("HTML product cards")).toBeInTheDocument();
  });

  it("a single storefront product is one card, not a carousel of one", () => {
    setup("SHOPIFY_LIVE_CHAT", [product(1)]);
    expect(screen.getByTestId("recommendation-preview")).toHaveAttribute(
      "data-presentation",
      "cards",
    );
  });
});

describe("channel limits are visible BEFORE the send", () => {
  it("names the products WhatsApp will drop", () => {
    setup("WHATSAPP", [product(1), product(2), product(3), product(4), product(5)]);
    expect(screen.getAllByTestId("preview-product")).toHaveLength(3);
    const dropped = within(screen.getByTestId("preview-dropped"));
    expect(dropped.getByText("Product 4 will not be sent")).toBeInTheDocument();
    expect(dropped.getByText("Product 5 will not be sent")).toBeInTheDocument();
    expect(screen.getByTestId("preview-limitations").textContent).toContain(
      "Only 3 of 5 will be sent",
    );
  });

  it("says WhatsApp has no link buttons", () => {
    setup("WHATSAPP", [product(1)]);
    expect(screen.getByTestId("preview-limitations").textContent).toContain("No link buttons");
  });

  it("says Add to cart is unavailable off the storefront", () => {
    setup("WHATSAPP", [product(1)]);
    expect(screen.getByTestId("preview-limitations").textContent).toContain(
      "Add to cart is not available",
    );
  });

  it("says nothing about Add to cart on the storefront", () => {
    setup("SHOPIFY_LIVE_CHAT", [product(1), product(2)]);
    const limitations = screen.queryByTestId("preview-limitations");
    expect(limitations?.textContent ?? "").not.toContain("Add to cart is not available");
  });

  it("warns that voice cannot carry links", () => {
    setup("VOICE", [product(1)]);
    expect(screen.getByTestId("preview-limitations").textContent).toContain("Voice carries no links");
  });
});

describe("the agent can change the selection", () => {
  it("removes a product", () => {
    const { onRemove } = setup("SHOPIFY_LIVE_CHAT", [product(1), product(2)]);
    fireEvent.click(screen.getByLabelText("Remove Product 1"));
    expect(onRemove).toHaveBeenCalledWith("101");
  });

  it("reorders a product", () => {
    const { onReorder } = setup("SHOPIFY_LIVE_CHAT", [product(1), product(2)]);
    fireEvent.click(screen.getByLabelText("Move Product 2 earlier"));
    expect(onReorder).toHaveBeenCalledWith("102", -1);
  });

  it("cannot move the first product earlier or the last one later", () => {
    setup("SHOPIFY_LIVE_CHAT", [product(1), product(2)]);
    expect(screen.getByLabelText("Move Product 1 earlier")).toBeDisabled();
    expect(screen.getByLabelText("Move Product 2 later")).toBeDisabled();
  });
});

describe("RTL and prices", () => {
  it("lets a Hebrew title resolve its own direction", () => {
    setup("SHOPIFY_LIVE_CHAT", [product(1, { title: "נעלי ריצה" }), product(2)]);
    expect(screen.getByText("נעלי ריצה")).toHaveAttribute("dir", "auto");
  });

  it("pins the price left-to-right so the currency cannot move", () => {
    setup("SHOPIFY_LIVE_CHAT", [product(1, { title: "נעלי ריצה" }), product(2)]);
    const price = screen.getAllByText(/120\.00 ILS/)[0];
    expect(price.tagName.toLowerCase()).toBe("bdi");
    expect(price).toHaveAttribute("dir", "ltr");
  });
});

describe("nothing to preview", () => {
  it("renders nothing with no products", () => {
    setup("SHOPIFY_LIVE_CHAT", []);
    expect(screen.queryByTestId("recommendation-preview")).toBeNull();
  });
});
