import { defineMiddleware } from "astro:middleware";
import { hreflangFor } from "./utils/i18n";

export const onRequest = defineMiddleware(async (context, next) => {
	let response = await next();

	// EmDashHead emits hreflang with the stored locale codes ("en", "zh");
	// rewrite them to the region-qualified tags (en-US, zh-CN).
	if (response.headers.get("content-type")?.includes("text/html")) {
		response = new HTMLRewriter()
			.on("link[rel=alternate][hreflang]", {
				element(link) {
					const code = link.getAttribute("hreflang");
					if (code) link.setAttribute("hreflang", hreflangFor(code));
				},
			})
			.transform(response);
	} else if (/^\/sitemap-[^/]+\.xml$/.test(context.url.pathname) && response.ok) {
		// Same mapping for the xhtml:link alternates in EmDash's sitemaps.
		const xml = (await response.text()).replace(/hreflang="([^"]+)"/g, (_, code: string) => `hreflang="${hreflangFor(code)}"`);
		response = new Response(xml, response);
	}

	// Keep the beta copy out of search results while xinchejian.com is live.
	if (context.url.hostname.startsWith("beta.")) {
		response.headers.set("X-Robots-Tag", "noindex, nofollow");
	}
	return response;
});
