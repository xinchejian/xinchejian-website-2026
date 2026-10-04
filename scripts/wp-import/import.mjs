#!/usr/bin/env node
// Push an import plan (from transform.mjs) into a running EmDash site through
// its HTTP API: media, taxonomy terms, bylines, posts/pages and redirects.
// Safe to re-run: existing media, terms and entries are skipped, and the
// migration redirects are reconciled with the plan.
//
// Usage: node scripts/wp-import/import.mjs --uploads <wp-content/uploads> [--plan .import/plan.json]
//        [--url http://localhost:4321] [--limit N] [--only posts|pages|redirects] [--sync-dates]
//        [--repair-upload-links]
// Auth: EMDASH_TOKEN (API token with content, media, taxonomy and redirect
// permissions); omitted for localhost, where the dev bypass is used.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { EmDashClient } from "emdash/client";
import { mediaForUpload, rewriteUploadLinks, uploadKeys } from "./lib/uploads.mjs";

const { values: args } = parseArgs({
	options: {
		plan: { type: "string", default: ".import/plan.json" },
		uploads: { type: "string" },
		url: { type: "string", default: process.env.EMDASH_URL ?? "http://localhost:4321" },
		limit: { type: "string" },
		only: { type: "string" },
		concurrency: { type: "string", default: "2" },
		// Re-apply publish dates to entries that already exist (sites imported
		// before dates switched from UTC to Shanghai wall-clock time).
		"sync-dates": { type: "boolean", default: false },
		// Re-write the body of entries that already exist, so a change to how the
		// transform builds content reaches entries imported before it. Only
		// entries whose block structure actually differs are written.
		"refresh-content": { type: "boolean", default: false },
		// Report what --refresh-content would change, and write nothing.
		"dry-run": { type: "boolean", default: false },
		// Point stored links that still address the old WordPress uploads at the
		// media the site serves, editing nothing else. Reaches entries
		// --refresh-content skips, and needs no uploads archive.
		"repair-upload-links": { type: "boolean", default: false },
	},
});
if (!args.uploads && args.only !== "redirects" && !args["repair-upload-links"]) {
	throw new Error("--uploads <path to wp-content/uploads> is required");
}

const UPLOAD_PREFIX = "wp-upload:";
const LEGACY_UPLOADS_URL = "https://xinchejian.com/wp-content/uploads/";
const baseUrl = args.url.replace(/\/$/, "");
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseUrl);
const client = new EmDashClient({ baseUrl, token: process.env.EMDASH_TOKEN, devBypass: isLocal && !process.env.EMDASH_TOKEN });

// The Worker returns 503 "Service Unavailable" when a request blows its CPU
// limit (image processing on upload is the usual culprit) and 429 when
// throttled. Both are transient, so back off and retry rather than dropping the
// item. The status lives on the error's `status`, not in its message.
const RETRYABLE = /service unavailable|too many requests|ECONNRESET|fetch failed|terminated|socket hang up|timed out/i;

const isRetryable = (error) =>
	(typeof error.status === "number" && (error.status === 429 || error.status >= 500)) || RETRYABLE.test(error.message ?? "");

async function withRetry(fn, label, attempts = 8) {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (error) {
			if (i >= attempts || !isRetryable(error)) throw error;
			const wait = Math.min(1000 * 2 ** (i - 1), 20000) + Math.random() * 500;
			console.warn(`  retry ${i}/${attempts - 1} ${label}: ${error.message} (wait ${Math.round(wait)}ms)`);
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
	}
}

// The typed client does not expose every endpoint (bylines, redirects, term
// locales), so share its authenticated transport for those calls.
async function api(method, path, body) {
	return withRetry(
		async () => {
			try {
				return await client.request(method, path, body);
			} catch (error) {
				error.status ??= error.response?.status ?? Number(String(error.message).match(/\b(4\d\d|5\d\d)\b/)?.[1]);
				if (error.details) error.message += ` ${JSON.stringify(error.details)}`;
				throw error;
			}
		},
		`${method} ${path}`,
	);
}

