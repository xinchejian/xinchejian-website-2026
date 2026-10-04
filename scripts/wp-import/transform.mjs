#!/usr/bin/env node
// Turn the WordPress snapshot into an import plan: one entry per post/page per
// language, with Portable Text bodies, term assignments and redirects.
// Media is referenced as `wp-upload:<path>` and resolved by import.mjs.
//
// Usage: node scripts/wp-import/transform.mjs [wp-export.json] [plan.json]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gutenbergToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import { splitLongBlocks } from "./lib/blocks.mjs";
import { splitQtx } from "./lib/qtranslate.mjs";
import { wpautop } from "./lib/wpautop.mjs";
import { cjkRatio, decodeEntities, excerptOf, fixMojibake, parseMarker, preprocess, stripCdata, stripTags } from "./lib/html.mjs";

const LOCALES = ["en", "zh"];
const DEFAULT_LOCALE = "en";
const COLLECTION = { post: "posts", page: "pages" };
// Posts without qTranslate tags are assigned a language by their share of CJK text.
const CJK_THRESHOLD = 0.3;
const DROPPED_CATEGORIES = new Set(["uncategorized"]);
const SITE = /^(?:(?:https?:)?\/\/(?:www\.)?(?:xinchejian\.com|139\.162\.84\.35)(?::\d+)?)?(\/[^#]*)?(#.*)?$/i;

export const UPLOAD_PREFIX = "wp-upload:";

export function localePrefix(locale) {
	return locale === DEFAULT_LOCALE ? "" : `/${locale}`;
}

// Collection URL patterns. Posts keep WordPress's /%year%/%monthnum%/%postname%/
// permalinks and pages sit at the root, so most old URLs stay valid as-is.
export const URL_PATTERNS = { posts: "/{year}/{month}/{slug}", pages: "/{slug}" };

/** Same expansion EmDash applies to URL_PATTERNS (dates in UTC). */
export function entryPath(collection, slug, locale, publishedAt) {
	const date = new Date(publishedAt);
	const path = URL_PATTERNS[collection]
		.replace("{year}", String(date.getUTCFullYear()))
		.replace("{month}", String(date.getUTCMonth() + 1).padStart(2, "0"))
		.replace("{slug}", encodeURIComponent(slug));
	return `${localePrefix(locale)}${path}`;
}

/** Compare paths the way a router does: decoded, without a trailing slash. */
function samePath(a, b) {
	const norm = (p) => safeDecode(p).replace(/\/$/, "").toLowerCase();
	return norm(a) === norm(b);
}

function decodeSlug(raw, fallback) {
	let slug = raw || "";
	try {
		slug = decodeURIComponent(slug);
	} catch {}
	slug = slug.toLowerCase().trim();
	return slug || fallback;
}

/** Page titles were written as "English | 中文" before qTranslate was used. */
function splitBilingualTitle(title) {
	const parts = title.split(/\s+\|\s+/);
	if (parts.length === 2 && cjkRatio(parts[1]) > 0.5 && cjkRatio(parts[0]) < 0.2) {
		return { en: parts[0].trim(), zh: parts[1].trim() };
	}
	return null;
}

function splitField(value) {
	return splitQtx(value ?? "", LOCALES);
}

export function buildPlan(snapshot) {
	const { relationships } = snapshot;
	const posts = snapshot.posts.map((p) => ({ ...p, title: fixMojibake(p.title), content: fixMojibake(p.content), excerpt: fixMojibake(p.excerpt) }));
	const attachments = snapshot.attachments.map((a) => ({ ...a, alt: fixMojibake(a.alt), caption: fixMojibake(a.caption) }));
	const terms = snapshot.terms.map((t) => ({ ...t, name: fixMojibake(t.name) }));
	const report = { unhandledShortcodes: {}, externalEmbeds: [], unresolvedLinks: [], languageGuessed: [] };

	const attachmentsById = new Map(attachments.map((a) => [Number(a.id), a]));
	const imageAttachmentsByParent = new Map();
	for (const a of attachments) {
		if (!a.mime?.startsWith("image/") || !a.file) continue;
		const list = imageAttachmentsByParent.get(Number(a.parent)) ?? [];
		list.push(a);
		imageAttachmentsByParent.set(Number(a.parent), list);
	}
	for (const list of imageAttachmentsByParent.values()) list.sort((a, b) => a.menu_order - b.menu_order || a.id - b.id);

	// --- Terms (created in every locale; labels are not translated in WordPress) ---
	const termsById = new Map(terms.map((t) => [Number(t.id), t]));
	const termByTermId = new Map(terms.map((t) => [Number(t.term_id), t]));
	const taxonomyName = { category: "category", post_tag: "tag" };
	const planTerms = { category: [], tag: [] };
	for (const t of [...terms].sort((a, b) => Number(a.parent) - Number(b.parent))) {
		const tax = taxonomyName[t.taxonomy];
		if (tax === "category" && DROPPED_CATEGORIES.has(t.slug)) continue;
		const parent = Number(t.parent) ? termByTermId.get(Number(t.parent))?.slug : undefined;
		planTerms[tax].push({ slug: decodeSlug(t.slug, `term-${t.id}`), label: decodeEntities(t.name), parent });
	}
	const termsByPost = new Map();
	for (const r of relationships) {
		const t = termsById.get(Number(r.term_id));
		if (!t) continue;
		const tax = taxonomyName[t.taxonomy];
		if (tax === "category" && DROPPED_CATEGORIES.has(t.slug)) continue;
		const entry = termsByPost.get(Number(r.post_id)) ?? { category: [], tag: [] };
		entry[tax].push(decodeSlug(t.slug, `term-${t.id}`));
		termsByPost.set(Number(r.post_id), entry);
	}

	// --- Pass 1: decide which languages each post exists in ---
	const sources = [];
	for (const p of posts) {
		const collection = COLLECTION[p.type];
		const body = stripCdata(p.content);
		const split = splitField(body);
		const titleSplit = splitField(p.title) ?? (p.type === "page" ? splitBilingualTitle(decodeEntities(p.title)) : null);
		const excerptSplit = splitField(p.excerpt);

		const bodies = {};
		if (split) {
			for (const locale of LOCALES) if (stripTags(split[locale]) || /<img|\[gallery|<iframe/i.test(split[locale])) bodies[locale] = split[locale];
		} else {
			const guess = cjkRatio(body) > CJK_THRESHOLD ? "zh" : DEFAULT_LOCALE;
			if (guess !== DEFAULT_LOCALE) report.languageGuessed.push({ id: p.id, title: p.title, locale: guess });
			bodies[guess] = body;
		}
		// A page whose only translation is its title still gets a Chinese entry.
		if (titleSplit && !split && p.type === "page" && bodies.en && !bodies.zh) bodies.zh = bodies.en;
		if (Object.keys(bodies).length === 0) bodies[DEFAULT_LOCALE] = body;

		const titles = {};
		for (const locale of Object.keys(bodies)) {
			const t = decodeEntities(titleSplit?.[locale]?.trim() || titleSplit?.[DEFAULT_LOCALE]?.trim() || p.title).trim();
			titles[locale] = t || `Untitled ${p.id}`;
		}
		sources.push({ p, collection, slug: decodeSlug(p.slug, `${p.type}-${p.id}`), bodies, titles, excerptSplit });
	}

	const byId = new Map(sources.map((s) => [Number(s.p.id), s]));
	const postByWpSlug = new Map(sources.filter((s) => s.p.type === "post").map((s) => [s.slug, s]));
	const pageBySlug = new Map(sources.filter((s) => s.p.type === "page").map((s) => [s.slug, s]));

	const urlFor = (source, locale) => {
		const target = source.bodies[locale] !== undefined ? locale : Object.keys(source.bodies)[0];
		return entryPath(source.collection, source.slug, target, toIso(source.p.date_gmt, source.p.date));
	};

	function resolveHref(href, locale) {
		const m = href.trim().match(SITE);
		if (!m || /^(mailto:|tel:|javascript:)/i.test(href)) return href;
		if (!/^(https?:)?\/\//i.test(href.trim()) && !href.trim().startsWith("/")) return href;
		const [pathAndQuery = "/", hash = ""] = [m[1], m[2] ?? ""];
		const [path, query = ""] = pathAndQuery.split("?");
		const upload = path.match(/^\/wp-content\/uploads\/(.+)$/i);
		if (upload) return `${UPLOAD_PREFIX}${safeDecode(upload[1])}`;

		const params = new URLSearchParams(query);
		const id = Number(params.get("p") || params.get("page_id"));
		if (id && byId.has(id)) return urlFor(byId.get(id), locale) + hash;

		const post = path.match(/^\/\d{4}\/\d{2}\/(?:\d{2}\/)?([^/]+)\/?$/);
		if (post) {
			const s = postByWpSlug.get(decodeSlug(post[1]));
			if (s) return urlFor(s, locale) + hash;
			report.unresolvedLinks.push(href);
			return href;
		}
		const lastSegment = decodeSlug(path.replace(/\/$/, "").split("/").pop() ?? "");
		if (lastSegment && pageBySlug.has(lastSegment)) return urlFor(pageBySlug.get(lastSegment), locale) + hash;
		if (/^\/(category|tag)\//.test(path)) return path.replace(/\/$/, "") + hash;
		if (path === "/" || path === "") return (localePrefix(locale) || "/") + hash;
		// Anything else on the old domain no longer exists.
		report.unresolvedLinks.push(href);
		return href;
	}

	function rewriteBlocks(blocks, locale, postId) {
		const out = [];
		for (const block of blocks) {
			if (block._type === "block") {
				const marker = block.children?.length ? parseMarker(block.children.map((c) => c.text ?? "").join("")) : null;
				if (marker?.type === "embed") {
					const url = marker.url.startsWith("//") ? `https:${marker.url}` : marker.url;
					if (!/youtube|youtu\.be|vimeo/i.test(url)) report.externalEmbeds.push({ id: postId, url });
					out.push({ _type: "embed", _key: block._key, url });
					continue;
				}
				if (marker?.type === "gallery") {
					const images = (marker.ids ? marker.ids.map((id) => attachmentsById.get(id)) : imageAttachmentsByParent.get(postId) ?? []).filter((a) => a?.file);
					if (images.length) {
						out.push({
							_type: "gallery",
							_key: block._key,
							columns: marker.columns ?? 3,
							images: images.map((a, i) => ({
								_type: "image",
								_key: `${block._key}-${i}`,
								asset: { _type: "reference", _ref: UPLOAD_PREFIX + a.file, url: UPLOAD_PREFIX + a.file },
								...(a.alt ? { alt: a.alt } : {}),
								...(a.caption ? { caption: stripTags(a.caption) } : {}),
							})),
						});
					}
					continue;
				}
				for (const def of block.markDefs ?? []) {
					if (def._type === "link" && def.href) def.href = resolveHref(def.href, locale);
				}
				out.push(block);
				continue;
			}
			if (block._type === "image") {
				if (block.asset?.url) {
					const url = resolveHref(block.asset.url, locale);
					block.asset = { _type: "reference", _ref: url, url };
				}
				if (typeof block.link === "string") block.link = resolveHref(block.link, locale);
			}
			if (block._type === "gallery") block.images = rewriteBlocks(block.images ?? [], locale, postId);
			if (block._type === "columns") for (const c of block.columns ?? []) c.content = rewriteBlocks(c.content ?? [], locale, postId);
			out.push(block);
		}
		return out;
	}

	const firstImage = (blocks) => {
		for (const b of blocks) {
			if (b._type === "image" && b.asset?._ref?.startsWith(UPLOAD_PREFIX)) return b.asset._ref;
			if (b._type === "gallery") {
				const ref = firstImage(b.images ?? []);
				if (ref) return ref;
			}
		}
		return null;
	};

	// --- Pass 2: build entries ---
	const entries = [];
	for (const s of sources) {
		const { p } = s;
		const locales = LOCALES.filter((l) => s.bodies[l] !== undefined);
		const source = locales.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : locales[0];
		const thumb = p.thumbnail_id ? attachmentsById.get(Number(p.thumbnail_id)) : null;

		for (const locale of [source, ...locales.filter((l) => l !== source)]) {
			const raw = s.bodies[locale];
			const { html, unhandled } = preprocess(raw);
			for (const name of unhandled) report.unhandledShortcodes[name] = (report.unhandledShortcodes[name] ?? 0) + 1;
			const isGutenberg = html.includes("<!-- wp:");
			let content = gutenbergToPortableText(isGutenberg ? html : wpautop(html));
			content = rewriteBlocks(content, locale, Number(p.id));
			// Recover paragraphs the WordPress source separated with single
			// newlines; HTML collapsed them, leaving one wall-of-text block.
			content = splitLongBlocks(content);

			const featured = thumb?.file ? UPLOAD_PREFIX + thumb.file : firstImage(content);
			const excerpt = (s.excerptSplit?.[locale] ?? (s.excerptSplit ? "" : p.excerpt))?.trim();

			entries.push({
				key: `${p.type}-${p.id}-${locale}`,
				wpId: Number(p.id),
				collection: s.collection,
				locale,
				translationOf: locale === source ? null : `${p.type}-${p.id}-${source}`,
				slug: s.slug,
				title: s.titles[locale],
				excerpt: s.collection === "posts" ? stripTags(excerpt) || excerptOf(raw) : undefined,
				content,
				featured: s.collection === "posts" ? featured : undefined,
				publishedAt: toIso(p.date_gmt, p.date),
				updatedAt: toIso(p.modified_gmt, p.date),
				author: p.author ? { name: decodeEntities(p.author), slug: decodeSlug(p.author_slug, `author-${p.id}`) } : null,
				taxonomies: s.collection === "posts" ? (termsByPost.get(Number(p.id)) ?? { category: [], tag: [] }) : undefined,
				oldPath: oldPathFor(p, byId),
			});
		}
	}

	// --- Redirects from WordPress permalinks ---
	const redirects = [];
	const seen = new Set();
	const addRedirect = (source, destination) => {
		if (seen.has(source) || samePath(source, destination)) return;
		seen.add(source);
		redirects.push({ source, destination });
	};
	for (const s of sources) {
		const path = oldPathFor(s.p, byId);
		const destination = urlFor(s, DEFAULT_LOCALE);
		// Only posts moved to another month (UTC vs Shanghai time), child pages
		// and Chinese-only posts end up at a different address.
		addRedirect(path, destination);
		addRedirect(path.replace(/\/$/, ""), destination);
		for (const locale of LOCALES) {
			if (locale === DEFAULT_LOCALE || s.bodies[locale] === undefined) continue;
			addRedirect(`${localePrefix(locale)}${path}`, urlFor(s, locale));
		}
	}
	addRedirect("/category/uncategorized/", "/posts");

	// Feeds. The old site served the blog feed at several paths -- the plain
	// /feed/, the Atom and RSS aliases, the site comments feed, and one feed
	// per page in every page head -- all of which now resolve to /rss.xml.
	for (const prefix of ["", "/zh"]) {
		const feed = `${prefix}/rss.xml`;
		for (const legacy of ["/feed", "/feed/", "/feed/atom", "/feed/atom/", "/feed/rss", "/feed/rss/", "/comments/feed", "/comments/feed/"]) {
			addRedirect(`${prefix}${legacy}`, feed);
		}
		addRedirect(`${prefix}/[slug]/feed`, feed);
		addRedirect(`${prefix}/[slug]/feed/`, feed);
	}

	// The old blog index paginated at /page/2/, /page/3/ ... ; the new site
	// paginates with ?cursor=, so send readers to the start of the list.
	for (const prefix of ["", "/zh"]) {
		const list = prefix ? `${prefix}/posts` : "/posts";
		addRedirect(`${prefix}/page/[n]`, list);
		addRedirect(`${prefix}/page/[n]/`, list);
	}

	// WordPress redirected /event/ to /event2/ itself; keep the hop so the
	// address in old links and search results still resolves.
	addRedirect("/event/", "/event2");
	addRedirect("/zh/event/", "/zh/event2");

	// Hierarchical category archives. The old site nested a child term under
	// its parent (/category/urban-farming/aquaponic/); the new one serves every
	// term at /category/<slug>.
	const termsBySlug = new Map(planTerms.category.map((t) => [t.slug, t]));
	const ancestorsOf = (term) => {
		const chain = [];
		for (let parent = termsBySlug.get(term.parent); parent; parent = termsBySlug.get(parent.parent)) chain.unshift(parent.slug);
		return chain;
	};
	for (const term of planTerms.category) {
		const chain = ancestorsOf(term);
		if (chain.length === 0) continue;
		const nested = `/category/${[...chain, term.slug].join("/")}`;
		addRedirect(nested, `/category/${term.slug}`);
		addRedirect(`${nested}/`, `/category/${term.slug}`);
	}

	// The Tools page lists its children through the translated parent slug,
	// "工具" (tools). Those links live in the Tools page body, one click from
	// the main menu, and each child page now sits at the root, so the whole
	// subtree maps straight onto /<slug> in one hop rather than the two the old
	// site took via /tools/<slug>/.
	//
	// The source is the percent-encoded form because that is what the request
	// path holds: the URL parser decodes and re-encodes the octets -- upper
	// case -- before anything here sees them, so the lower-case encoding the
	// old hrefs carry never reaches the matcher.
	const TOOLS_PARENT = "/tools-%E5%B7%A5%E5%85%B7";
	addRedirect(`${TOOLS_PARENT}/[...path]`, "/[path]");
	addRedirect(`/zh${TOOLS_PARENT}/[...path]`, "/zh/[path]");

	// Retired WordPress uploads are deliberately NOT redirected here. EmDash's
	// redirect middleware skips any path ending in a file extension
	// (ASSET_EXTENSION in src/astro/middleware/redirect.ts), so a rule for
	// /wp-content/uploads/....jpg can never match; the rules would sit in the
	// table, inert, and bloat the cache every request loads.

	return { generatedAt: new Date().toISOString(), urlPatterns: URL_PATTERNS, locales: LOCALES, defaultLocale: DEFAULT_LOCALE, site: snapshot.options, terms: planTerms, entries, redirects, report };
}

function safeDecode(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * WordPress permalinks and displayed dates use the site's local time
 * (Asia/Shanghai). Store that wall-clock time as UTC so the URL month and the
 * date shown on the page match the old site exactly.
 */
function toIso(_gmt, local) {
	return new Date(`${local.replace(" ", "T")}Z`).toISOString();
}

/** WordPress permalink: /%year%/%monthnum%/%postname%/ for posts, /parent/child/ for pages. */
function oldPathFor(p, byId) {
	const slug = encodeURI(safeDecode(p.slug));
	if (p.type === "post") {
		const [y, m] = p.date.split(/[- ]/);
		return `/${y}/${m}/${slug}/`;
	}
	const parts = [slug];
	let parent = byId.get(Number(p.parent));
	while (parent) {
		parts.unshift(encodeURI(safeDecode(parent.p.slug)));
		parent = byId.get(Number(parent.p.parent));
	}
	return `/${parts.join("/")}/`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const input = process.argv[2] ?? ".import/wp-export.json";
	const output = process.argv[3] ?? ".import/plan.json";
	const plan = buildPlan(JSON.parse(await readFile(input, "utf8")));
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, JSON.stringify(plan, null, 1));

	const count = (collection, locale) => plan.entries.filter((e) => e.collection === collection && e.locale === locale).length;
	console.log(`Wrote ${output}`);
	for (const c of ["posts", "pages"]) console.log(`  ${c}: en ${count(c, "en")}, zh ${count(c, "zh")}`);
	console.log(`  terms: ${plan.terms.category.length} categories, ${plan.terms.tag.length} tags; redirects: ${plan.redirects.length}`);
	console.log(`  language guessed as zh (no qTranslate tags): ${plan.report.languageGuessed.length}`);
	console.log(`  unhandled shortcodes: ${JSON.stringify(plan.report.unhandledShortcodes)}`);
	console.log(`  non-YouTube/Vimeo embeds: ${plan.report.externalEmbeds.length}; unresolved old-site links: ${plan.report.unresolvedLinks.length}`);
}
