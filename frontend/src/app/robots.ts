import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/conversations/", "/login", "/settings/"],
      },
    ],
    sitemap: "https://gotcha.co.il/sitemap.xml",
  };
}
