#!/usr/bin/env node
// Dump the parts of the WordPress database the migration needs into a JSON
// snapshot, so the transform/import steps can run without MySQL.
//
// Usage: node scripts/wp-import/extract.mjs [out.json]
// Connection: WP_DB_SOCKET (default /run/mysqld/mysqld.sock) or WP_DB_HOST,
// plus WP_DB_USER (root), WP_DB_PASSWORD, WP_DB_NAME (wordpress), WP_DB_PREFIX (wp_).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import mysql from "mysql2/promise";

const out = process.argv[2] ?? ".import/wp-export.json";
const prefix = process.env.WP_DB_PREFIX ?? "wp_";

const db = await mysql.createConnection({
	...(process.env.WP_DB_HOST
		? { host: process.env.WP_DB_HOST, port: Number(process.env.WP_DB_PORT ?? 3306) }
		: { socketPath: process.env.WP_DB_SOCKET ?? "/run/mysqld/mysqld.sock" }),
	user: process.env.WP_DB_USER ?? "root",
	password: process.env.WP_DB_PASSWORD ?? "",
	database: process.env.WP_DB_NAME ?? "wordpress",
	charset: "utf8mb4",
	dateStrings: true,
});

const q = async (sql, params = []) => (await db.query(sql.replaceAll("wp_", prefix), params))[0];

const options = Object.fromEntries(
	(
		await q(
			`select option_name, option_value from wp_options where option_name in
			 ('blogname','blogdescription','siteurl','home','permalink_structure',
			  'qtranslate_enabled_languages','qtranslate_default_language','qtranslate_url_mode')`,
		)
	).map((r) => [r.option_name, r.option_value]),
);

const posts = await q(
	`select p.ID id, p.post_type type, p.post_status status, p.post_name slug,
	        p.post_title title, p.post_content content, p.post_excerpt excerpt,
	        p.post_date date, p.post_date_gmt date_gmt, p.post_modified_gmt modified_gmt,
	        p.post_parent parent, p.menu_order menu_order, u.display_name author,
	        u.user_nicename author_slug,
	        (select meta_value from wp_postmeta m where m.post_id = p.ID and m.meta_key = '_thumbnail_id' limit 1) thumbnail_id
	   from wp_posts p left join wp_users u on u.ID = p.post_author
	  where p.post_type in ('post','page') and p.post_status = 'publish'
	  order by p.post_date`,
);

const attachments = await q(
	`select p.ID id, p.post_parent parent, p.guid guid, p.post_title title,
	        p.post_excerpt caption, p.post_mime_type mime, p.menu_order menu_order,
	        (select meta_value from wp_postmeta m where m.post_id = p.ID and m.meta_key = '_wp_attached_file' limit 1) file,
	        (select meta_value from wp_postmeta m where m.post_id = p.ID and m.meta_key = '_wp_attachment_image_alt' limit 1) alt
	   from wp_posts p where p.post_type = 'attachment'`,
);

const terms = await q(
	`select tt.term_taxonomy_id id, t.term_id term_id, tt.taxonomy taxonomy, t.name name,
	        t.slug slug, tt.parent parent, tt.description description, tt.count count
	   from wp_term_taxonomy tt join wp_terms t on t.term_id = tt.term_id
	  where tt.taxonomy in ('category','post_tag')`,
);

const relationships = await q(
	`select tr.object_id post_id, tr.term_taxonomy_id term_id
	   from wp_term_relationships tr join wp_term_taxonomy tt on tt.term_taxonomy_id = tr.term_taxonomy_id
	  where tt.taxonomy in ('category','post_tag')`,
);

await db.end();

await mkdir(dirname(out), { recursive: true });
await writeFile(
	out,
	JSON.stringify({ extractedAt: new Date().toISOString(), options, posts, attachments, terms, relationships }, null, 1),
);
console.log(
	`Wrote ${out}: ${posts.length} posts/pages, ${attachments.length} attachments, ${terms.length} terms`,
);
