// Recover paragraph breaks that were lost in the WordPress source.
//
// Some posts were authored with single newlines between paragraphs. HTML
// collapses a single newline to a space and wpautop only starts a paragraph on a
// blank line, so those breaks vanished years before the import — /kin-interview
// is a single <p> of 8,060 characters on the live site. The importer faithfully
// copies that into one Portable Text block, which renders as a wall of text.
//
// Splitting is deliberately conservative: only blocks over WALL_BLOCK_CHARS, and
// only at newlines that follow sentence-ending punctuation. A blanket split on
// every newline would shred posts whose newlines are hard wraps or list items.

/** Only blocks longer than this are considered. */
export const WALL_BLOCK_CHARS = 1000;

// Punctuation, an optional closing quote or bracket, then the newline. The
// punctuation stays with the paragraph it ends; the spaces and newline are
// dropped, since the split itself is what separates the paragraphs.
const SPLIT_PATTERN = /([.!?。！？]["”’')\]]?)[ \t]*\n[ \t]*/g;

const textOf = (block) => (block.children ?? []).map((c) => c.text ?? "").join("");

/** Trim whitespace from both ends of a span array, dropping spans left empty. */
function trimEdges(spans) {
	const out = spans.map((s) => ({ ...s }));

	while (out.length && out[0].text.trim() === "") out.shift();
	if (out.length) out[0].text = out[0].text.replace(/^\s+/, "");

	while (out.length && out[out.length - 1].text.trim() === "") out.pop();
	if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, "");

	return out.filter((s) => s.text !== "");
}

/**
 * Slice a block's spans to the [start, end) range of its concatenated text,
 * keeping every span's marks. Text can already be spread over several spans
 * (markup boundaries, and the newlines themselves), so this cannot assume a
 * split falls between spans — it may land inside one.
 */
function sliceChildren(children, start, end, keyPrefix) {
	const out = [];
	let pos = 0;
	let n = 0;

	for (const span of children) {
		const text = span.text ?? "";
		const spanStart = pos;
		pos += text.length;

		const from = Math.max(start, spanStart);
		const to = Math.min(end, pos);
		if (from >= to) continue;

		out.push({
			_type: "span",
			_key: `${keyPrefix}-${n++}`,
			text: text.slice(from - spanStart, to - spanStart),
			...(span.marks ? { marks: span.marks } : {}),
		});
	}

	return trimEdges(out);
}

/**
 * Keep only the markDefs this fragment's spans actually reference. A link is
 * indirect — a span's mark is a _key pointing into the block's markDefs — so a
 * fragment carrying the span must carry the def, or the key dangles.
 */
function defsFor(children, markDefs) {
	if (!markDefs?.length) return undefined;

	const used = new Set(children.flatMap((c) => c.marks ?? []));
	const kept = markDefs.filter((d) => used.has(d._key));

	return kept.length ? kept : undefined;
}

/**
 * Split one block into paragraphs, or return it unchanged. Returns an array so
 * callers can flat-map.
 */
export function splitLongBlock(block) {
	if (block._type !== "block") return [block];
	if ((block.style ?? "normal") !== "normal") return [block];
	if (block.listItem) return [block];

	const full = textOf(block);
	if (full.length <= WALL_BLOCK_CHARS) return [block];

	SPLIT_PATTERN.lastIndex = 0;
	const cuts = [];
	for (const match of full.matchAll(SPLIT_PATTERN)) {
		cuts.push({ start: match.index + match[1].length, resume: match.index + match[0].length });
	}
	if (!cuts.length) return [block];

	// Walk the text, emitting a paragraph between each pair of cut points.
	const ranges = [];
	let cursor = 0;
	for (const cut of cuts) {
		ranges.push([cursor, cut.start]);
		cursor = cut.resume;
	}
	ranges.push([cursor, full.length]);

	// Drop the original markDefs from the spread: each fragment carries only the
	// defs its own spans reference, and a spread would put the full list back.
	const { markDefs, ...rest } = block;

	const parts = [];
	for (const [start, end] of ranges) {
		const children = sliceChildren(block.children ?? [], start, end, `${block._key}-s${parts.length}`);
		if (!children.length) continue; // blank runs become empty paragraphs; drop them
		const defs = defsFor(children, markDefs);
		parts.push({
			...rest,
			_key: `${block._key}-p${parts.length}`,
			children,
			...(defs ? { markDefs: defs } : {}),
		});
	}

	// One paragraph is not a split: leave the original alone rather than
	// renumber its keys for nothing.
	return parts.length > 1 ? parts : [block];
}

/** Split a top-level block array. Galleries and columns are left untouched. */
export function splitLongBlocks(blocks) {
	return blocks.flatMap((block) => splitLongBlock(block));
}