const plan = JSON.parse(await readFile(args.plan, "utf8"));
const statePath = join(dirname(args.plan), `state-${new URL(baseUrl).host.replace(/[^a-z0-9.-]/gi, "_")}.json`);
const state = existsSync(statePath) ? JSON.parse(await readFile(statePath, "utf8")) : {};
state.media ??= {};
state.entries ??= {};
state.terms ??= {};
state.bylines ??= {};
// Concurrent progress saves race: a stale snapshot can land after a newer one
// and truncate the record of what has been imported. Chain the writes so the
// last write always carries the latest state.
let saveChain = Promise.resolve();
const saveState = () => (saveChain = saveChain.then(() => writeFile(statePath, JSON.stringify(state, null, 1))));
const problems = { missingFiles: new Set(), failedUploads: [], failedEntries: [], failedRedirects: [] };

async function pool(items, size, fn) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		}),
	);
}

// --- Media ---------------------------------------------------------------

function localFileFor(path) {
	for (const key of uploadKeys(path)) {
		const file = join(args.uploads, key);
		if (existsSync(file)) return { key, file };
	}
	return null;
}

/** The media an upload path was stored as, matched the way localFileFor matches files. */
function mediaForPath(path) {
	return mediaForUpload(state.media, path);
}

function collectUploads(blocks, found) {
	for (const b of blocks ?? []) {
		if (b._type === "image") {
			if (b.asset?._ref?.startsWith(UPLOAD_PREFIX)) found.add(b.asset._ref.slice(UPLOAD_PREFIX.length));
			if (typeof b.link === "string" && b.link.startsWith(UPLOAD_PREFIX)) found.add(b.link.slice(UPLOAD_PREFIX.length));
		}
		for (const def of b.markDefs ?? []) if (def.href?.startsWith(UPLOAD_PREFIX)) found.add(def.href.slice(UPLOAD_PREFIX.length));
		if (b._type === "gallery") collectUploads(b.images, found);
		if (b._type === "columns") for (const c of b.columns ?? []) collectUploads(c.content, found);
	}
	return found;
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".zip": "application/zip", ".mp3": "audio/mpeg", ".mp4": "video/mp4" };

async function uploadMedia(entries) {
	const wanted = new Map();
	for (const e of entries) {
		for (const path of collectUploads(e.content, new Set())) wanted.set(path, localFileFor(path));
		if (e.featured?.startsWith(UPLOAD_PREFIX)) {
			const path = e.featured.slice(UPLOAD_PREFIX.length);
			wanted.set(path, localFileFor(path));
		}
	}
	const byKey = new Map();
	for (const [path, local] of wanted) {
		if (!local) problems.missingFiles.add(path);
		else if (!state.media[local.key]) byKey.set(local.key, local.file);
	}
	console.log(`Media: ${wanted.size} referenced, ${byKey.size} to upload, ${problems.missingFiles.size} missing from the archive`);

	let done = 0;
	await pool([...byKey], Number(args.concurrency), async ([key, file]) => {
		try {
			const bytes = await readFile(file);
			const item = await withRetry(
				() =>
					client.mediaUpload(new Uint8Array(bytes), basename(file), {
						contentType: MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
					}),
				`media ${key}`,
			);
			state.media[key] = {
				id: item.id,
				url: `/_emdash/api/media/file/${item.storageKey ?? item.key}`,
				storageKey: item.storageKey ?? item.key,
				filename: item.filename,
				mimeType: item.mimeType,
				width: item.width,
				height: item.height,
			};
		} catch (error) {
			problems.failedUploads.push({ key, error: error.message });
		}
		if (++done % 50 === 0) {
			console.log(`  uploaded ${done}/${byKey.size}`);
			await saveState();
		}
	});
	await saveState();
	return (path) => {
		const local = localFileFor(path);
		return local ? state.media[local.key] : undefined;
	};
}

