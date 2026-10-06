/**
 * EmDash returns query failures as data (`error`) rather than throwing, so a
 * page that ignores it renders an empty list — or redirects to 404 — for what
 * is really a server fault, and that degraded response is what a cache stores.
 * Rethrow so the request fails loudly as a 500 instead.
 *
 * A missing entry is not an error: `entry` is null and `error` is undefined.
 */
export function assertContent(result: { error?: Error } | null | undefined): void {
	if (result?.error) throw result.error;
}
