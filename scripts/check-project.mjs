#!/usr/bin/env node
/**
 * check-project — standalone runner for the central monitoring service.
 *
 * The recommended way to run the tracker. Instead of wiring the workflow into
 * each consumer repo, you register a site in `projects/<id>.json` and run:
 *
 *   node scripts/check-project.mjs <projectId>          # one project
 *   node scripts/check-project.mjs --all                # every active project
 *   node scripts/check-project.mjs <id> --dry-run       # fetch, don't persist/notify
 *   node scripts/check-project.mjs <id> --validate-only # just check the descriptor
 *
 * For each project it loads the descriptor, injects the project's config into
 * process.env (SITE_URL, RANK_SOURCE, TOPVISOR_PROJECT_ID, SNAPSHOTS_DIR, …),
 * then calls weekly-check's main(). Secrets are read from the ambient env /
 * .env exactly as before — the registry never carries them.
 *
 * The run is read-only with respect to paid APIs: Topvisor history is read,
 * the paid checker is never started.
 */

import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { loadEnv } from './env.mjs';
import { loadProject, listProjects, RUNNABLE_STATUSES } from './project-registry.mjs';
import { main as runWeeklyCheck } from './weekly-check.mjs';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ─── CLI ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));

const all = flags.has('--all');
const dryRun = flags.has('--dry-run');
const validateOnly = flags.has('--validate-only');
const noSlack = flags.has('--no-slack');
const noTelegram = flags.has('--no-telegram');

// Load secrets from .env once up front. Per-project config env is applied
// later and takes precedence (env.mjs never overwrites already-set keys, and
// here we set project keys explicitly).
loadEnv();

const PROJECT_ENV_KEYS = [
  'SITE_URL',
  'SITE_PROPERTY',
  'SITE_NAME',
  'RANK_SOURCE',
  'NOTIFIER',
  'ENABLE_YANDEX',
  'CORE_PATH',
  'SNAPSHOTS_DIR',
  'TOPVISOR_PROJECT_ID',
  'TOPVISOR_REGIONS_INDEXES',
  'TOPVISOR_DATE_MODE',
];

/** Apply a project's config env to process.env (config only, never secrets). */
function applyProjectEnv(project) {
  // Reset every known config key first. Empty strings intentionally block the
  // later loadEnv() inside weekly-check.mjs from pulling stale legacy values
  // out of .env for this standalone project.
  for (const key of PROJECT_ENV_KEYS) {
    process.env[key] = '';
  }
  for (const [key, value] of Object.entries(project.env)) {
    process.env[key] = value;
  }
}

/** Print a one-line summary header for a project. */
function describe(project) {
  const bits = [
    project.rankSource,
    `notifier=${project.notifier}`,
    project.enableYandex ? 'yandex' : null,
  ].filter(Boolean);
  return `${BOLD}${project.name}${RESET} ${DIM}(${project.id} · ${project.domain} · ${bits.join(' · ')})${RESET}`;
}

/**
 * Run (or validate) a single normalized project. Returns a small result
 * descriptor for the --all summary. Never throws — failures are captured.
 */
async function runProject(project) {
  console.log(`\n${CYAN}▶${RESET} ${describe(project)} ${DIM}[${project.status}]${RESET}`);

  if (validateOnly) {
    console.log(`   ${GREEN}config valid${RESET} — core: ${project.corePath}`);
    return { id: project.id, outcome: 'validated' };
  }

  applyProjectEnv(project);

  // A project with no semantic core yet isn't an error — it's just not ready.
  // Degrade to a validate-only style skip instead of exiting non-zero.
  if (!existsSync(project.corePath)) {
    console.log(`   ${YELLOW}not ready${RESET} — semantic core missing at ${project.corePath}`);
    console.log(`   ${DIM}add keywords there (status: waiting_for_keywords), or run with --validate-only${RESET}`);
    return { id: project.id, outcome: 'skipped:no-core' };
  }

  // Make sure the per-project snapshots dir exists before the check writes to it.
  try {
    mkdirSync(project.snapshotsDir, { recursive: true });
  } catch { /* best-effort */ }

  try {
    await runWeeklyCheck({ dryRun, noSlack, noTelegram, skipLoadEnv: true });
    return { id: project.id, outcome: dryRun ? 'dry-run' : 'ok' };
  } catch (e) {
    console.error(`   ${RED}failed: ${e.message}${RESET}`);
    return { id: project.id, outcome: 'failed', error: e.message };
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  let projects;

  if (all) {
    const everything = listProjects();
    const skipped = everything.filter(p => !RUNNABLE_STATUSES.includes(p.status));
    projects = everything.filter(p => RUNNABLE_STATUSES.includes(p.status));

    console.log(`${BOLD}check-project --all${RESET} ${DIM}(${projects.length} active / ${everything.length} registered)${RESET}`);
    for (const p of skipped) {
      console.log(`   ${DIM}skip ${p.id} — status: ${p.status}${RESET}`);
    }
    if (projects.length === 0) {
      console.log(`\n${YELLOW}No active projects to run.${RESET}`);
      return;
    }
  } else {
    const id = positional[0];
    if (!id) {
      console.error(`${RED}Usage:${RESET} node scripts/check-project.mjs <projectId> | --all [--dry-run] [--validate-only]`);
      const known = listProjects().map(p => `${p.id} [${p.status}]`);
      if (known.length) console.error(`Known projects: ${known.join(', ')}`);
      process.exit(2);
    }
    projects = [loadProject(id)];
  }

  const results = [];
  for (const project of projects) {
    // Re-load each time under --all so per-project env from a prior iteration
    // never bleeds across (config keys are overwritten, but this keeps it tidy).
    results.push(await runProject(project));
  }

  // Summary (most useful for --all, harmless for a single project).
  console.log(`\n${BOLD}Summary${RESET}`);
  for (const r of results) {
    const mark = r.outcome === 'failed' ? `${RED}✗${RESET}`
      : r.outcome.startsWith('skipped') ? `${YELLOW}–${RESET}`
      : `${GREEN}✓${RESET}`;
    console.log(`   ${mark} ${r.id} — ${r.outcome}${r.error ? `: ${r.error}` : ''}`);
  }

  if (results.some(r => r.outcome === 'failed')) process.exit(1);
}

main().catch(e => {
  console.error(`\n${RED}Error: ${e.message}${RESET}`);
  console.error(e.stack);
  process.exit(1);
});