function resolveBlocks(blocks, mediaFor) {
	const resolveUrl = (value) => {
		if (typeof value !== "string" || !value.startsWith(UPLOAD_PREFIX)) return value;
		const path = value.slice(UPLOAD_PREFIX.length);
		return mediaFor(path)?.url ?? LEGACY_UPLOADS_URL + encodeURI(path);
	};
	for (const b of blocks ?? []) {
		if (b._type === "image") {
			const ref = b.asset?._ref;
			if (ref?.startsWith(UPLOAD_PREFIX)) {
				const media = mediaFor(ref.slice(UPLOAD_PREFIX.length));
				if (media) {
					b.asset = { _type: "reference", _ref: media.id, url: media.url };
					if (media.width && !b.width) b.width = media.width;
					if (media.height && !b.height) b.height = media.height;
				} else {
					b.asset = { _type: "reference", _ref: resolveUrl(ref), url: resolveUrl(ref) };
				}
			} else if (b.asset?.url?.startsWith("http://")) {
				// Old third-party images (mostly Flickr) are served over HTTPS now.
				b.asset.url = b.asset._ref = b.asset.url.replace(/^http:\/\/(farm\d+\.static\.?flickr\.com)/, "https://$1");
			}
			if (b.link) b.link = resolveUrl(b.link);
		}
		for (const def of b.markDefs ?? []) if (def.href) def.href = resolveUrl(def.href);
		if (b._type === "gallery") resolveBlocks(b.images, mediaFor);
		if (b._type === "columns") for (const c of b.columns ?? []) resolveBlocks(c.content, mediaFor);
	}
	return blocks;
}

// --- Taxonomies --------------------------------------------------------

async function importTerms() {
	for (const taxonomy of ["category", "tag"]) {
		const existing = {};
		for (const locale of plan.locales) {
			const { terms } = await api("GET", `/taxonomies/${taxonomy}/terms?locale=${locale}`);
			const flat = [];
			const walk = (list) => list.forEach((t) => (flat.push(t), walk(t.children ?? [])));
			walk(terms ?? []);
			existing[locale] = new Map(flat.map((t) => [t.slug, t]));
		}
		let created = 0;
		for (const term of plan.terms[taxonomy]) {
			let source = existing.en.get(term.slug);
			if (!source) {
				source = await createTerm(taxonomy, { ...term, parentId: term.parent ? existing.en.get(term.parent)?.id : undefined, locale: "en" });
				if (source) created++;
			}
			existing.en.set(term.slug, source);
			if (!source) continue;
			for (const locale of plan.locales.filter((l) => l !== "en")) {
				if (existing[locale].has(term.slug)) continue;
				const translated = await createTerm(taxonomy, { slug: term.slug, label: term.label, locale, translationOf: source.id });
				if (translated) {
					existing[locale].set(term.slug, translated);
					created++;
				}
			}
		}
		console.log(`Taxonomy ${taxonomy}: ${plan.terms[taxonomy].length} terms (${created} created)`);
	}
}

async function createTerm(taxonomy, { slug, label, parentId, locale, translationOf }) {
	try {
		const result = await api("POST", `/taxonomies/${taxonomy}/terms`, { slug, label, parentId, locale, translationOf });
		return result.term ?? result;
	} catch (error) {
		// A retried POST can land after the first attempt already committed, so
		// "already exists" means the term is present: fetch it rather than lose
		// its id (children and translations need it).
		if (/already exists|conflict/i.test(error.message)) {
			const { terms } = await api("GET", `/taxonomies/${taxonomy}/terms?locale=${locale}`);
			const flat = [];
			const walk = (list) => list.forEach((t) => (flat.push(t), walk(t.children ?? [])));
			walk(terms ?? []);
			const found = flat.find((t) => t.slug === slug);
			if (found) return found;
		}
		console.warn(`  term ${taxonomy}/${slug} (${locale}): ${error.message}`);
		return null;
	}
}

// --- Bylines -------------------------------------------------------------

