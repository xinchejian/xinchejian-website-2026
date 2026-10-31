import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import react from "@astrojs/react";
import { d1, kvCache, r2 } from "@emdash-cms/cloudflare";
import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";

// Chinese pages reuse the English page files under a /zh prefix, so
// Astro.currentLocale is "zh" and EmDash queries resolve Chinese entries.
const LOCALIZED_ROUTES = {
	"/": "index.astro",
	"/posts": "posts/index.astro",
	"/[year]/[month]/[slug]": "[year]/[month]/[slug].astro",
	"/[slug]": "[slug].astro",
	"/posts/[slug]": "posts/[slug].astro",
	"/pages/[slug]": "pages/[slug].astro",
	"/category/[slug]": "category/[slug].astro",
	"/tag/[slug]": "tag/[slug].astro",
	"/search": "search.astro",
	"/rss.xml": "rss.xml.ts",
};

function localizedRoutes(locales) {
	return {
		name: "xcj-i18n",
		hooks: {
			"astro:config:setup": ({ injectRoute, addMiddleware }) => {
				// Order matters: the host rule must run first, or a lang redirect
				// on www resolves its relative target against the www origin.
				addMiddleware({ entrypoint: new URL("./src/host-redirect.ts", import.meta.url), order: "pre" });
				addMiddleware({ entrypoint: new URL("./src/lang-redirect.ts", import.meta.url), order: "pre" });
				for (const locale of locales) {
					for (const [pattern, file] of Object.entries(LOCALIZED_ROUTES)) {
						injectRoute({
							pattern: `/${locale}${pattern === "/" ? "" : pattern}`,
							entrypoint: `./src/pages/${file}`,
						});
					}
				}
			},
		},
	};
}

// Staging previews production's content (they share the database), so its
// cached reads have to turn over quickly; KV floors an expiry at 60s.
// Production keeps the default hour.
const isStaging = process.env.CLOUDFLARE_ENV === "beta";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	// Anonymous pages are served from Cloudflare's Workers Cache, so a cache hit
	// never runs the Worker. That matters here: a new isolate spends 200ms to 9s
	// initialising the database before the first byte, which is what pushed LCP
	// past five seconds. EmDash invalidates the collection tags below (plus the
	// chrome tags the layout passes to Astro.cache) on publish, so maxAge only
	// bounds how long a page can stay stale when a purge fails.
	cache: {
		provider: cacheCloudflare(),
	},
	// Public routes only, and listed one by one: a root rest parameter would
	// also match /_emdash. Each rule names the collection it renders, which is
	// the tag EmDash invalidates on a write.
	routeRules: {
		"/": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/zh": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/posts": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/zh/posts": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/posts/[slug]": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/zh/posts/[slug]": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/[year]/[month]/[slug]": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/zh/[year]/[month]/[slug]": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/category/[slug]": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/zh/category/[slug]": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/tag/[slug]": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/zh/tag/[slug]": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/[slug]": { maxAge: 3600, swr: 86400, tags: ["pages"] },
		"/zh/[slug]": { maxAge: 3600, swr: 86400, tags: ["pages"] },
		"/pages/[slug]": { maxAge: 3600, swr: 86400, tags: ["pages"] },
		"/zh/pages/[slug]": { maxAge: 3600, swr: 86400, tags: ["pages"] },
		"/search": { maxAge: 300, swr: 3600, tags: ["posts", "pages"] },
		"/zh/search": { maxAge: 300, swr: 3600, tags: ["posts", "pages"] },
		"/rss.xml": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/zh/rss.xml": { maxAge: 3600, swr: 86400, tags: ["posts"] },
		"/robots.txt": { maxAge: 86400, swr: 86400, tags: ["posts", "pages"] },
	},
	// English is served unprefixed; Chinese lives under /zh/. EmDash's admin
	// breaks if the default locale is prefixed, so leave `routing` unset.
	i18n: {
		defaultLocale: "en",
		locales: ["en", "zh"],
		fallback: { zh: "en" },
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		localizedRoutes(["zh"]),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			// Editors get the edit pill from a small script, so cached anonymous
			// pages still show it without the cache having to store a per-editor
			// variant. Required companion to route caching; see
			// https://docs.emdashcms.com/deployment/route-caching/
			toolbar: "client",
			// Content, settings, menu and taxonomy reads are cached in KV rather
			// than hitting D1 on every render. The binding and both namespaces
			// are declared in wrangler.jsonc.
			objectCache: kvCache({
				binding: "CACHE",
				...(isStaging ? { defaultTtl: 60 } : {}),
			}),
			// Magic-link sign-in and account recovery. The domain must be
			// onboarded for Cloudflare Email Sending, and the plugin activated
			// under Extensions and selected under Settings -> Email.
			plugins: [
				cloudflareEmail({
					from: { email: "it@xinchejian.com", name: "新车间 XinCheJian" },
				}),
			],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
