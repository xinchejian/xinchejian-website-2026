import { defineMiddleware } from "astro:middleware";

// qTranslate-X addressed Chinese pages as ?lang=zh on the English URL. Send
// those to the /zh/ path before EmDash's redirect table (which drops the
// query string) maps the old WordPress permalink to the new post.
export const onRequest = defineMiddleware((context, next) => {
	const { url } = context;
	if (
		url.searchParams.get("lang") === "zh" &&
		!url.pathname.startsWith("/zh/") &&
		url.pathname !== "/zh" &&
		!url.pathname.startsWith("/_emdash")
	) {
		url.searchParams.delete("lang");
		const path = url.pathname === "/" ? "" : url.pathname;
		return context.redirect(`/zh${path}${url.search}`, 301);
	}
	return next();
});
