import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocView } from "./DocView";
import { PUBLIC_LEGAL_DOCS, isPublicLegalDoc } from "../content/registry";
import { LEGAL_CONTENT } from "../content/generated";

/** Only published documents get a route. An internal record such as the RoPA has
 *  no page at all, rather than a page that happens to 404. */
export function generateStaticParams() {
  return PUBLIC_LEGAL_DOCS.map((d) => ({ slug: d.slug }));
}

export const dynamicParams = false;

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const doc = LEGAL_CONTENT[params.slug]?.en;
  if (!doc) return { title: "Trust Center | GOTCHA" };
  return {
    title: `${doc.title} | GOTCHA`,
    description: `${doc.title}. Effective ${doc.effectiveDate}. Published in Hebrew and English.`,
  };
}

export default function LegalDocPage({ params }: { params: { slug: string } }) {
  if (!isPublicLegalDoc(params.slug) || !LEGAL_CONTENT[params.slug]) notFound();
  return <DocView slug={params.slug} />;
}
