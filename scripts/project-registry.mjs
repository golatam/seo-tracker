/**
 * Project registry — the heart of the standalone monitoring service.
 *
 * In the standalone model the user does NOT wire the tracker into each site.
 * Instead every site is registered as an *observation target*: a small JSON
 * file in `projects/` describing what to watch and how to report. Secrets
 * never live here — only in env / .env. This module loads, validates and
 * normalizes those descriptors.
 *
 * Project descriptor (projects/<id>.json):
 *   {
 *     "id": "golatam",                 // must match the file name
 *     "name": "Go Latam",              // display name in reports
 *     "domain": "golatam.group",       // bare hostname
 *     "siteUrl": "https://golatam.group",        // optional, derived from domain
 *     "siteProperty": "sc-domain:golatam.group", // optional, derived from domain
 *     "rankSource": "topvisor",        // topvisor | gsc | mixed
 *     "topvisorProjectId": 29486769,   // required when rankSource=topvisor
 *     "topvisorRegions": "1,2",        // optional comma-separated region indexes
 *     "topvisorDateMode": "lastTwo",   // optional
 *     "enableYandex": false,           // optional
 *     "notifier": "telegram",          // telegram | slack | both | none
 *     "status": "active",              // active | waiting_for_keywords | paused | draft
 *     "reportProfile": "seo-weekly",   // report preset name
 *     "data": {                        // optional; defaults derived from id
 *       "corePath": "data/golatam/semantic-core.json",
 *       "snapshotsDir": "data/golatam/snapshots"
 *     }
 *   }
 *
 * Paths resolve relative to the service repo root (process.cwd()), overridable
 * via PROJECTS_DIR and DATA_DIR env vars.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

// ─── Vocabularies ────────────────────────────────────────────────────

export const RANK_SOURCES = ['topvisor', 'gsc', 'mixed'];
export const NOTIFIERS = ['telegram', 'slack', 'both', 'none'];

/**
 * Project lifecycle statuses.
 *   active              — fully configured, runs on `--all`
 *   waiting_for_keywords — registered, but no semantic core / keywords yet;
 *                          skipped by `--all`, runnable only as validate-only
 *   paused              — temporarily disabled; skipped by `--all`
 *   draft               — work in progress; skipped by `--all`
 */
export const STATUSES = ['active', 'waiting_for_keywords', 'paused', 'draft'];

/** Statuses that `--all` will actually execute. */
export const RUNNABLE_STATUSES = ['active'];

// Keys that would mean a secret leaked into the registry JSON. Hard error.
const FORBIDDEN_SECRET_KEYS = [
  'topvisorApiToken', 'topvisorUserId',
  'gscClientId', 'gscClientSecret', 'gscRefreshToken',
  'slackBotToken', 'slackChannelId',
  'telegramBotToken', 'telegramChatId', 'telegramThreadId',
  'yandexOauthToken',
];

// ─── Paths ───────────────────────────────────────────────────────────

export function getProjectsDir() {
  return process.env.PROJECTS_DIR
    ? resolve(process.env.PROJECTS_DIR)
    : resolve(process.cwd(), 'projects');
}

