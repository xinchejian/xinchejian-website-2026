// Split qTranslate-X multilingual strings into one string per language.
//
// qTranslate-X stores every language in the same field, delimited by
// `[:en]…[:zh]…[:]`. Older qTranslate versions used `<!--:en-->…<!--:-->`
// and some fields use `{:en}…{:}`. Text outside any language tag is shared by
// all languages.

const TAG = /\[:([a-z]{2})?\]|<!--:([a-z]{2})?-->|\{:([a-z]{2})?\}/g;

export function hasQtxTags(text) {
	if (!text) return false;
	TAG.lastIndex = 0;
	return TAG.test(text);
}

/**
 * @param {string} text
 * @param {string[]} languages
 * @returns {Record<string, string> | null} null when the text has no tags
 */
export function splitQtx(text, languages) {
	if (!hasQtxTags(text)) return null;

	const out = Object.fromEntries(languages.map((lang) => [lang, ""]));
	let current = null;
	let last = 0;
	const append = (segment) => {
		if (!segment) return;
		if (current === null) {
			for (const lang of languages) out[lang] += segment;
		} else if (current in out) {
			out[current] += segment;
		}
	};

	TAG.lastIndex = 0;
	let match;
	while ((match = TAG.exec(text)) !== null) {
		append(text.slice(last, match.index));
		current = match[1] || match[2] || match[3] || null;
		last = TAG.lastIndex;
	}
	append(text.slice(last));
	return out;
}
