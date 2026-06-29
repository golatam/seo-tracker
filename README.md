# seo-tracker

Central, standalone SEO position-monitoring service. One repo watches many
sites: each site is registered as a small JSON descriptor in `projects/`, the
runner reads keyword ranks (Topvisor read-only by default, GSC/Yandex as the
analytics + indexation layer), writes per-project snapshots and reports under
`data/`, and notifies Telegram or Slack.

Zero npm dependencies — pure Node ESM scripts. No service to host, no per-site
wiring: you add a project file and run one command (or one cron).

> **Architecture, in one line:** `projects/<id>.json` (what to watch) +
> ambient secrets in `.env` (how to reach the APIs) → `check-project.mjs` →
> `data/<id>/` (snapshots, reports) → Telegram/Slack.

---

## Quick start (standalone service)

```bash
git clone <this repo> && cd seo-tracker
cp .env.example .env          # fill in API tokens (secrets live ONLY here)

# 1. Register a site (no secrets in this file — config only):
#    projects/<id>.json   (see "Project descriptor" below)

# 2. Drop its keywords in:
#    data/<id>/semantic-core.json   (see "semantic-core.json schema" below)

# 3. Run it:
node scripts/check-project.mjs <id>              # one project
node scripts/check-project.mjs <id> --dry-run    # fetch, don't persist/notify
node scripts/check-project.mjs <id> --validate-only  # just check the descriptor
node scripts/check-project.mjs --all             # every "active" project
```

The first run writes `data/<id>/snapshots/<date>.json`. Later runs diff against
the previous snapshot, write a markdown + CSV report under
`data/<id>/snapshots/reports/`, and send a delta digest.

### Adding a new project (onboarding flow)

1. **Create `projects/<id>.json`.** The `id` must equal the file name. Minimal
   Topvisor example:

   ```json
   {
     "id": "acme",
     "name": "Acme",
     "domain": "acme.com",
     "rankSource": "topvisor",
     "topvisorProjectId": 123456,
     "notifier": "telegram",
     "status": "waiting_for_keywords"
   }
   ```

2. **Validate it:** `node scripts/check-project.mjs --validate-only acme`.
3. **Add keywords:** `data/acme/semantic-core.json` (schema below).
4. **Flip status to `active`** in the descriptor.
5. **Run:** `node scripts/check-project.mjs acme` (or wait for the `--all` cron).

A project with `status: waiting_for_keywords` (or a missing semantic core) is
**not an error** — `--all` skips it gracefully and the runner tells you what's
missing. That makes it safe to register sites before their keywords exist.

---

## Project descriptor (`projects/<id>.json`)

Config only — **never** secrets (the registry rejects secret-like keys with a
hard error). Paths resolve from the repo root; override the base dirs with
`PROJECTS_DIR` / `DATA_DIR`.

| Field               | Required | Default                         | Description                                              |
|---------------------|----------|---------------------------------|----------------------------------------------------------|
| `id`                | yes      | —                               | Must match the file name.                                |
| `name`              | yes      | —                               | Display name in reports.                                 |
| `domain`            | yes      | —                               | Bare hostname (e.g. `acme.com`).                         |
| `siteUrl`           | no       | `https://<domain>`              | Site origin.                                             |
| `siteProperty`      | no       | `sc-domain:<domain>`            | GSC property.                                            |
| `rankSource`        | no       | `gsc`                           | `topvisor`, `gsc`, or `mixed` (reserved).                |
| `topvisorProjectId` | when topvisor | —                          | Topvisor project id.                                     |
| `topvisorRegions`   | no       | all                             | Comma-separated region indexes, e.g. `"1,2"`.            |
| `topvisorDateMode`  | no       | `lastTwo`                       | Topvisor history mode.                                   |
| `enableYandex`      | no       | `false`                         | Also fetch Yandex.Webmaster positions.                   |
| `notifier`          | no       | `none`                          | `telegram`, `slack`, `both`, or `none`.                  |
| `status`            | no       | `draft`                         | Lifecycle — see below.                                   |
| `reportProfile`     | no       | `seo-weekly`                    | Report preset name.                                      |
| `data.corePath`     | no       | `data/<id>/semantic-core.json`  | Override the semantic-core location.                     |
| `data.snapshotsDir` | no       | `data/<id>/snapshots`           | Override the snapshots location.                         |

### Statuses

| Status                 | Runs on `--all`? | Meaning                                            |
|------------------------|------------------|----------------------------------------------------|
| `active`               | yes              | Fully configured; part of the weekly sweep.        |
| `waiting_for_keywords` | no (skipped)     | Registered, but no semantic core yet.              |
| `paused`               | no (skipped)     | Temporarily disabled.                              |
| `draft`                | no (skipped)     | Work in progress.                                  |

Only `active` projects execute under `--all`; the rest are listed as skipped so
nothing runs silently.

---

## Rank sources — Topvisor (primary) vs GSC

**`rankSource: topvisor` is the recommended primary source.** The integration
is strictly **read-only**: it pulls position history Topvisor has *already*
collected via `get/positions_2/history` (+ `get/keywords_2/keywords` and
`get/projects_2/projects` for metadata). It **never** calls
`edit/positions_2/checker/go`, which would start a *paid* check run. So the
tracker reads ranks for free and never spends Topvisor check credits — to
refresh positions you (or a Topvisor schedule) trigger the checker in Topvisor's
own UI.

**`rankSource: gsc`** keeps the legacy behavior: Google positions come from GSC
average position, Yandex from Yandex.Webmaster when `enableYandex: true`.

