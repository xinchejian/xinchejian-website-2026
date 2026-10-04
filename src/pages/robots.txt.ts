import type { APIRoute } from "astro";
import { getSiteSettings } from "emdash";

// EmDash's default robots.txt disallows all of /_emdash/, but every image the
// site serves — post bodies, featured images, the og:image on each page and the
// entries in the image sitemaps — lives under /_emdash/api/media/file/. Serving
// that blanket rule tells Googlebot to crawl URLs it may not fetch and to drop
// the images from Google Images.
//
// Crawlers match the longest rule that applies to a path, so re-allowing the
// media subtree wins for images while the admin UI, the JSON API and the MCP
// endpoint stay out of the index. EmDash serves this route in place of its own
// when the file exists (see docs: "To serve your own version, add a route file
// such as src/pages/robots.txt.ts").
const ALLOWED_API_SUBTREE = "/_emdash/api/media/";

export const GET: APIRoute = async ({ url }) => {
	// Same precedence EmDash uses: the Site URL setting first (so the beta
	// advertises the production sitemap), then the request origin.
	const settings = await getSiteSettings().catch(() => null);
	const origin = (settings?.url || url.origin).replace(/\/$/, "");

	// Most specific first: a crawler using longest-match (Google, Bing) picks
	// the media rule over the blanket one, and a crawler using the older
	// first-match rule reaches the media rule before it reaches the disallow.
	const body = `User-agent: *
# Public media, served from under the API prefix.
Allow: ${ALLOWED_API_SUBTREE}
# Everything else under the admin and API prefix stays out of the index.
Disallow: /_emdash/
Allow: /

Sitemap: ${origin}/sitemap.xml
`;

	return new Response(body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=86400",
		},
	});
};
