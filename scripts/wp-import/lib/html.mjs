// HTML clean-up for legacy WordPress content before Portable Text conversion.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”" };

export function decodeEntities(text) {
	return (text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(n) ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[code.toLowerCase()] ?? m;
	});
}

export function stripTags(html) {
	return decodeEntities(
		(html ?? "")
			.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<[^>]+>/g, " ")
			.replace(/\[\/?[a-z_]+[^\]]*\]/gi, " "),
	)
		.replace(/\s+/g, " ")
		.trim();
}

const CJK = /[㐀-鿿豈-﫿]/g;

/** Share of non-space characters that are CJK ideographs. */
export function cjkRatio(text) {
	const plain = stripTags(text).replace(/\s/g, "");
	if (!plain) return 0;
	return (plain.match(CJK)?.length ?? 0) / plain.length;
}

// Windows-1252 code points for bytes 0x80–0x9F (the rest map 1:1 to Latin-1).
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
const MOJIBAKE_RUN = /[\u0080-ÿŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]{2,}/g;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Repair text that was UTF-8, misread as Windows-1252 and saved again
 * ("æ–°å¹´" → "新年", "Â " → " "). Each run of Latin-1-range characters is
 * re-decoded only when it forms valid UTF-8, so genuine accents survive.
 */
export function fixMojibake(text) {
	if (!text) return text;
	return text.replace(MOJIBAKE_RUN, (run) => {
		const bytes = [];
		for (const ch of run) {
			const code = ch.codePointAt(0);
			const byte = code <= 0xff ? code : CP1252[code];
			if (byte === undefined) return run;
			bytes.push(byte);
		}
		try {
			return utf8.decode(Uint8Array.from(bytes));
		} catch {
			return run;
		}
	});
}

/** Some posts were imported years ago with their body wrapped in CDATA markers. */
export function stripCdata(html) {
	return (html ?? "").trim().replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").replace(/<!\[CDATA\[|\]\]>/g, "");
}

export function excerptOf(html, max = 200) {
	const text = stripTags(html);
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

const ATTR = (name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");

export function getAttr(tag, name) {
	const m = tag.match(ATTR(name));
	return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : undefined;
}

function shortcodeAttrs(raw) {
	const attrs = {};
	for (const m of raw.matchAll(/([a-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi)) {
		attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
	}
	return attrs;
}

/**
 * Markers survive wpautop and the Portable Text converter as a paragraph of
 * their own; the transform swaps them for embed/gallery blocks afterwards.
 */
export const MARKER = "XCJMARKER";
export const markerParagraph = (payload) =>
	`\n\n<p>${MARKER}:${Buffer.from(JSON.stringify(payload)).toString("base64")}</p>\n\n`;
export function parseMarker(text) {
	const m = text?.trim().match(new RegExp(`^${MARKER}:([A-Za-z0-9+/=]+)$`));
	return m ? JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) : null;
}

const VIDEO_URL = /^(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?[^\s<]+|youtu\.be\/[^\s<]+|vimeo\.com\/\d+[^\s<]*|v\.youku\.com\/[^\s<]+))$/i;

/**
 * Replace shortcodes and embedded players with markup the converter keeps.
 * Returns the unhandled shortcode names so they can be reported.
 */
export function preprocess(html) {
	const unhandled = new Set();
	let out = html;

	// [caption id=".." align="alignright" width="300"]<a><img></a> Caption text[/caption]
	out = out.replace(/\[caption([^\]]*)\]([\s\S]*?)\[\/caption\]/gi, (_, rawAttrs, inner) => {
		const attrs = shortcodeAttrs(rawAttrs);
		const media = inner.match(/(<a[^>]*>\s*)?<img[^>]*>(\s*<\/a>)?/i)?.[0] ?? "";
		const caption = (attrs.caption ?? inner.replace(media, "")).trim();
		return `\n\n<figure>${media}<figcaption>${caption}</figcaption></figure>\n\n`;
	});

	out = out.replace(/\[gallery([^\]]*)\]/gi, (_, rawAttrs) => {
		const attrs = shortcodeAttrs(rawAttrs);
		const ids = attrs.ids ? attrs.ids.split(",").map((id) => Number(id.trim())).filter(Boolean) : null;
		return markerParagraph({ type: "gallery", ids, columns: attrs.columns ? Number(attrs.columns) : undefined });
	});

	out = out.replace(/\[embed[^\]]*\]([\s\S]*?)\[\/embed\]/gi, (_, url) => markerParagraph({ type: "embed", url: url.trim() }));

	// <iframe>, <embed> and legacy <object> players.
	out = out.replace(/<object[\s\S]*?<\/object>/gi, (obj) => {
		const src = getAttr(obj.match(/<embed[^>]*>/i)?.[0] ?? "", "src") ?? getAttr(obj.match(/<param[^>]*name=["']movie["'][^>]*>/i)?.[0] ?? "", "value");
		return src ? markerParagraph({ type: "embed", url: src }) : "";
	});
	out = out.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>|<iframe[^>]*\/>|<embed[^>]*>/gi, (tag) => {
		let src = getAttr(tag, "src");
		if (!src) return "";
		if (src.startsWith("//")) src = `https:${src}`;
		return markerParagraph({ type: "embed", url: src });
	});

	// WordPress auto-embeds a bare video URL on its own line.
	out = out.replace(/^[ \t]*(https?:\/\/\S+)[ \t]*$/gim, (line, url) =>
		VIDEO_URL.test(url) ? markerParagraph({ type: "embed", url }) : line,
	);

	for (const m of out.matchAll(/\[([a-z_][a-z0-9_-]*)[\s\]]/gi)) {
		if (!/^(:|x|i|b|u|1|2)$/i.test(m[1])) unhandled.add(m[1].toLowerCase());
	}
	return { html: out, unhandled };
}
