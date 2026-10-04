import assert from "node:assert/strict";
import { test } from "node:test";
import { splitLongBlock } from "./blocks.mjs";
import { cjkRatio, fixMojibake, parseMarker, preprocess, stripCdata } from "./html.mjs";
import { splitQtx } from "./qtranslate.mjs";
import { wpautop } from "./wpautop.mjs";

test("splitQtx separates languages and shares untagged text", () => {
	assert.deepEqual(splitQtx("[:en]Hello[:zh]你好[:]", ["en", "zh"]), { en: "Hello", zh: "你好" });
	assert.deepEqual(splitQtx("<b>[:en]Hi[:zh]嗨[:]</b>", ["en", "zh"]), { en: "<b>Hi</b>", zh: "<b>嗨</b>" });
	assert.deepEqual(splitQtx("<!--:en-->A<!--:--><!--:zh-->甲<!--:-->", ["en", "zh"]), { en: "A", zh: "甲" });
	assert.equal(splitQtx("plain text", ["en", "zh"]), null);
});

test("wpautop turns blank lines into paragraphs and newlines into breaks", () => {
	assert.equal(wpautop("one\n\ntwo\nthree"), "<p>one</p>\n<p>two<br />\nthree</p>\n");
	assert.equal(wpautop("<ul>\n<li>a</li>\n</ul>"), "<ul>\n<li>a</li>\n</ul>\n");
	assert.match(wpautop("<pre>a\n\nb</pre>"), /<pre>a\n\nb<\/pre>/);
});

test("fixMojibake repairs double-encoded UTF-8 and leaves real text alone", () => {
	assert.equal(fixMojibake("æ–°å¹´å¿«ä¹\u0090"), "新年快乐");
	assert.equal(fixMojibake("Itâ€™s"), "It’s");
	assert.equal(fixMojibake("café 中文"), "café 中文");
});

test("stripCdata removes stray CDATA wrappers", () => {
	assert.equal(stripCdata("\n\t<![CDATA[<p>x</p>]]>"), "<p>x</p>");
});

test("cjkRatio measures Chinese text share", () => {
	assert.ok(cjkRatio("<p>四轴飞行器进展</p>") > 0.9);
	assert.equal(cjkRatio("<p>quadcopter</p>"), 0);
});

test("preprocess converts shortcodes and players to markers", () => {
	const { html } = preprocess('[caption width="300"]<img src="/a.jpg" /> A caption[/caption]');
	assert.match(html, /<figure><img src="\/a.jpg" \/><figcaption>A caption<\/figcaption><\/figure>/);

	const iframe = preprocess('<iframe src="//player.youku.com/embed/X"></iframe>').html;
	const marker = parseMarker(iframe.match(/<p>(.*)<\/p>/)[1]);
	assert.deepEqual(marker, { type: "embed", url: "https://player.youku.com/embed/X" });

	const gallery = parseMarker(preprocess('[gallery ids="1,2"]').html.match(/<p>(.*)<\/p>/)[1]);
	assert.deepEqual(gallery, { type: "gallery", ids: [1, 2] });
});

test("entryPath matches the WordPress permalinks", async () => {
	const { entryPath } = await import("../transform.mjs");
	assert.equal(entryPath("posts", "weekly-update", "en", "2012-09-05T13:48:12.000Z"), "/2012/09/weekly-update");
	assert.equal(entryPath("posts", "中文", "zh", "2012-08-01T00:30:00.000Z"), "/zh/2012/08/%E4%B8%AD%E6%96%87");
	assert.equal(entryPath("pages", "membership", "zh", "2011-01-01T00:00:00.000Z"), "/zh/membership");
});

// --- Paragraph recovery for wall-of-text posts ---------------------------

const textOf = (block) => (block.children ?? []).map((c) => c.text ?? "").join("");
const para = (text, extra = {}) => ({
	_type: "block",
	_key: "b1",
	style: "normal",
	children: [{ _type: "span", _key: "s1", text }],
	...extra,
});
// Comfortably over the 1000-character threshold.
const long = (s) => s.repeat(Math.ceil(1100 / s.length));

