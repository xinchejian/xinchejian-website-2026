#!/usr/bin/env node
// Write the retired WordPress upload URLs as a Cloudflare Bulk Redirects list.
//
// These cannot go in EmDash's redirect table: its middleware skips any path
// ending in a file extension before it matches (ASSET_EXTENSION in
// src/astro/middleware/redirect.ts), so /wp-content/uploads/....jpg never
// reaches a rule. Bulk Redirects are evaluated at the edge, ahead of the
// Worker, which is where a flat list of exact old URLs belongs.
//
// The output is a CSV for Rules -> Bulk Redirects. See
// https://developers.cloudflare.com/rules/url-forwarding/bulk-redirects/reference/csv-file-format/
//
// Usage: node scripts/wp-import/upload-redirects.mjs [--state f] [--export f] [--out f]

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { mediaForUpload } from "./lib/uploads.mjs";

const { values: args } = parseArgs({
	options: {
		state: { type: "string", default: ".import/state-xinchejian.com.json" },
		export: { type: "string", default: ".import/wp-export.json" },
		out: { type: "string", default: ".import/upload-redirects.csv" },
	},
});

const ORIGIN = "xinchejian.com";
const UPLOAD_URL = /\/wp-content\/uploads\/([^\s"'<>),\]]+)/g;

const snapshot = JSON.parse(await readFile(args.export, "utf8"));
const media = JSON.parse(await readFile(args.state, "utf8")).media ?? {};

// The attachment table names the originals; the bodies name the resized copies
// WordPress published in srcset, which is what a crawler most often indexed.
const paths = new Set(snapshot.attachments.filter((a) => a.file).map((a) => a.file));
for (const p of snapshot.posts) {
	for (const match of (p.content ?? "").matchAll(UPLOAD_URL)) paths.add(match[1]);
}

const rows = [];
let unresolved = 0;
for (const path of paths) {
	const item = mediaForUpload(media, path);
	// A file that never made it into the archive has no replacement, and 404ing
	// is more honest than pointing its old URL at some other image.
	if (!item?.url) {
		unresolved++;
		continue;
	}
	// Omitting the scheme matches both http and https; include_subdomains covers
	// the www form of each old URL, so one row serves every spelling of it.
	rows.push(`${encodeURI(`${ORIGIN}/wp-content/uploads/${path}`)},https://${ORIGIN}${encodeURI(item.url)},301,,TRUE`);
}

rows.sort();
await writeFile(args.out, `${rows.join("\n")}\n`);
console.log(`Wrote ${args.out}: ${rows.length} redirects (${unresolved} uploads have no media to point at)`);