Regardless of rank source, GSC stays useful as the **analytics + indexation
layer**: URL Inspection verdicts and sitemap submission still run when GSC
credentials are present, and land in the snapshot's `indexStatus` / `sitemap`.

---

## Secrets & env

Secrets live **only** in `.env` (or the ambient environment / GitHub Secrets) —
never in `projects/*.json`. See `.env.example` for the annotated template.

| Secret                | When needed                            |
|-----------------------|----------------------------------------|
| `TOPVISOR_USER_ID`    | `rankSource: topvisor`                  |
| `TOPVISOR_API_TOKEN`  | `rankSource: topvisor`                  |
| `GSC_CLIENT_ID`       | GSC analytics/indexation, or `rankSource: gsc` |
| `GSC_CLIENT_SECRET`   | same                                    |
| `GSC_REFRESH_TOKEN`   | same                                    |
| `TELEGRAM_BOT_TOKEN`  | `notifier: telegram` or `both`          |
| `TELEGRAM_CHAT_ID`    | `notifier: telegram` or `both`          |
| `TELEGRAM_THREAD_ID`  | optional, for group topics (per project)|
| `SLACK_BOT_TOKEN`     | `notifier: slack` or `both`             |
| `SLACK_CHANNEL_ID`    | `notifier: slack` or `both`             |
| `YANDEX_OAUTH_TOKEN`  | `enableYandex: true`                    |

Config (non-secret) env knobs: `PROJECTS_DIR`, `DATA_DIR`. The runner derives
the per-project config env (`SITE_URL`, `RANK_SOURCE`, `TOPVISOR_PROJECT_ID`,
`SNAPSHOTS_DIR`, …) from the descriptor and injects it before each project —
you don't set those by hand in standalone mode.

> **Multi-project secrets caveat:** secrets are ambient, so a single `.env`
> shares one Topvisor/GSC account and one Telegram bot across all projects.
> Per-project *routing* (e.g. a Telegram thread per site) currently comes from
> a single `TELEGRAM_THREAD_ID`; running projects that need different accounts
> means separate runs with different env. See the architecture doc for the
> roadmap.

---

## `semantic-core.json` schema

```jsonc
{
  // Optional. Maps page categories to display label + emoji + sort order.
  // Falls back to a single "Other" bucket.
  "clusters": {
    "core":    { "label": "Core",     "emoji": "📄", "order": 1 },
    "feature": { "label": "Features", "emoji": "🔧", "order": 2 }
  },
  "pages": [
    {
      "url": "/pricing/",
      "category": "core",
      "keywords": [
        { "keyword": "pdf pricing", "engines": ["google"], "priority": "high",   "tracked": true },
        { "keyword": "pdf vs word", "engines": ["google"], "priority": "medium", "tracked": true }
      ]
    }
  ]
}
```

- `page.category` should match a key in `clusters` (otherwise → "Other").
- `keyword.engines` — `["google"]` for GSC-only, `["google","yandex"]` to also
  track in Yandex.Webmaster (needs `enableYandex: true` + the relevant secret).
- `keyword.tracked: false` excludes the keyword from the check.
- `keyword.priority` (`high`/`medium`/`low`) drives alert weighting + emphasis.

---

## Reports

Each run saves the canonical JSON snapshot under
`data/<id>/snapshots/<date>.json`. When a previous snapshot exists, it also
writes:

- `data/<id>/snapshots/reports/<date>-weekly.md` — full weekly report;
- `data/<id>/snapshots/reports/<date>-positions.csv` — raw keyword delta export.

Telegram/Slack consume the same report model as the markdown/CSV renderers, so
chat numbers and artifact numbers stay aligned. The snapshot carries
`entries[]` (per-keyword positions), `indexStatus[]` (GSC URL Inspection
verdict per page) and `sitemap` (registration status).

Snapshots and reports are meant to be committed — this repo is the source of
truth for position history across every project.

---

## Versioning

Git tags (`v1.0.0`, `v1.1.0`, …) — no npm publish.

---

## Compatibility: reusable GitHub workflow (legacy)

> The standalone service above is the primary, recommended way to run the
> tracker. The reusable workflow below predates it and is kept for the existing
> firmalo/golatam consumer repos that still call it. New projects should use the
> standalone registry instead.

Originally the tracker shipped as a reusable workflow that each consumer repo
wired in, keeping only its own `semantic-core.json`:

```yaml
name: SEO Weekly
on:
  schedule:
    - cron: '0 12 * * 1'
  workflow_dispatch:
jobs:
  run:
    uses: golatam/seo-tracker/.github/workflows/weekly-check.yml@v1
    secrets: inherit
    with:
      site_url: https://example.com
      site_property: sc-domain:example.com
      notifier: telegram          # slack | telegram | both | none
      rank_source: topvisor        # gsc | topvisor | mixed
      topvisor_project_id: '123456'
      enable_yandex: false
```

In this mode the consumer sets `with:` inputs (`site_url`, `site_property`,
`site_name`, `notifier`, `enable_yandex`, `rank_source`, `topvisor_project_id`,
`topvisor_regions`, `topvisor_date_mode`, `core_path`, `snapshots_dir`,
`package_ref`) and forwards secrets via `secrets: inherit`; data is committed
back to the consumer repo's `snapshots/` rather than this repo's `data/`. The
same Node scripts back both paths — `weekly-check.mjs` reads its config from
`process.env`, which the workflow populates from inputs and the standalone
runner populates from the descriptor.

Because the workflow is called cross-repo, `seo-tracker` must be **public**
(public→private cross-repo `workflow_call` is unsupported for user-owned
accounts — the 2026-05-18 incident; see `CLAUDE.md`).
