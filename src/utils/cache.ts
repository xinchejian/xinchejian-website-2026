import type { AstroGlobal } from "astro";
import type { CacheHint } from "emdash";

/**
 * Hand query hints to Astro's route cache.
 *
 * Preview and edit URLs are per-token, so a stored copy would outlive the token
 * and could serve a draft after it expires. The route-cache opt-out therefore
 * has to win over every hint on the page, which means routing each call through
 * here instead of calling `Astro.cache.set()` directly.
 */
export function setRouteCache(astro: AstroGlobal, hint: CacheHint | undefined): void {
	const cache = astro.cache;
	if (!cache?.enabled) return;
	if (astro.url.searchParams.has("_preview") || astro.url.searchParams.has("_edit")) {
		cache.set(false);
		return;
	}
	if (hint) cache.set(hint);
}
