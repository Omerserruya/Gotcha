"use client";

import clsx from "clsx";
import {
  previewCapabilitiesFor,
  previewLimitations,
  previewPresentation,
  type PreviewPresentation,
} from "@/lib/recommendation-preview-client";
import type { ProductView } from "./ProductCard";

/**
 * What the customer is about to receive.
 *
 * The composer used to show an agent a generic list and then send a
 * carousel, which meant the one person who could catch a bad
 * recommendation before it went out was looking at something the customer
 * would never see. This shows the actual shape: the presentation the
 * channel will use, the products in the order they will appear, and every
 * limitation that will silently change the message.
 *
 * The channel decision is restated in `lib/recommendation-preview-client`
 * and kept honest by a parity test against the server's renderer.
 */

interface Props {
  channel: string;
  products: ProductView[];
  onRemove: (productId: string) => void;
  onReorder: (productId: string, direction: -1 | 1) => void;
}

const PRESENTATION_LABELS: Record<PreviewPresentation, string> = {
  native_catalog: "Native catalog message",
  native_carousel: "Product carousel",
  rich_html: "HTML product cards",
  cards: "Product card",
  image_cards: "Image cards",
  link_buttons: "Link buttons",
  quick_replies: "Reply buttons",
  speech: "Spoken summary",
  text: "Text list",
};

export function RecommendationPreview({ channel, products, onRemove, onReorder }: Props) {
  const caps = previewCapabilitiesFor(channel);
  const hasAnyImage = products.some((p) => !!p.imageUrl);
  const presentation = previewPresentation(caps, products.length, hasAnyImage);
  const limit = caps.maxCards ?? products.length;
  const included = products.slice(0, limit);
  const dropped = products.slice(limit);
  const limitations = previewLimitations(caps, presentation, products.length);

  if (!products.length) return null;

  return (
    <div
      data-testid="recommendation-preview"
      data-presentation={presentation}
      className="border border-gray-200 rounded-xl overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
        <span className="text-xs font-medium text-gray-700">
          {PRESENTATION_LABELS[presentation]}
        </span>
        <span className="text-[11px] text-gray-400">{channel.replace(/_/g, " ").toLowerCase()}</span>
      </div>

      {/* The carousel preview scrolls the way the customer's will. */}
      <ul
        className={clsx(
          "list-none m-0 p-2 gap-2",
          presentation === "native_carousel"
            ? "flex overflow-x-auto"
            : "flex flex-col",
        )}
      >
        {included.map((p, i) => (
          <li
            key={p.productId}
            data-testid="preview-product"
            className={clsx(
              "flex items-center gap-2 border border-gray-100 rounded-lg p-2 bg-white",
              presentation === "native_carousel" ? "min-w-[180px] flex-col items-start" : "",
            )}
          >
            {p.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={p.imageUrl}
                alt=""
                className="w-10 h-10 rounded object-cover flex-shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded bg-gray-100 flex-shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-gray-900 truncate" dir="auto">
                {p.title}
              </p>
              {p.price != null && (
                // A price is always read left to right, whatever surrounds it.
                <bdi dir="ltr" className="text-[11px] text-gray-500">
                  {p.price} {p.currency}
                </bdi>
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                type="button"
                aria-label={`Move ${p.title} earlier`}
                disabled={i === 0}
                onClick={() => onReorder(p.productId, -1)}
                className="text-xs px-1.5 py-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${p.title} later`}
                disabled={i === included.length - 1}
                onClick={() => onReorder(p.productId, 1)}
                className="text-xs px-1.5 py-1 rounded text-gray-500 hover:bg-gray-100 disabled:opacity-30"
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove ${p.title}`}
                onClick={() => onRemove(p.productId)}
                className="text-xs px-1.5 py-1 rounded text-gray-500 hover:bg-red-50 hover:text-red-600"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>

      {dropped.length > 0 && (
        <ul data-testid="preview-dropped" className="px-3 pb-2 m-0 list-none">
          {dropped.map((p) => (
            <li key={p.productId} className="text-[11px] text-amber-700 truncate" dir="auto">
              {p.title} will not be sent
            </li>
          ))}
        </ul>
      )}

      {limitations.length > 0 && (
        <ul
          data-testid="preview-limitations"
          className="px-3 py-2 m-0 list-none border-t border-gray-100 bg-amber-50/50 space-y-1"
        >
          {limitations.map((note) => (
            <li key={note} className="text-[11px] text-amber-800">
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
