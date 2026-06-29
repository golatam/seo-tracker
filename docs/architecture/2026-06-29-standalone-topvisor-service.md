# Standalone Topvisor monitoring service

**Date:** 2026-06-29
**Status:** adopted (supersedes "reusable workflow per consumer" as the primary
model; that workflow is retained as a compatibility layer)

## Decision

Turn `seo-tracker` from a *library each site wires into its own repo* into a
**central monitoring service** that watches many sites from one place, with
**Topvisor as the primary, read-only rank source**.

Two things changed at once:

1. **Topology:** sites are registered as descriptors in `projects/`, not wired
   into consumer repos. One runner sweeps them all.
2. **Rank source:** Topvisor (read-only history) becomes primary; GSC/Yandex
   drop to the analytics + indexation layer.

## Why

- The reusable-workflow model needed per-repo wiring, cross-repo `secrets:
  inherit`, and forced `seo-tracker` public (public→private `workflow_call` is
  unsupported for user-owned accounts — the 2026-05-18 incident). Onboarding a
  site meant editing *that site's* repo.
- GSC "average position" is a misleading rank signal across mixed
  branded/non-branded keywords and regions. Topvisor gives exact, per-region,
  per-engine ranks that Topvisor already collects on its own schedule.
- A single service repo makes position history, reports and onboarding uniform
  across every project, and is the natural home for a future cross-project
  dashboard (v1.1).

## Architecture

```
                       .env  (SECRETS ONLY — never in projects/*.json)
                        │  TOPVISOR_*, GSC_*, TELEGRAM_*, SLACK_*, YANDEX_*
                        ▼
projects/<id>.json ─► check-project.mjs ─► weekly-check.mjs::main(opts)
   (what to watch)        │  loadProject()       │
   config only           │  validate (no         │  fetch ranks (Topvisor RO)
                         │  secret keys)         │  + GSC indexation/sitemap
                         │  normalize → env      │  diff vs previous snapshot
                         │  inject process.env   │  build report model
                         ▼                       ▼
                  RUNNABLE_STATUSES        data/<id>/snapshots/<date>.json
                  (--all runs `active`)    data/<id>/snapshots/reports/*.md,*.csv
                                                  │
                                                  ▼
                                          Telegram / Slack digest
```

### Layers

- **Registry** — `scripts/project-registry.mjs`. Loads/validates/normalizes
  `projects/<id>.json`. Hard-errors on secret-like keys (`FORBIDDEN_SECRET_KEYS`)
  so a token can never leak into config. Normalization derives `siteUrl`,
  `siteProperty`, data paths, and a flat **config-only** env map.
- **Runner** — `scripts/check-project.mjs`. Resolves which projects to run
  (`<id>` or `--all` filtered to `active`), injects each project's env, ensures
  `data/<id>/snapshots/`, calls `main()`. Modes: `--dry-run`, `--validate-only`,
  `--no-slack`, `--no-telegram`. Never throws per-project — failures are captured
  into a summary; a missing semantic core is a graceful skip, not an error.
- **Orchestrator** — `scripts/weekly-check.mjs`. `main(options)` runs one full
  cycle from `process.env`. Source-agnostic: `RANK_SOURCE=topvisor` pulls from
  the Topvisor provider; otherwise GSC/Yandex positions. The direct-CLI guard at
  the bottom is the legacy/workflow entry point.
- **Provider** — `scripts/providers/topvisor.mjs`. The only module that knows
  the Topvisor wire format. **Read-only:** `history`, `keywords`, `projects`.
  Deliberately never `edit/positions_2/checker/go`.

### Read-only vs paid (Topvisor)

| Operation                       | Endpoint                      | Used? | Cost            |
|---------------------------------|-------------------------------|-------|-----------------|
| Read position history           | `get/positions_2/history`     | yes   | free (read)     |
| Read keyword metadata           | `get/keywords_2/keywords`     | yes   | free (read)     |
| Read project/region map         | `get/projects_2/projects`     | yes   | free (read)     |
| **Start a check run**           | `edit/positions_2/checker/go` | **no**| **paid credits**|

The tracker only *reads* what Topvisor already collected. Refreshing positions
(the paid `checker/go`) is left to Topvisor's own schedule / UI — out of scope
for the tracker so an automated cron can never spend check credits.

## Onboarding flow (new project)

1. **`projects/<id>.json`** — `id` matches the file name; config only, no
   secrets. Set `rankSource`, `topvisorProjectId`, `notifier`, and
   `status: waiting_for_keywords`.
2. **Validate:** `node scripts/check-project.mjs --validate-only <id>`.
3. **`data/<id>/semantic-core.json`** — keywords + clusters (see README schema).
4. **Flip `status` to `active`.**
5. **Run:** `node scripts/check-project.mjs <id>`, then it joins the `--all`
   sweep (cron).

A descriptor without keywords stays `waiting_for_keywords` and is skipped by
`--all` — registering ahead of keywords is intentional and safe.

## Lifecycle statuses

| Status                 | `--all` | Meaning                                  |
|------------------------|---------|------------------------------------------|
| `active`               | runs    | Fully configured.                        |
| `waiting_for_keywords` | skip    | Registered, no semantic core yet.        |
| `paused`               | skip    | Temporarily disabled.                    |
| `draft`                | skip    | Work in progress.                        |

## Consequences

- **Secrets stay ambient.** One `.env` ⇒ one Topvisor/GSC account and one
  Telegram bot shared across projects. Per-project routing today is limited to a
  single `TELEGRAM_THREAD_ID`. Projects needing distinct accounts require
  separate runs with different env. Per-project secret namespacing is a known
  follow-up.
- **`searcherToEngine` mapping is provisional.** The Topvisor searcher↔engine
  map is account-specific; the provider has a heuristic + TODO to refine against
  a real `projects_2` response.
- **Legacy workflow retained.** firmalo/golatam still call the reusable workflow
  cross-repo. Both paths share the same Node scripts, so they don't diverge. New
  projects use the registry.

## Non-goals

- No paid Topvisor checks from the tracker (`checker/go`).
- No auto-sync of `semantic-core.json` → Topvisor keyword set.
- No web dashboard yet (v1.1, separate decision).
- Don't mix GSC average position and Topvisor exact position into one metric.
