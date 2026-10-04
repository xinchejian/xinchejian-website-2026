# xcj-rebuild

The new [xinchejian.com](https://xinchejian.com): an [EmDash](https://github.com/emdash-cms/emdash) site on Cloudflare Workers, with D1 for the database and R2 for media.

- English is served at `/`, Chinese at the same path under `/zh/` (`/zh/2012/09/<slug>`). Each language is its own entry, linked as translations.
- Posts live at `/YYYY/MM/<slug>`, pages at `/<slug>`.
- Every page lists its language versions as `<link rel="alternate" hreflang="en-US|zh-CN|x-default">`, with `og:locale` `en_US`/`zh_CN`. The sitemaps use the same codes.
- The site is the EmDash blog template (`src/`).

## What you need

- Node.js 22+ and pnpm (`corepack enable` provides it)

## Run it locally

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:4321> (English) and <http://localhost:4321/zh> (Chinese). The admin is at <http://localhost:4321/_emdash/admin>; locally it logs you in automatically.

On a fresh database the site applies the schema and starter content from `seed/seed.json`.

To start again from an empty local site:

```sh
npx astro dev stop
rm -rf .wrangler/state
pnpm dev
```

## Deploy

Two Workers, both in the Cloudflare account that owns the `xinchejian.com` zone:

|             | Worker            | Hostname                       | D1               | R2                       |
| ----------- | ----------------- | ------------------------------ | ---------------- | ------------------------ |
| Production  | `xinchejian`      | `xinchejian.com` (and `www`)   | `xinchejian`     | `xinchejian-media`       |
| Staging     | `xinchejian-beta` | `beta.xinchejian.com`          | `xinchejian-beta`| `xinchejian-media-beta`  |

Each has its own database and bucket, so a staging build — and the core migrations its first request applies — cannot touch production content. `www.xinchejian.com` is bound only so it can 301 to the apex. The Worker bundle is about 3.9 MB gzipped, so the account needs the **Workers Paid** plan: the free plan's limit is 3 MB.

Both live in `wrangler.jsonc` as the top level and the `beta` entry under `env`. **Named Wrangler environments inherit no bindings**, and the Cloudflare adapter flattens the selected environment into `dist/server/wrangler.json` during the build. So the environment is chosen with `CLOUDFLARE_ENV` *before the build*, not with `wrangler deploy --env`, which has nothing left to resolve against:

```sh
pnpm wrangler login                    # the account that owns the xinchejian.com zone
CLOUDFLARE_ENV=beta pnpm run deploy    # beta.xinchejian.com
pnpm run deploy                        # xinchejian.com
```

The first deploy of each target creates its D1 database and R2 bucket, and wrangler adds the DNS record for each custom domain. Both are also reachable at `<worker>.<account>.workers.dev`, which helps tell DNS problems from app problems.

`beta.xinchejian.com` sends `X-Robots-Tag: noindex`, so search engines don't index a duplicate of the live site.

The admin is at `/_emdash/admin` and signs in with a passkey. A passkey is bound to the domain it was registered for, so one created at the apex will not sign you in on beta, and one created on beta will not sign you in at the apex. Losing the last passkey is recovered with a magic link when email is configured (below), and otherwise by resetting authentication in the database.

### Releases

`.github/workflows/deploy.yml` runs when a GitHub release is published: it builds and deploys beta, then waits for approval on the `production` environment before deploying the apex. Add required reviewers under **Settings → Environments → production**, or that second job runs unattended.

A hostname can only be bound to one Worker, so the beta job fails on the first run: the production Worker still holds `beta.xinchejian.com`. Release it once by deploying production with the current config (`pnpm run deploy` locally), which drops the beta route from the production Worker.

Two repository secrets are needed, both from the xinchejian Cloudflare account:

- `CLOUDFLARE_API_TOKEN` — scoped as below
- `CLOUDFLARE_ACCOUNT_ID` — the same value as the local `.env`

| Scope                      | Permission |
| -------------------------- | ---------- |
| Account · Workers Scripts  | Edit       |
| Account · Workers KV       | Edit       |
| Account · D1               | Edit       |
| Account · Workers R2       | Edit       |
| Account · Account Settings | Read       |
| Zone · Workers Routes      | Edit       |
| Zone · Zone                | Read       |

Wrangler resolves each D1 database, R2 bucket and KV namespace by name and creates it when missing, so all three Edit scopes are needed even though production's already exist — the staging Worker provisions its own on its first deploy. The `SESSION` KV namespace is not declared in `wrangler.jsonc`; the Astro adapter adds it for sessions, and a token without KV access fails the first staging deploy with `Authentication error [code: 10000]` on `/accounts/.../storage/kv/namespaces`. The Account scopes cannot be zone-restricted; set the Zone ones to `xinchejian.com`. Adding `User · User Details · Read` and `User · Memberships · Read` silences wrangler's warnings but is not required.

Staging starts empty, so run the setup wizard at <https://beta.xinchejian.com/_emdash/admin> before expecting content there. Copying production content over is not a straight `wrangler d1 export`: EmDash's FTS5 tables make a plain export fail outright, and adding `--table` silently drops the `users` table.

### Migrations

Core migrations run in the pipeline — build, `emdash migrate`, deploy, `emdash migrate --check` — not from the Worker's first request. Runtime mode (`migrations.runtime` default `"auto"`) applies pending migrations *inside* a request, under EmDash's own deadline. On a fresh database the set does not finish in time, the run is abandoned with the migration lock still held, and the site then serves pages without CMS data while every request waits for the lock first. The CLI has no deadline.

Both jobs read their target from repository variables, because a non-interactive apply requires the exact fingerprint:

| Variable                        | Value                                                        |
| ------------------------------- | ------------------------------------------------------------ |
| `D1_DATABASE_ID`                | production database UUID                                      |
| `EMDASH_TARGET_FINGERPRINT`     | fingerprint from `emdash migrate --status` for production     |
| `BETA_D1_DATABASE_ID`           | staging database UUID                                         |
| `BETA_EMDASH_TARGET_FINGERPRINT`| the same for staging                                          |

The fingerprint hashes the account and database identity, so it changes if a database is recreated. Update it only after checking the target that `--status` reports.

Migrating by hand needs `CLOUDFLARE_API_TOKEN` with D1 Edit (it is in `.env`, which is gitignored):

```sh
pnpm emdash migrate --status --d1 <database>   # inspect; note the lock id if one is held
pnpm emdash migrate --d1 <database>            # apply pending
```

A run that stops part-way leaves the lock held. Release it by id, then apply again:

```sh
pnpm wrangler d1 execute <database> --remote \
  --command "UPDATE _emdash_migrations_lock SET is_locked = 0 WHERE is_locked = <id>"
pnpm emdash migrate --d1 <database>
```

**A D1 database's primary region is fixed at creation, and one created by a CI deploy lands in the runner's region** — US, for GitHub-hosted runners. Staging's was, which put it in WNAM against an APAC readership: about 170 ms per query, pages roughly 8× slower, and a first migration set slow enough to blow the runtime deadline. Create new environments' databases explicitly and pin the UUID:

```sh
pnpm wrangler d1 create <name> --location apac
```

### Email

Outgoing mail (magic links, invites, comment notifications) goes through Cloudflare Email Sending, wired up by `cloudflareEmail()` in `astro.config.mjs` over the `EMAIL` binding in `wrangler.jsonc`. It sends as `it@xinchejian.com`.

Onboarding the sender domain is a wrangler command:

```sh
npx wrangler email sending enable xinchejian.com
npx wrangler email sending dns get xinchejian.com   # what it wrote
```

That adds MX, SPF and DKIM under `cf-bounce.` and a DMARC record at `_dmarc`. The apex MX (Google Workspace) and the apex SPF are left alone, so receiving and existing senders keep working.

Email Sending also writes a DMARC record at `_dmarc`, and its default is `v=DMARC1; p=reject;` — a strict policy on a domain that previously had none. Left in place, receivers reject any mail with `@xinchejian.com` in the From line that is neither SPF- nor DKIM-aligned: MailChimp, SendGrid, and anything still sending through the WordPress host are candidates. The record it writes is editable, so it was replaced with a monitoring policy:

```
_dmarc.xinchejian.com   TXT   "v=DMARC1; p=none; rua=mailto:it@xinchejian.com"
```

There must be exactly one DMARC record — a second one makes receivers ignore both. Once the aggregate reports show every legitimate sender aligning, tighten to `p=quarantine` and then `p=reject`.

Then deploy, activate the plugin under **Extensions**, select it under **Settings → Email**, and send a test email from **Settings → Email**.

The address mail actually reaches is the one on the admin's user record, so it has to be a mailbox someone reads.

### Cutover from WordPress

Done on 2026-10-04: `xinchejian.com` and `www.xinchejian.com` are bound to the Worker, and `www` 301s to the apex. It took two deploys because pointing `EMDASH_SITE_URL` at the apex also moves the passkey rpId, and a passkey is bound to the domain it was registered for — email went first so that magic-link recovery existed before the rpId changed.

`beta.xinchejian.com` is served by the separate `xinchejian-beta` Worker (see [Deploy](#deploy)) and is kept out of the index.

### The WordPress import is finished

The site was migrated from the old WordPress install by `scripts/wp-import/`, which is kept for reference. Content now lives in D1 and is edited in the admin.

**Do not run the import again, and never with `--refresh-content`.** The plan is a snapshot from the first import and has drifted — refreshing rewrites every entry that no longer matches it, reverting hand-made edits and blanking pages the plan holds as empty. To read the current content, pull it from D1. See [`scripts/wp-import/README.md`](scripts/wp-import/README.md) for which parts are still safe to run.

## Accounts and site data

Nothing in this repository grants an account. EmDash has no public sign-up, and an admin creates users by invite from the panel at `/_emdash/admin`.

For an account, access to the staging site, or a copy of the site's content and media, email **nihaopaul@gmail.com**.

Site content is not in this repository: entries live in D1 and media in R2, with [Deploy](#deploy) describing both environments. The WordPress import that seeded the content is a finished, historical migration and must not be re-run — see below.

## Branding

The XinCheJian wrench mark in `public/` and `src/components/Logo*` is the
hackerspace's own logo, traced from the old site's header image. It is included
so the site looks like itself, not as a grant: the MIT License covers copyright
only and gives you no rights in the XinCheJian name or logo. If you fork this
for another site, replace the mark and the title in `seed/seed.json` with your
own — an EmDash logo uploaded under **Settings → Site identity** overrides them
without touching any code.

## License

[MIT](LICENSE). The site in `src/` is built from the EmDash blog template and
`.agents/skills/` is EmDash's own documentation; both are MIT, and their
notices are retained in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