async function bylineFor(author, locale) {
	if (!author) return null;
	const key = `${author.slug}:${locale}`;
	if (state.bylines[key]) return state.bylines[key];
	let slug = author.slug.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "author";
	if (!/^[a-z]/.test(slug)) slug = `author-${slug}`;
	const source = locale === "en" ? null : await bylineFor(author, "en");
	try {
		const result = await api("POST", "/admin/bylines", {
			slug,
			displayName: author.name,
			isGuest: true,
			locale,
			...(source ? { translationOf: source } : {}),
		});
		state.bylines[key] = (result.item ?? result.byline ?? result).id;
	} catch (error) {
		const { items } = await api("GET", `/admin/bylines?search=${encodeURIComponent(author.name)}&locale=${locale}`);
		const match = items?.find((b) => b.slug === slug && (!b.locale || b.locale === locale));
		if (!match) throw error;
		state.bylines[key] = match.id;
	}
	return state.bylines[key];
}

// --- Content -------------------------------------------------------------

async function importEntry(entry, mediaFor) {
	if (state.entries[entry.key]) return "skipped";
	const found = await findExisting(entry);
	if (found) {
		state.entries[entry.key] = found;
		return "skipped";
	}

	const data = { title: entry.title, content: resolveBlocks(entry.content, mediaFor) };
	if (entry.collection === "posts") {
		data.excerpt = entry.excerpt;
		const media = entry.featured?.startsWith(UPLOAD_PREFIX) ? mediaFor(entry.featured.slice(UPLOAD_PREFIX.length)) : null;
		if (media) {
			data.featured_image = { provider: "local", id: media.id, src: media.url, filename: media.filename, mimeType: media.mimeType, width: media.width, height: media.height, meta: { storageKey: media.storageKey } };
		}
	}
	const byline = await bylineFor(entry.author, entry.locale);
	const translationOf = entry.translationOf ? state.entries[entry.translationOf] : undefined;
	if (entry.translationOf && !translationOf) throw new Error(`source ${entry.translationOf} was not imported`);

	const item = await withRetry(
		() =>
			client.create(entry.collection, {
				data,
				slug: entry.slug,
				locale: entry.locale,
				translationOf,
				taxonomies: entry.taxonomies,
				bylines: byline ? [{ bylineId: byline }] : undefined,
				createdAt: entry.publishedAt,
			}),
		`create ${entry.collection}/${entry.slug}`,
	);
	await api("POST", `/content/${entry.collection}/${item.id}/publish`, { publishedAt: entry.publishedAt });
	state.entries[entry.key] = item.id;
	return "created";
}

async function findExisting(entry) {
	try {
		const result = await api("GET", `/content/${entry.collection}/${encodeURIComponent(entry.slug)}?locale=${entry.locale}`);
		const item = result.item ?? result;
		return item?.locale === entry.locale ? item.id : null;
	} catch {
		return null;
	}
}

/**
 * A comparable fingerprint of a body: its block structure, with whitespace
 * collapsed. Comparing this rather than the raw JSON ignores incidental field
 * differences between what the API returns and what the plan holds, while still
 * detecting exactly what we care about — a paragraph split.
 */
function blockShape(content) {
	return (content ?? []).map((b) => {
		if (b._type !== "block") return b._type;
		const text = (b.children ?? [])
			.map((c) => c.text ?? "")
			.join("")
			.replace(/\s+/g, " ")
			.trim();
		return `${b.style ?? "normal"}:${text}`;
	});
}

/**
 * Re-write the body of an entry that already exists. The importer otherwise only
 * ever creates, so a transform fix would never reach entries imported before it.
 * Returns "refreshed", "would-refresh" (dry run) or "unchanged".
 */
async function refreshContent(entry, mediaFor) {
	const id = state.entries[entry.key];
	if (!id) return "unchanged";

	const wanted = resolveBlocks(entry.content, mediaFor);
	const found = await api("GET", `/content/${entry.collection}/${encodeURIComponent(entry.slug)}?locale=${entry.locale}`);
	const item = found.item ?? found;
	const live = item?.content ?? item?.data?.content;

	if (JSON.stringify(blockShape(live)) === JSON.stringify(blockShape(wanted))) return "unchanged";
	if (args["dry-run"]) return "would-refresh";

	await client.update(entry.collection, id, { data: { content: wanted }, locale: entry.locale });
	// update() writes a draft, so publish to make it live — the same step the
	// create path takes.
	await api("POST", `/content/${entry.collection}/${id}/publish`, { publishedAt: entry.publishedAt });
	return "refreshed";
}

