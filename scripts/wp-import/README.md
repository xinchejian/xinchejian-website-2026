# WordPress import

The one-time migration that built this site from the old WordPress install.
**It has already run, and it is not meant to run again.**

The site's content now lives in **D1** and is edited in the admin. The site is
the source of truth. The plan under `.import/` is a snapshot of the site as it
looked when it was first imported, and it has drifted since: pages have been
rewritten by hand, notably `/contact-us` and `/zh/contact-us`.

**If you need the current content, pull it from D1. Do not reconstruct it from
the WordPress dump.**

## Do not run the import again

- **Never run `--refresh-content`.** It rewrites the body of every entry whose
  blocks differ from the plan, so it reverts every edit made since the import —
  and blanks any page the plan holds as empty. `/zh/contact-us` is exactly that:
  zero blocks in the plan, a full hand-written body on the site.
- A plain `pnpm wp:import` skips entries that already exist, so it will not
  overwrite anything. There is also nothing left for it to import.
- `--repair-upload-links` edits stored bodies and is likewise a migration-era
  tool; there are no WordPress upload URLs left to repair.

## What is still run from here

| Command | Writes to the live site? | Notes |
| --- | --- | --- |
| `pnpm wp:upload-redirects` | No | Regenerates `.import/upload-redirects.csv` for the Cloudflare Bulk Redirects list covering the retired `/wp-content/uploads/...` URLs. Reads the dump and the media state; writes a file only. |
| `pnpm wp:import --only redirects` | **Yes** | Reconciles the `WordPress migration` redirect group with the plan. It also **deletes** rules in that group the plan no longer lists. |
| `pnpm wp:transform` | No | Rebuilds `.import/plan.json`. Note it is not reproducible run-to-run — Portable Text `_key`s are random — so a regenerated plan differs byte-wise even with no code change. Harmless unless something then runs `--refresh-content`. |

Because of that last point, **add legacy URLs to the `buildPlan` redirect block
in `transform.mjs`, not by hand in the admin** — a hand-added rule in that group
disappears on the next sync.

## Why the uploads are not redirects

EmDash's redirect middleware skips any path ending in a file extension before it
matches a rule, so `/wp-content/uploads/....jpg` can never be served from the
redirect table. Those URLs are a Cloudflare Bulk Redirects list instead, which
is evaluated at the edge ahead of the Worker.

## The stages

    load-dump.sh  →  extract.mjs  →  transform.mjs  →  import.mjs

- **`load-dump.sh`** loads the WordPress SQL dump into a local podman MariaDB.
- **`extract.mjs`** reads that database into `.import/wp-export.json`.
- **`transform.mjs`** turns the snapshot into a plan: one entry per post/page per
  language, with Portable Text bodies, term assignments and redirects.
- **`import.mjs`** pushes the plan into a running EmDash site over its HTTP API.
  It is idempotent and resumable — progress lives in `.import/state-<host>.json`.

Media is referenced in the plan as `wp-upload:<path>` and resolved at import
time against the media the site actually stored, so the plan carries no storage
keys.
