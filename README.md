# seo-tracker

Reusable weekly SEO position monitor for Google Search Console (+ optional
Yandex.Webmaster). Saves snapshots, computes deltas, and notifies Slack
or Telegram. Zero npm dependencies — pure Node scripts plus a reusable
GitHub workflow.

## Quick start (consumer repo)

1. **Add `semantic-core.json` to the root of your repo** (see schema below).
2. **Create `.github/workflows/seo-weekly.yml`** with:

   ```yaml
   name: SEO Weekly

   on:
     schedule:
       - cron: '0 12 * * 1'   # every Monday 12:00 UTC
     workflow_dispatch:

   jobs:
     run:
       uses: golatam/seo-tracker/.github/workflows/weekly-check.yml@v1
       secrets: inherit
       with:
         site_url: https://example.com
         site_property: sc-domain:example.com
         notifier: slack          # slack | telegram | both | none
         enable_yandex: false
   ```

3. **Set GitHub Secrets** (Settings → Secrets → Actions). See the table below.
4. **First run** will create `snapshots/<date>.json`. Subsequent runs compare
   against the previous snapshot and send a delta report.

## Inputs

| Input            | Required | Default              | Description                                            |
|------------------|----------|----------------------|--------------------------------------------------------|
| `site_url`       | yes      | —                    | Site origin, no trailing slash (e.g. `https://x.com`). |
| `site_property`  | yes      | —                    | GSC property: `sc-domain:x.com` or `https://x.com/`.   |
| `site_name`      | no       | hostname of site_url | Display name in report headers.                        |
| `notifier`       | no       | `slack`              | `slack`, `telegram`, `both`, or `none`.                |
| `enable_yandex`  | no       | `false`              | Also fetch Yandex.Webmaster positions.                 |
| `rank_source`    | no       | `gsc`                | Position source: `gsc`, `topvisor`, `mixed` (reserved). |
| `topvisor_project_id` | no  | —                    | Topvisor project id; required for `rank_source=topvisor`. |
| `topvisor_regions` | no    | —                    | Comma-separated Topvisor region indexes, e.g. `1,2`.   |
| `topvisor_date_mode` | no  | `lastTwo`            | Topvisor history mode: `lastTwo` or `single`.          |
| `core_path`      | no       | `semantic-core.json` | Path relative to consumer repo root.                   |
| `snapshots_dir`  | no       | `snapshots`          | Where snapshot JSONs are written and committed.        |
| `package_ref`    | no       | `v1`                 | Git ref of seo-tracker to use (tag or branch).         |

## Secrets

| Secret                | When needed                                         |
|-----------------------|-----------------------------------------------------|
| `GSC_CLIENT_ID`       | always (GSC OAuth2)                                 |
| `GSC_CLIENT_SECRET`   | always                                              |
| `GSC_REFRESH_TOKEN`   | always                                              |
| `TOPVISOR_USER_ID`    | `rank_source=topvisor`                             |
| `TOPVISOR_API_TOKEN`  | `rank_source=topvisor`                             |
| `SLACK_BOT_TOKEN`     | `notifier=slack` or `both`                          |
| `SLACK_CHANNEL_ID`    | `notifier=slack` or `both`                          |
| `TELEGRAM_BOT_TOKEN`  | `notifier=telegram` or `both`                       |
| `TELEGRAM_CHAT_ID`    | `notifier=telegram` or `both`                       |
| `TELEGRAM_THREAD_ID`  | optional, for group topics                          |
| `YANDEX_OAUTH_TOKEN`  | `enable_yandex=true`                                |
| `YANDEX_USER_ID`      | optional (auto-detected if absent)                  |
| `YANDEX_HOST_ID`      | optional (auto-detected if absent)                  |

`secrets: inherit` in the caller workflow forwards every secret that exists
in the consumer repo. Secrets that are unused for the chosen `notifier` /
`enable_yandex` combination can be omitted.

## `semantic-core.json` schema

