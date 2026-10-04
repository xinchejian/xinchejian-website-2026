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

The Worker is configured in `wrangler.jsonc` with `beta.xinchejian.com` as a custom domain; the cutover below adds `xinchejian.com` and `www.xinchejian.com` (which redirects to the apex). Every domain must be in the same Cloudflare account as the `xinchejian.com` zone. The Worker bundle is about 3.9 MB gzipped, so the account needs the **Workers Paid** plan: the free plan's limit is 3 MB.

```sh
pnpm wrangler login   # the account that owns the xinchejian.com zone
pnpm run deploy       # astro build && wrangler deploy
```

The first deploy created the D1 database `xinchejian` and the R2 bucket `xinchejian-media`; wrangler adds the DNS record for each custom domain. The site is also reachable at `xinchejian.<account>.workers.dev`, which helps tell DNS problems from app problems.

The admin is at `/_emdash/admin` and signs in with a passkey. A passkey is bound to the domain it was registered for, and EmDash keeps the session per host: a passkey created before the cutover (rpId `beta.xinchejian.com`) will not sign you in at the apex, and signing in at beta does not sign you in at the apex. A passkey created for the `xinchejian.com` rpId works at both. Losing the last passkey is recovered with a magic link when email is configured (below), and otherwise by resetting authentication in the database.

`beta.xinchejian.com` sends `X-Robots-Tag: noindex`, so search engines don't index a duplicate of the live site.

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

`beta.xinchejian.com` remains bound as staging and is kept out of the index; removing it is tracked in issue #21.

### The WordPress import is finished

The site was migrated from the old WordPress install by `scripts/wp-import/`, which is kept for reference. Content now lives in D1 and is edited in the admin.

**Do not run the import again, and never with `--refresh-content`.** The plan is a snapshot from the first import and has drifted — refreshing rewrites every entry that no longer matches it, reverting hand-made edits and blanking pages the plan holds as empty. To read the current content, pull it from D1. See [`scripts/wp-import/README.md`](scripts/wp-import/README.md) for which parts are still safe to run.

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
