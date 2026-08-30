import { describe, it, expect } from "vitest";
import { mapProduct, mapVariant } from "../services/connectors/shopify-gql-products";

/**
 * The product shape is a contract, not an implementation detail.
 *
 * `get_product` used to return Shopify's raw REST product, and four different
 * consumers learned to read it: the catalogue facets, the discovery profile,
 * the exchange quote and the live-chat product card. None of them are exercised
 * by a fixture of a GraphQL response - they read the keys BELOW, so those are
 * what these tests pin.
 *
 * The two that would fail silently rather than loudly, and so get the most
 * attention here, are `inventory_management` (a boolean in GraphQL, a string or
 * null in REST, and the input to every in-stock decision) and the numeric ids.
 */

const variantNode = {
  legacyResourceId: "44444",
  title: "159cm",
  sku: "SNOW-159",
  price: "749.95",
  compareAtPrice: "899.95",
  availableForSale: true,
  inventoryQuantity: 3,
  inventoryPolicy: "DENY",
  selectedOptions: [{ name: "Size", value: "159cm" }, { name: "Color", value: "Liquid" }],
  inventoryItem: { tracked: true },
};

const productNode = {
  legacyResourceId: "111",
  title: "The Collection Snowboard: Liquid",
  handle: "the-collection-snowboard-liquid",
  status: "ACTIVE",
  vendor: "Urban Supply",
  productType: "Snowboard",
  tags: ["winter", "sale"],
  featuredImage: { url: "https://cdn.example.com/featured.jpg" },
  images: { nodes: [{ url: "https://cdn.example.com/1.jpg" }, { url: "https://cdn.example.com/2.jpg" }] },
  options: [{ name: "Size" }, { name: "Color" }],
  variants: { nodes: [variantNode] },
};

describe("variant mapping", () => {
  it("produces the REST variant keys callers already read", () => {
    expect(mapVariant(variantNode, 111)).toEqual({
      id: 44444,
      product_id: 111,
      title: "159cm",
      sku: "SNOW-159",
      price: "749.95",
      compare_at_price: "899.95",
      available: true,
      inventory_quantity: 3,
      inventory_policy: "deny",
      inventory_management: "shopify",
      option1: "159cm",
      option2: "Liquid",
      option3: null,
    });
  });

  // The single most consequential translation in this family. Callers decide
  // stock with `inventory_management == null || quantity > 0`: a boolean `true`
  // left in that field reads as tracked (fine), but a boolean `false` would
  // ALSO read as tracked and turn an always-available product into a sold-out
  // one.
  it("translates tracked:false back to null, not to false", () => {
    const v = mapVariant({ ...variantNode, inventoryItem: { tracked: false }, inventoryQuantity: 0 });
    expect(v.inventory_management).toBeNull();
    expect(v.inventory_management == null || Number(v.inventory_quantity) > 0).toBe(true);
  });

  it("treats a tracked variant with no stock as out of stock", () => {
    const v = mapVariant({ ...variantNode, inventoryItem: { tracked: true }, inventoryQuantity: 0 });
    expect(v.inventory_management).toBe("shopify");
    expect(v.inventory_management == null || Number(v.inventory_quantity) > 0).toBe(false);
  });

  // A query without read_inventory omits inventoryItem entirely; that must not
  // crash, and must not claim the variant is tracked.
  it("survives a response with no inventoryItem at all", () => {
    const { inventoryItem, ...withoutInventory } = variantNode;
    expect(mapVariant(withoutInventory).inventory_management).toBeNull();
  });

  it("reads product_id off the variant's own product when not passed one", () => {
    expect(mapVariant({ ...variantNode, product: { legacyResourceId: "999" } }).product_id).toBe(999);
  });

  it("returns ids as numbers, never as gids or numeric strings", () => {
    const v = mapVariant(variantNode, 111);
    expect(typeof v.id).toBe("number");
    expect(typeof v.product_id).toBe("number");
  });

  it("maps selectedOptions positionally onto option1..3", () => {
    const v = mapVariant({ selectedOptions: [{ value: "A" }, { value: "B" }, { value: "C" }, { value: "D" }] });
    expect([v.option1, v.option2, v.option3]).toEqual(["A", "B", "C"]);
  });

  it("keeps price as a decimal STRING - callers parse it and money is not a float", () => {
    expect(mapVariant(variantNode).price).toBe("749.95");
  });
});

describe("product mapping", () => {
  it("produces the REST product keys, with a lowercase status", () => {
    const p = mapProduct(productNode);
    expect(p.id).toBe(111);
    expect(p.status).toBe("active");
    expect(p.product_type).toBe("Snowboard");
    expect(p.handle).toBe("the-collection-snowboard-liquid");
    expect(p.options).toEqual([{ name: "Size" }, { name: "Color" }]);
  });

  it("stamps the product id onto every variant", () => {
    expect(mapProduct(productNode).variants.every((v) => v.product_id === 111)).toBe(true);
  });

  it("prefers the featured image and falls back to the first image", () => {
    expect(mapProduct(productNode).image).toEqual({ src: "https://cdn.example.com/featured.jpg" });
    const { featuredImage, ...noFeatured } = productNode;
    expect(mapProduct(noFeatured).image).toEqual({ src: "https://cdn.example.com/1.jpg" });
  });

  it("reports no image rather than an empty object when the product has none", () => {
    expect(mapProduct({ ...productNode, featuredImage: null, images: { nodes: [] } }).image).toBeNull();
  });

  // The facet builder reads tags to tell the model which tags exist. A string
  // there would be split per character by nothing, or worse, treated as one tag.
  it("returns tags as an array, whichever way Shopify sent them", () => {
    expect(mapProduct(productNode).tags).toEqual(["winter", "sale"]);
    expect(mapProduct({ ...productNode, tags: "winter, sale" }).tags).toEqual(["winter", "sale"]);
    expect(mapProduct({ ...productNode, tags: null }).tags).toEqual([]);
  });

  it("returns empty collections rather than undefined for a bare product", () => {
    const p = mapProduct({ legacyResourceId: "5", title: "Bare" });
    expect(p.variants).toEqual([]);
    expect(p.images).toEqual([]);
    expect(p.options).toEqual([]);
    expect(p.image).toBeNull();
  });

  // `variant_information` answers "does this come in another size?" by reading
  // option_names off the product. A product with one Default Title variant
  // varies by nothing, and that is the whole answer.
  it("keeps a single-variant product's shape intact for the no-options answer", () => {
    const p = mapProduct({
      legacyResourceId: "7",
      title: "One Size Only",
      options: [{ name: "Title" }],
      variants: { nodes: [{ legacyResourceId: "8", title: "Default Title", selectedOptions: [{ value: "Default Title" }] }] },
    });
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0].title).toBe("Default Title");
    expect(p.options.map((o) => o.name)).toEqual(["Title"]);
  });
});