test("splitLongBlock breaks a wall of text at sentence-ending newlines", () => {
	const a = long("Ever since Kin was little he dreamed of flying. ");
	const b = long("Afterwards he started reading about how helicopters work. ");
	const parts = splitLongBlock(para(`${a.trim()}\n${b.trim()}`));

	assert.equal(parts.length, 2);
	assert.match(textOf(parts[0]), /^Ever since Kin/);
	assert.match(textOf(parts[0]), /dreamed of flying\.$/);
	assert.match(textOf(parts[1]), /^Afterwards he started/);
});

test("splitLongBlock leaves short blocks untouched", () => {
	const short = para("One line\nAnother line.");
	assert.deepEqual(splitLongBlock(short), [short]);
});

test("splitLongBlock ignores newlines that do not end a sentence", () => {
	// Hard wraps and list items end in a letter, so splitting there would shred
	// them. Source to Rocket's tank robot has 76 such newlines and only 5 after
	// a sentence.
	const wrapped = para(long("The Insectbot kit includes the following:\n\t- Arduino board\n\t- 2 Servo\n"));
	assert.equal(splitLongBlock(wrapped).length, 1);
});

test("splitLongBlock leaves headings and list items alone", () => {
	const heading = para(long("A very long heading. "), { style: "h2" });
	assert.equal(splitLongBlock(heading).length, 1);
	const item = para(long("A very long list item. "), { listItem: "bullet" });
	assert.equal(splitLongBlock(item).length, 1);
});

test("splitLongBlock drops empty fragments from leading and repeated newlines", () => {
	// meet-your-makers-spring opens with a newline; several posts have runs.
	const parts = splitLongBlock(para(`\n${long("Who are you? ")}\n\n\n\n${long("Spring Wang. ")}`));
	assert.equal(parts.length, 2);
	for (const p of parts) assert.notEqual(textOf(p).trim(), "");
});

test("splitLongBlock preserves marks across the split", () => {
	const block = {
		_type: "block",
		_key: "b1",
		style: "normal",
		children: [
			{ _type: "span", _key: "s1", text: long("Plain text here. ") },
			// ends on a sentence boundary, so the split lands after it
			{ _type: "span", _key: "s2", text: `${long("Bold text here. ").trimEnd()}\n`, marks: ["strong"] },
			{ _type: "span", _key: "s3", text: long("More plain text. ") },
		],
	};
	const parts = splitLongBlock(block);
	assert.ok(parts.length >= 2, `expected a split, got ${parts.length} part(s)`);
	const bolded = parts.flatMap((p) => p.children).filter((c) => c.marks?.includes("strong"));
	assert.ok(bolded.length, "the strong-marked span survives the split");
	for (const b of bolded) assert.equal(b.marks[0], "strong");
});

test("splitLongBlock carries only the markDefs a fragment references", () => {
	const block = {
		_type: "block",
		_key: "b1",
		style: "normal",
		children: [
			{ _type: "span", _key: "s1", text: `${long("Sign up here. ").trimEnd()}\n`, marks: ["key-1"] },
			{ _type: "span", _key: "s2", text: long("Nothing linked in this one. ") },
		],
		markDefs: [
			{ _type: "link", _key: "key-1", href: "/upcoming-workshop" },
			{ _type: "link", _key: "unused", href: "/nowhere" },
		],
	};
	const parts = splitLongBlock(block);
	assert.ok(parts.length >= 2, `expected a split, got ${parts.length} part(s)`);
	for (const p of parts) {
		for (const def of p.markDefs ?? []) {
			const used = p.children.some((c) => c.marks?.includes(def._key));
			assert.ok(used, `${def._key} is not left dangling in a fragment that never uses it`);
		}
	}
});

// --- Legacy addresses that need a redirect --------------------------------
// These are not derivable from a post or page row, so they are listed in
// buildPlan by hand. They are what the old site's own links and the beta 404
// log showed still missing.

const emptySnapshot = { options: {}, posts: [], attachments: [], terms: [], relationships: [] };
const destinationsBySource = (plan) => new Map(plan.redirects.map((r) => [r.source, r.destination]));

