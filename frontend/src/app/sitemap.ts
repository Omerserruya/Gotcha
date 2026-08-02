import type { MetadataRoute } from "next";
import { PUBLIC_LEGAL_DOCS } from "./legal/content/registry";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://gotcha.co.il";

  return [
    { url: baseUrl, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${baseUrl}/en`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    { url: `${baseUrl}/he`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    { url: `${baseUrl}/early-access`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.8 },
    { url: `${baseUrl}/legal`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.4 },
    // Canonical document URLs. /terms and /privacy-policy are 308 redirects and
    // are deliberately absent: a sitemap should not point a crawler at a
    // redirect, and the registry keeps this list honest as documents change.
    ...PUBLIC_LEGAL_DOCS.map((d) => ({
      url: `${baseUrl}/legal/${d.slug}`,
      lastModified: new Date(),
      changeFrequency: "monthly" as const,
      priority: 0.3,
    })),
  ];
}