export function getDataDir() {
  return process.env.DATA_DIR
    ? resolve(process.env.DATA_DIR)
    : resolve(process.cwd(), 'data');
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Validate a raw project descriptor. Throws on the first hard problem.
 * Returns the descriptor unchanged so it can be used inline.
 */
export function validateProject(project, { id } = {}) {
  if (!project || typeof project !== 'object') {
    throw new Error(`Project ${id || '?'}: descriptor is not an object`);
  }

  const label = project.id || id || '?';

  for (const key of ['id', 'name', 'domain']) {
    if (!project[key] || typeof project[key] !== 'string') {
      throw new Error(`Project ${label}: missing required string field "${key}"`);
    }
  }

  if (id && project.id !== id) {
    throw new Error(`Project ${label}: id "${project.id}" does not match file name "${id}"`);
  }

  const rankSource = (project.rankSource || 'gsc').toLowerCase();
  if (!RANK_SOURCES.includes(rankSource)) {
    throw new Error(`Project ${label}: rankSource "${project.rankSource}" not in ${RANK_SOURCES.join('|')}`);
  }
  if (rankSource === 'topvisor' && project.topvisorProjectId == null) {
    throw new Error(`Project ${label}: rankSource=topvisor requires "topvisorProjectId"`);
  }

  const notifier = (project.notifier || 'none').toLowerCase();
  if (!NOTIFIERS.includes(notifier)) {
    throw new Error(`Project ${label}: notifier "${project.notifier}" not in ${NOTIFIERS.join('|')}`);
  }

  const status = (project.status || 'draft').toLowerCase();
  if (!STATUSES.includes(status)) {
    throw new Error(`Project ${label}: status "${project.status}" not in ${STATUSES.join('|')}`);
  }

  for (const key of FORBIDDEN_SECRET_KEYS) {
    if (key in project) {
      throw new Error(`Project ${label}: secret-like key "${key}" must NOT live in the registry JSON — put it in env/.env`);
    }
  }

  return project;
}

// ─── Normalization ───────────────────────────────────────────────────

/**
 * Fill defaults and derive computed fields. Returns a normalized project with
 * a flat `env` map ready to be merged into process.env by the runner.
 */
export function normalizeProject(raw) {
  const domain = raw.domain;
  const rankSource = (raw.rankSource || 'gsc').toLowerCase();
  const notifier = (raw.notifier || 'none').toLowerCase();
  const status = (raw.status || 'draft').toLowerCase();

  const siteUrl = raw.siteUrl || `https://${domain}`;
  const siteProperty = raw.siteProperty || `sc-domain:${domain}`;
  const enableYandex = raw.enableYandex === true;

  const dataDir = getDataDir();
  const corePath = raw.data?.corePath
    ? resolve(raw.data.corePath)
    : resolve(dataDir, raw.id, 'semantic-core.json');
  const snapshotsDir = raw.data?.snapshotsDir
    ? resolve(raw.data.snapshotsDir)
    : resolve(dataDir, raw.id, 'snapshots');

  const normalized = {
    id: raw.id,
    name: raw.name,
    domain,
    siteUrl,
    siteProperty,
    rankSource,
    topvisorProjectId: raw.topvisorProjectId != null ? String(raw.topvisorProjectId) : null,
    topvisorRegions: raw.topvisorRegions || '',
    topvisorDateMode: raw.topvisorDateMode || 'lastTwo',
    enableYandex,
    notifier,
    status,
    reportProfile: raw.reportProfile || 'seo-weekly',
    corePath,
    snapshotsDir,
  };

  // Env map: only project config, never secrets. Empty values are dropped so
  // they don't clobber anything inherited from the environment.
  const env = {
    SITE_URL: siteUrl,
    SITE_PROPERTY: siteProperty,
    SITE_NAME: raw.name,
    RANK_SOURCE: rankSource,
    NOTIFIER: notifier,
    ENABLE_YANDEX: String(enableYandex),
    CORE_PATH: corePath,
    SNAPSHOTS_DIR: snapshotsDir,
  };
  if (normalized.topvisorProjectId) env.TOPVISOR_PROJECT_ID = normalized.topvisorProjectId;
  if (normalized.topvisorRegions) env.TOPVISOR_REGIONS_INDEXES = normalized.topvisorRegions;
  if (normalized.topvisorDateMode) env.TOPVISOR_DATE_MODE = normalized.topvisorDateMode;

  normalized.env = env;
  return normalized;
}

// ─── Loaders ─────────────────────────────────────────────────────────

/** Load, validate and normalize a single project by id. */
export function loadProject(id) {
  const file = resolve(getProjectsDir(), `${id}.json`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    throw new Error(`Cannot read project "${id}" (${file}): ${e.message}`);
  }
  validateProject(raw, { id });
  return normalizeProject(raw);
}

/**
 * List every registered project (normalized). Invalid descriptors are skipped
 * with a warning rather than aborting the whole run, so one bad file doesn't
 * block monitoring the rest.
 */
export function listProjects() {
  const dir = getProjectsDir();
  let files = [];
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const projects = [];
  for (const f of files.sort()) {
    const id = basename(f, '.json');
    try {
      projects.push(loadProject(id));
    } catch (e) {
      console.warn(`Skipping invalid project "${id}": ${e.message}`);
    }
  }
  return projects;
}