test("buildPlan redirects the WordPress feed aliases to the new feed", async () => {
	const { buildPlan } = await import("../transform.mjs");
	const targets = destinationsBySource(buildPlan(emptySnapshot));

	assert.equal(targets.get("/feed/"), "/rss.xml");
	assert.equal(targets.get("/feed"), "/rss.xml");
	assert.equal(targets.get("/feed/atom/"), "/rss.xml");
	assert.equal(targets.get("/feed/rss/"), "/rss.xml");
	assert.equal(targets.get("/comments/feed/"), "/rss.xml");
	// WordPress advertises a feed in every page head; they are all patterns
	// rather than one rule per page.
	assert.equal(targets.get("/[slug]/feed/"), "/rss.xml");
	assert.equal(targets.get("/[slug]/feed"), "/rss.xml");
	// The Chinese pages keep their own feed.
	assert.equal(targets.get("/zh/feed/"), "/zh/rss.xml");
	assert.equal(targets.get("/zh/[slug]/feed/"), "/zh/rss.xml");
});

test("buildPlan redirects the old blog pager and the /event/ alias", async () => {
	const { buildPlan } = await import("../transform.mjs");
	const targets = destinationsBySource(buildPlan(emptySnapshot));

	// The old index paginated at /page/2/; the new one uses ?cursor=.
	assert.equal(targets.get("/page/[n]/"), "/posts");
	assert.equal(targets.get("/page/[n]"), "/posts");
	assert.equal(targets.get("/zh/page/[n]/"), "/zh/posts");
	// WordPress answered /event/ with a redirect of its own.
	assert.equal(targets.get("/event/"), "/event2");
});

test("buildPlan redirects nested category archives to the flat term URL", async () => {
	const { buildPlan } = await import("../transform.mjs");
	const plan = buildPlan({
		...emptySnapshot,
		terms: [
			{ id: 10, term_id: 1, taxonomy: "category", name: "urban farming", slug: "urban-farming", parent: 0, count: 2 },
			{ id: 11, term_id: 2, taxonomy: "category", name: "aquaponic", slug: "aquaponic", parent: 1, count: 1 },
		],
	});
	const targets = destinationsBySource(plan);

	// The old site nested a child term under its parent; every term is now
	// served at /category/<slug>.
	assert.equal(targets.get("/category/urban-farming/aquaponic"), "/category/aquaponic");
	assert.equal(targets.get("/category/urban-farming/aquaponic/"), "/category/aquaponic");
	// A top-level term keeps its address, so it gets no redirect of its own.
	assert.equal(targets.has("/category/urban-farming"), false);
});

test("buildPlan redirects the translated Tools subtree to the flat page URLs", async () => {
	const { buildPlan } = await import("../transform.mjs");
	const targets = destinationsBySource(buildPlan(emptySnapshot));

	// The Tools page links its children through the translated parent slug,
	// in percent-encoded form, and each child page now sits at the root.
	assert.equal(targets.get("/tools-%E5%B7%A5%E5%85%B7/[...path]"), "/[path]");
	assert.equal(targets.get("/zh/tools-%E5%B7%A5%E5%85%B7/[...path]"), "/zh/[path]");
});

test("buildPlan does not redirect retired upload paths", async () => {
	const { buildPlan } = await import("../transform.mjs");
	const attachment = (id, file) => ({ id, file, mime: "image/jpeg", parent: 0, menu_order: 0, title: file, alt: null, caption: "" });
	const post = {
		id: 1, type: "post", slug: "p", title: "t", status: "publish", parent: 0, menu_order: 0,
		content: '<img src="http://xinchejian.com/wp-content/uploads/2012/09/kite-300x200.jpg">',
		excerpt: "", date: "2012-09-01 00:00:00", date_gmt: "2012-09-01 00:00:00",
		modified_gmt: "2012-09-01 00:00:00", author: "a", author_slug: "a", thumbnail_id: 0,
	};
	const plan = buildPlan({ ...emptySnapshot, posts: [post], attachments: [attachment(6, "2012/09/kite.jpg")] });

	// EmDash's redirect middleware skips any path ending in a file extension, so
	// a rule for an upload can never match. Emitting one would only fill the
	// table with entries that never fire.
	assert.equal(plan.redirects.some((r) => r.source.includes("/wp-content/uploads/")), false);
});

// --- Links back to the WordPress uploads ----------------------------------

