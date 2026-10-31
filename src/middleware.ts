import { defineMiddleware } from "astro:middleware";
import { hreflangFor } from "./utils/i18n";

export const onRequest = defineMiddleware(async (context, next) => {
	let response = await next();

	// Preview and edit URLs are per-token, so a stored copy would outlive the
	// token. Components that render after the layout (WidgetArea, for one) set
	// their own cache hint, so the opt-out has to come last in the request.
	if (context.url.searchParams.has("_preview") || context.url.searchParams.has("_edit")) {
		context.cache?.set(false);
		response.headers.set("Cache-Control", "private, no-store");
	}

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
