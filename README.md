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

|            | Worker            | Hostname                     |
| ---------- | ----------------- | ---------------------------- |
| Production | `xinchejian`      | `xinchejian.com` (and `www`) |
| Staging    | `xinchejian-beta` | `beta.xinchejian.com`        |

**They share one D1 database (`xinchejian`) and one R2 bucket (`xinchejian-media`).** Staging exists to preview new code against current content. A separate copy went stale as soon as either side was edited, and refreshing it meant a multi-hour site transfer, so it previewed content nobody was testing against. The price of sharing is that staging cannot test a schema change or an EmDash upgrade in isolation.

Staging is read-only in practice, through three deliberate constraints: its Worker runs `EMDASH_MIGRATIONS_MODE=check`, so it refuses to migrate the shared database and serves 503 while migrations are pending rather than mutating live data; it declares `"triggers": { "crons": [] }` (`triggers` is inherited by named environments, so omitting it would hand staging production's schedule and run maintenance twice); and its admin is left unused. Nothing *prevents* a signed-in admin on beta from writing to the shared database — to close that off, put a Cloudflare Access policy on `beta.xinchejian.com/_emdash/*`.

`www.xinchejian.com` is bound only so it can 301 to the apex. The Worker bundle is about 3.9 MB gzipped, so the account needs the **Workers Paid** plan: the free plan's limit is 3 MB.

Both live in `wrangler.jsonc` as the top level and the `beta` entry under `env`. **Named Wrangler environments inherit no bindings**, and the Cloudflare adapter flattens the selected environment into `dist/server/wrangler.json` during the build. So the environment is chosen with `CLOUDFLARE_ENV` *before the build*, not with `wrangler deploy --env`, which has nothing left to resolve against:

```sh
pnpm wrangler login                    # the account that owns the xinchejian.com zone
CLOUDFLARE_ENV=beta pnpm run deploy    # beta.xinchejian.com
pnpm run deploy                        # xinchejian.com
```

Wrangler adds the DNS record for each custom domain, and both Workers are reachable at `<worker>.<account>.workers.dev`, which helps tell DNS problems from app problems.

`beta.xinchejian.com` sends `X-Robots-Tag: noindex`, so search engines don't index a duplicate of the live site.

EmDash's object cache is backed by Workers KV: content, settings, menu and taxonomy reads are stored in the `CACHE` namespace instead of hitting D1 on every render. Each environment has its own namespace (`xinchejian-cache`, `xinchejian-beta-cache`) because the cache keys carry no host, so sharing one would let the two Workers read each other's values. Staging also runs a 60-second `defaultTtl` (`astro.config.mjs`), since it previews production's content and should not serve a stale read for a full hour the way production does.

The admin is at `/_emdash/admin` and signs in with a passkey. A passkey is bound to the domain it was registered for, so one created at the apex will not sign you in on beta, and one created on beta will not sign you in at the apex — but because the two share a users table, a beta-scoped passkey is a real account on production. That is one more reason to leave beta's admin alone. Losing the last passkey is recovered with a magic link when email is configured (below), and otherwise by resetting authentication in the database.

### Releases

`.github/workflows/deploy.yml` runs when a GitHub release is published: it builds and deploys beta, then waits for approval on the `production` environment before deploying the apex. Add required reviewers under **Settings → Environments → production**, or that second job runs unattended. Only the production job migrates; see [Migrations](#migrations).

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

Wrangler resolves each D1 database and R2 bucket by name and creates it when missing, so those Edit scopes are needed. KV namespaces are not created that way: a `kv_namespaces` entry must carry a real `id`, so the four namespaces (`xinchejian-session`, `xinchejian-cache` and their `-beta` counterparts) were created with `wrangler kv namespace create` and pinned in `wrangler.jsonc`. The `SESSION` namespace backs sessions and is what the Astro adapter expects; `CACHE` backs EmDash's object cache (see [Deploy](#deploy)). A token without KV access fails a deploy with `Authentication error [code: 10000]` on `/accounts/.../storage/kv/namespaces`. The Account scopes cannot be zone-restricted; set the Zone ones to `xinchejian.com`. Adding `User · User Details · Read` and `User · Memberships · Read` silences wrangler's warnings but is not required.

### Migrations

Core migrations run in the production job — build, `emdash migrate`, deploy, `emdash migrate --check` — not from the Worker's first request. Runtime mode (`migrations.runtime` default `"auto"`) applies pending migrations *inside* a request, under EmDash's own deadline. On a fresh database the set does not finish in time, the run is abandoned with the migration lock still held, and the site then serves pages without CMS data while every request waits for the lock first. The CLI has no deadline. Staging never migrates at all: its Worker runs `EMDASH_MIGRATIONS_MODE=check` against the shared database.

The production job reads its target from repository variables, because a non-interactive apply requires the exact fingerprint:

| Variable                    | Value                                                        |
| --------------------------- | ------------------------------------------------------------ |
| `D1_DATABASE_ID`            | production database UUID                                      |
| `EMDASH_TARGET_FINGERPRINT` | fingerprint from `emdash migrate --status` for that database  |

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

**A D1 database's primary region is fixed at creation, and one created by a CI deploy lands in the runner's region** — US, for GitHub-hosted runners. This bit a second database created for staging: WNAM against an APAC readership meant about 170 ms per query, pages roughly 8× slower, and a first migration set slow enough to blow the runtime deadline. Create a database explicitly and pin the UUID:

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