// --- Repairing links to the retired WordPress host -------------------------

/**
 * Point stored links at the media the site now serves, in place.
 *
 * The importer falls back to the old WordPress URL for a file that had not
 * finished uploading when the entry was first written, and re-runs skip entries
 * that already exist, so the dead URL survives every later import. Roughly 470
 * are stranded that way, the usual shape being an image the author wrapped in a
 * link to its own file. They resolve today only because the WordPress site is
 * still up; they 404 the moment it is retired.
 *
 * Unlike --refresh-content this edits the body the site holds rather than
 * replacing it with the plan's, so only the URLs change: prose, block keys and
 * structure are untouched, and a difference between plan and site cannot become
 * an edit. The URL an author typed as visible text is prose, and is left alone.
 */
async function repairUploadLinks(entries) {
	const counts = { scanned: 0, entries: 0, urls: 0, failed: 0 };

	for (const entry of entries) {
		const id = state.entries[entry.key];
		if (!id) continue;
		let live;
		try {
			const found = await api("GET", `/content/${entry.collection}/${encodeURIComponent(entry.slug)}?locale=${entry.locale}`);
			const item = found.item ?? found;
			live = item?.content ?? item?.data?.content;
		} catch (error) {
			counts.failed++;
			problems.failedEntries.push({ key: entry.key, title: entry.title, error: error.message });
			continue;
		}
		if (!live) continue;
		counts.scanned++;
		if (counts.scanned % 50 === 0) console.log(`  links ${counts.scanned}/${entries.length}`);

		const { content, count } = rewriteUploadLinks(live, (path) => mediaForPath(path)?.url);
		if (count === 0) continue;

		counts.entries++;
		counts.urls += count;
		if (args["dry-run"]) continue;
		try {
			await client.update(entry.collection, id, { data: { content }, locale: entry.locale });
			// update() writes a draft, so publish to make it live.
			await api("POST", `/content/${entry.collection}/${id}/publish`, { publishedAt: entry.publishedAt });
		} catch (error) {
			counts.failed++;
			problems.failedEntries.push({ key: entry.key, title: entry.title, error: error.message, details: error.details });
		}
	}

	console.log(
		`Links: ${counts.scanned} bodies read, ${counts.urls} upload URLs in ${counts.entries} entries ` +
			`${args["dry-run"] ? "would be rewritten" : "rewritten"}, ${counts.failed} failed`,
	);
}

// --- URL patterns ----------------------------------------------------------

/**
 * Posts and pages keep their WordPress addresses. Sites seeded before that
 * change still have /posts/{slug} and /pages/{slug}; bring them in line.
 */
async function syncUrlPatterns() {
	for (const [collection, urlPattern] of Object.entries(plan.urlPatterns ?? {})) {
		const { item } = await api("GET", `/schema/collections/${collection}`);
		if (item?.urlPattern === urlPattern) continue;
		await api("PUT", `/schema/collections/${collection}`, { urlPattern });
		console.log(`URL pattern for ${collection}: ${item?.urlPattern ?? "(default)"} -> ${urlPattern}`);
	}
}

// --- Redirects -----------------------------------------------------------

const REDIRECT_GROUP = "WordPress migration";

/**
 * Make the site's migration redirects match the plan: add missing ones, fix
 * changed destinations and delete ones the plan no longer has (an old rule
 * pointing at a URL that now redirects back would loop).
 */