test("uploadKeys prefers the original over a resized copy, and knows the variants", async () => {
	const { uploadKeys } = await import("./uploads.mjs");
	// A resized copy resolves to the file WordPress stored.
	assert.equal(uploadKeys("2013/02/mind+event-283x400.png")[0], "2013/02/mind+event.png");
	// A "+" stripped on upload, and the "-1" WordPress adds to a duplicate name.
	assert.ok(uploadKeys("2013/02/mind+event.png").includes("2013/02/mindevent.png"));
	assert.ok(uploadKeys("2013/02/mind.png").includes("2013/02/mind-1.png"));
});

test("mediaForUpload resolves a resized copy to the media the original was stored as", async () => {
	const { mediaForUpload } = await import("./uploads.mjs");
	const media = { "2013/02/mind.png": { url: "/_emdash/api/media/file/01ABC.png" } };

	assert.equal(mediaForUpload(media, "2013/02/mind-283x400.png").url, "/_emdash/api/media/file/01ABC.png");
	assert.equal(mediaForUpload(media, "2013/02/mind.png").url, "/_emdash/api/media/file/01ABC.png");
	// A file that never made it into the archive has no media, and the caller
	// leaves its URL to 404 rather than pointing it at another image.
	assert.equal(mediaForUpload(media, "2013/02/absent.png"), null);
});

test("rewriteUploadLinks points old upload URLs at the media the site serves", async () => {
	const { rewriteUploadLinks } = await import("./uploads.mjs");
	const media = {
		"2013/02/mind.png": "/_emdash/api/media/file/01ABC.png",
		"2012/03/track-201204.pdf": "/_emdash/api/media/file/01DEF.pdf",
	};
	const lookup = (path) => media[path];
	const body = [
		{
			_type: "block",
			_key: "b1",
			children: [{ _type: "span", _key: "s1", text: "RoboRacing", marks: ["k1"] }],
			markDefs: [{ _type: "link", _key: "k1", href: "http://139.162.84.35/wp-content/uploads/2012/03/track-201204.pdf" }],
		},
		{ _type: "image", asset: { _ref: "01ABC" }, link: "https://xinchejian.com/wp-content/uploads/2013/02/mind.png" },
	];

	const { content, count } = rewriteUploadLinks(body, lookup);
	// The old site answered on its domain and on the server's address; both die
	// at cutover, so both move.
	assert.equal(count, 2);
	assert.equal(content[0].markDefs[0].href, "/_emdash/api/media/file/01DEF.pdf");
	assert.equal(content[1].link, "/_emdash/api/media/file/01ABC.png");
	// The input is left alone, so a dry run cannot disturb what it read.
	assert.equal(body[1].link, "https://xinchejian.com/wp-content/uploads/2013/02/mind.png");
});

test("rewriteUploadLinks leaves prose and third-party uploads alone", async () => {
	const { rewriteUploadLinks } = await import("./uploads.mjs");
	const lookup = () => "/_emdash/api/media/file/01ABC.png";
	const body = [
		{
			_type: "block",
			_key: "b1",
			children: [
				// An author who typed the URL as visible text keeps it.
				{ _type: "span", _key: "s1", text: "https://xinchejian.com/wp-content/uploads/2013/02/mind.png" },
			],
		},
		// Another site's uploads are not ours to move.
		{ _type: "block", _key: "b2", children: [{ _type: "span", _key: "s2", text: "x" }], markDefs: [{ href: "http://dorkbot.org/dorkbotshanghai/wp-content/uploads/a.png" }] },
	];

	const { content, count } = rewriteUploadLinks(body, lookup);
	assert.equal(count, 0);
	assert.equal(content[0].children[0].text, "https://xinchejian.com/wp-content/uploads/2013/02/mind.png");
	assert.equal(content[1].markDefs[0].href, "http://dorkbot.org/dorkbotshanghai/wp-content/uploads/a.png");
});

test("rewriteUploadLinks keeps a URL with no replacement", async () => {
	const { rewriteUploadLinks } = await import("./uploads.mjs");
	// The three files missing from the archive have nothing to point at.
	const body = [{ _type: "image", link: "https://xinchejian.com/wp-content/uploads/2011/01/gone.png" }];
	const { content, count } = rewriteUploadLinks(body, () => undefined);
	assert.equal(count, 0);
	assert.equal(content[0].link, "https://xinchejian.com/wp-content/uploads/2011/01/gone.png");
});
