import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  // Interview and report pages are private links; keep them out of search results.
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/interview/", "/report/"] }] };
}
