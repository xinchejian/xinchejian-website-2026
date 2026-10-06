import cloudflare from "@astrojs/cloudflare";
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