async function syncRedirects() {
	const existing = new Map();
	let cursor;
	do {
		const query = new URLSearchParams({ group: REDIRECT_GROUP, limit: "100", ...(cursor ? { cursor } : {}) });
		const page = await api("GET", `/redirects?${query}`);
		for (const r of page.items ?? []) existing.set(r.source, r);
		cursor = page.nextCursor;
	} while (cursor);

	const counts = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
	const wanted = new Map(plan.redirects.map((r) => [r.source, r]));
	// Serial on purpose: EmDash rejects a redirect write that overlaps another
	// with "Another redirect change is in progress".
	for (const r of wanted.values()) {
		const current = existing.get(r.source);
		try {
			if (!current) {
				await api("POST", "/redirects", { source: r.source, destination: r.destination, type: 301, groupName: REDIRECT_GROUP });
				counts.created++;
			} else if (current.destination !== r.destination) {
				await api("PUT", `/redirects/${current.id}`, { destination: r.destination });
				counts.updated++;
			} else {
				counts.unchanged++;
			}
		} catch (error) {
			problems.failedRedirects.push({ ...r, error: error.message });
		}
	}
	for (const [source, r] of existing) {
		if (wanted.has(source)) continue;
		try {
			await api("DELETE", `/redirects/${r.id}`);
			counts.deleted++;
		} catch (error) {
			problems.failedRedirects.push({ source, destination: r.destination, error: `delete: ${error.message}` });
		}
	}
	console.log(`Redirects: ${wanted.size} in plan; ${counts.created} created, ${counts.updated} updated, ${counts.deleted} deleted, ${counts.unchanged} unchanged`);
}

// --- Run -----------------------------------------------------------------

let entries = plan.entries;
// `--only redirects` syncs the redirect table on its own, without touching
// media, terms or entries: changing a redirect should not cost a full import.
const redirectsOnly = args.only === "redirects";
if (args.only && !redirectsOnly) entries = entries.filter((e) => e.collection === args.only);
if (args.limit) {
	const keep = new Set(entries.slice(0, Number(args.limit)).map((e) => `${e.collection}-${e.wpId}`));
	entries = entries.filter((e) => keep.has(`${e.collection}-${e.wpId}`));
}

if (args["repair-upload-links"]) {
	await repairUploadLinks(entries);
} else if (!redirectsOnly) {
	await syncUrlPatterns();
	const mediaFor = await uploadMedia(entries);
	await importTerms();

	const counts = { created: 0, skipped: 0, failed: 0, refreshed: 0, "would-refresh": 0, unchanged: 0 };
	for (const [i, entry] of entries.entries()) {
		try {
			const outcome = await importEntry(entry, mediaFor);
			counts[outcome]++;
			if (outcome === "skipped" && args["sync-dates"]) {
				await api("POST", `/content/${entry.collection}/${state.entries[entry.key]}/publish`, { publishedAt: entry.publishedAt });
			}
			if (outcome === "skipped" && args["refresh-content"]) {
				counts[await refreshContent(entry, mediaFor)]++;
			}
		} catch (error) {
			counts.failed++;
			problems.failedEntries.push({ key: entry.key, title: entry.title, error: error.message, details: error.details });
		}
		if ((i + 1) % 50 === 0) {
			console.log(`  entries ${i + 1}/${entries.length}`);
			await saveState();
		}
	}
	await saveState();
	console.log(`Entries: ${counts.created} created, ${counts.skipped} already present, ${counts.failed} failed`);
	if (args["refresh-content"]) {
		console.log(
			args["dry-run"]
				? `Content: ${counts["would-refresh"]} would be refreshed, ${counts.unchanged} unchanged`
				: `Content: ${counts.refreshed} refreshed, ${counts.unchanged} unchanged`,
		);
	}
}

if (!args["repair-upload-links"] && (redirectsOnly || (!args.limit && !args.only))) await syncRedirects();

const reportPath = join(dirname(args.plan), "import-report.json");
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify({ ...problems, missingFiles: [...problems.missingFiles] }, null, 1));
console.log(`Problems written to ${reportPath}: ${problems.missingFiles.size} missing files, ${problems.failedUploads.length} failed uploads, ${problems.failedEntries.length} failed entries, ${problems.failedRedirects.length} failed redirects`);
