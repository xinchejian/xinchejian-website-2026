// A port of WordPress's wpautop(): classic-editor content is stored without
// <p> tags and relies on this filter to turn blank lines into paragraphs and
// single newlines into <br />.

const ALL_BLOCKS =
	"(?:table|thead|tfoot|caption|col|colgroup|tbody|tr|td|th|div|dl|dd|dt|ul|ol|li|pre|form|map|area|blockquote|address|math|style|p|h[1-6]|hr|fieldset|legend|section|article|aside|hgroup|header|footer|nav|figure|figcaption|details|menu|summary|iframe|object|embed)";

export function wpautop(input) {
	let text = input ?? "";
	if (!text.trim()) return "";

	// Protect <pre> blocks; their newlines are significant.
	const pres = [];
	text = text.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => {
		pres.push(m);
		return `<pre wp-pre-tag-${pres.length - 1}></pre>`;
	});

	text = text.replace(/\r\n|\r/g, "\n");
	text += "\n";
	text = text.replace(/<br\s*\/?>\s*<br\s*\/?>/gi, "\n\n");

	// Newlines inside tags (attribute lists) are not paragraph breaks.
	text = text.replace(/<[^>]+>/g, (tag) => tag.replace(/\s*\n\s*/g, " "));

	text = text.replace(new RegExp(`(<${ALL_BLOCKS}[\\s/>])`, "gi"), "\n\n$1");
	text = text.replace(new RegExp(`(</${ALL_BLOCKS}>)`, "gi"), "$1\n\n");
	text = text.replace(/\n\n+/g, "\n\n");

	const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
	text = paragraphs.map((p) => `<p>${p.replace(/^\n+|\n+$/g, "")}</p>\n`).join("");

	text = text.replace(/<p>\s*<\/p>/g, "");
	text = text.replace(/<p>([^<]+)<\/(div|address|form)>/gi, "<p>$1</p></$2>");
	text = text.replace(new RegExp(`<p>\\s*(</?${ALL_BLOCKS}[^>]*>)\\s*</p>`, "gi"), "$1");
	text = text.replace(/<p>(<li.+?)<\/p>/gi, "$1");
	text = text.replace(/<p><blockquote([^>]*)>/gi, "<blockquote$1><p>");
	text = text.replace(/<\/blockquote><\/p>/gi, "</p></blockquote>");
	text = text.replace(new RegExp(`<p>\\s*(</?${ALL_BLOCKS}[^>]*>)`, "gi"), "$1");
	text = text.replace(new RegExp(`(</?${ALL_BLOCKS}[^>]*>)\\s*</p>`, "gi"), "$1");

	// Remaining single newlines become line breaks.
	text = text.replace(/(?<!<br \/>)\s*\n(?!$)/g, "<br />\n");
	text = text.replace(new RegExp(`(</?${ALL_BLOCKS}[^>]*>)\\s*<br />`, "gi"), "$1");
	text = text.replace(/<br \/>(\s*<\/?(?:p|li|div|dl|dd|dt|th|pre|td|ul|ol)[^>]*>)/gi, "$1");
	text = text.replace(/\n<\/p>$/g, "</p>");

	return text.replace(/<pre wp-pre-tag-(\d+)><\/pre>/g, (_, i) => pres[Number(i)]);
}
