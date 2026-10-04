// Linking to media the site serves, rather than to the WordPress uploads it
// was imported from.
//
// The importer falls back to an old WordPress URL for a file that had not
// finished uploading when an entry was first written, and re-runs skip entries
// that already exist, so those URLs outlive the import. They resolve only while
// the WordPress site is still up, and 404 the moment it is retired.

import { fixMojibake } from "./html.mjs";

/** A WordPress resized copy: foo-300x200.jpg. */
const SIZE_SUFFIX = /-\d+x\d+(?=\.[^./]+$)/;

/**
 * A link into the old site's uploads, anywhere in a stored body. The old site
 * answered on its domain and on the server's address, and both stop working at
 * cutover, so both are ours to move. The excluded characters are the ones that
 * end a URL in the places these appear: markup, srcset lists, prose.
 */
const LEGACY_UPLOAD_URL = /https?:\/\/(?:www\.xinchejian\.com|xinchejian\.com|139\.162\.84\.35)\/wp-content\/uploads\/([^\s"'<>),\]]+)/g;

/**
 * The names a WordPress upload can be known by, most likely first. Resized
 * copies are named foo-300x200.jpg and the original is preferred; links in old
 * posts also drift from the files: garbled Chinese names, a "+" stripped on
 * upload, a "-1" added for duplicate names.
 */
export function uploadKeys(path) {
	const clean = path.replace(/^\/+/, "");
	const names = new Set([clean, fixMojibake(clean), clean.replaceAll("+", "")]);
	const keys = [];
	for (const name of names) {
		let original = name;
		while (SIZE_SUFFIX.test(original)) original = original.replace(SIZE_SUFFIX, "");
		keys.push(original, original.replace(/(\.[^./]+)$/, "-1$1"), name);
	}
	return keys;
}

/**
 * The media an upload path was stored as, matched by the names {@link uploadKeys}
 * offers so a resized copy or a duplicate resolves to the original. `media` is
 * keyed the way the importer records it: by the upload path it stored.
 */
export function mediaForUpload(media, path) {
	for (const key of uploadKeys(path)) if (media[key]) return media[key];
	return null;
}

/** The upload path a legacy URL addresses, decoded; null when it will not decode. */
export function uploadPathFromUrl(url) {
	try {
		return decodeURIComponent(url);
	} catch {
		return null;
	}
}

/**
 * Replace every link into the old uploads with what `lookup(path)` returns,
 * leaving the URL alone when it answers nothing — a file that never made it
 * into the archive has no replacement, and inventing one would be worse.
 *
 * Spans are prose: a URL an author typed as visible text is theirs to keep, so
 * `text` values are never touched. Everything else in a body is a field we own
 * and is fair game.
 *
 * Returns the rewritten body and how many URLs changed. The input is not
 * modified.
 */
export function rewriteUploadLinks(content, lookup) {
	let count = 0;

	const rewrite = (value, prose) => {
		if (typeof value !== "string" || prose || !value.includes("/wp-content/uploads/")) return value;
		return value.replace(LEGACY_UPLOAD_URL, (whole, encoded) => {
			const path = uploadPathFromUrl(encoded);
			const replacement = path === null ? null : lookup(path);
			if (!replacement) return whole;
			count++;
			return replacement;
		});
	};

	const walk = (node, prose = false) => {
		if (Array.isArray(node)) return node.map((child) => walk(child, prose));
		if (!node || typeof node !== "object") return rewrite(node, prose);
		return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value, prose || key === "text")]));
	};

	return { content: walk(content), count };
}