```jsonc
{
  // Optional. Maps page categories to display label + emoji + sort order.
  // Used by the Slack/Telegram report. Falls back to a single "Other" bucket.
  "clusters": {
    "core":       { "label": "Core",         "emoji": "📄", "order": 1 },
    "feature":    { "label": "Features",     "emoji": "🔧", "order": 2 },
    "competitor": { "label": "Alternatives", "emoji": "🆚", "order": 3 }
  },
  "pages": [
    {
      "url": "/pricing/",
      "category": "core",
      "keywords": [
        { "keyword": "pdf pricing",  "engines": ["google"], "priority": "high",   "tracked": true },
        { "keyword": "pdf vs word",  "engines": ["google"], "priority": "medium", "tracked": true }
      ]
    }
  ]
}
```

- `page.category` should match a key in `clusters` (otherwise it falls into "Other").
- `keyword.engines` is an array — use `["google"]` for GSC-only or `["google", "yandex"]` to also track in Yandex.Webmaster (requires `enable_yandex: true` and the relevant secrets).
- `keyword.tracked: false` excludes the keyword from the weekly check.
- `keyword.priority` is used by `report.mjs` for inline emphasis (`high`/`medium`/`low`).

## Rank sources

`rank_source=gsc` keeps the legacy behavior: Google positions come from GSC
average position, Yandex positions come from Yandex.Webmaster when
`enable_yandex=true`.

`rank_source=topvisor` makes Topvisor the source of truth for keyword ranks.
The integration is read-only: it uses Topvisor history endpoints and never
starts a paid checker run. GSC/Yandex data remains useful for analytics and
indexation checks, but no longer drives rank positions in the weekly report.

Example caller config:

```yaml
with:
  site_url: https://golatam.group
  site_property: sc-domain:golatam.group
  notifier: telegram
  rank_source: topvisor
  topvisor_project_id: '123456'
  topvisor_regions: '1,2'
  topvisor_date_mode: lastTwo
```

Required secrets for this mode:

```text
TOPVISOR_USER_ID
TOPVISOR_API_TOKEN
```

## Report formats

Each run still saves the canonical JSON snapshot under `snapshots/<date>.json`.
When there is a previous snapshot to compare against, the tracker also writes:

- `snapshots/reports/<date>-weekly.md` — full weekly report for humans;
- `snapshots/reports/<date>-positions.csv` — machine-readable keyword delta export.

Slack and Telegram now consume the same report model as the markdown/CSV
renderers, so digest numbers and artifact numbers stay aligned.

## Migration notes

1. Add `rank_source: topvisor` and Topvisor inputs to the consumer workflow.
2. Add `TOPVISOR_USER_ID` and `TOPVISOR_API_TOKEN` secrets.
3. Run workflow manually with `notifier: none` first and inspect the committed
   snapshot/report artifacts.
4. Enable Slack/Telegram notifications after the Topvisor region/searcher
   mapping looks right.

## What gets committed

After each run, the workflow commits new files under `snapshots/` back to
the consumer repo. The snapshot JSON contains:

- `entries[]` — per-keyword positions (`{ keyword, url, engine, position }`)
- `indexStatus[]` — GSC URL Inspection verdict per page
- `sitemap` — sitemap registration status (auto-submit attempted; gracefully
  degrades on `ACCESS_TOKEN_SCOPE_INSUFFICIENT`)

## Local dev (running scripts in a consumer repo)

```bash
cp .env.example .env       # fill in tokens
node /path/to/seo-tracker/scripts/weekly-check.mjs --dry-run
```

All paths resolve from `process.cwd()`, so run the scripts from your
consumer repo's root.

## Versioning

This package uses git tags (`v1.0.0`, `v1.1.0`, …) — no npm publish.
Consumers pin via `@v1` (latest v1.x) or `@v1.0.0` (exact).

## Repository visibility

The `seo-tracker` repo is **private**. Before the first run in a consumer
repo, enable: **Settings → Actions → General → Access →
"Accessible from repositories owned by the organization"** on `seo-tracker`.
Without this, callers get `workflow not found`.
