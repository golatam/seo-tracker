/**
 * Topvisor rank provider (READ-ONLY).
 *
 * Pulls position history from the Topvisor API v2 and normalizes it to the
 * tracker's RankEntry[] shape. This module is the only place that knows the
 * Topvisor wire format — everything downstream consumes normalized entries.
 *
 * MVP scope is strictly read-only:
 *   - get/positions_2/history   — position history
 *   - get/keywords_2/keywords   — keyword metadata (id ↔ name, group, url)
 *   - get/projects_2/projects   — diagnostics (project + searcher/region map)
 * We deliberately DO NOT call edit/positions_2/checker/go (that starts a paid
 * check). The tracker only reads what Topvisor already collected.
 *
 * Env:
 *   RANK_SOURCE             topvisor | gsc | mixed  (handled by weekly-check)
 *   TOPVISOR_USER_ID        account user id (header User-Id)
 *   TOPVISOR_API_TOKEN      API token (header Authorization: bearer ...)
 *   TOPVISOR_PROJECT_ID     project id to read
 *   TOPVISOR_REGIONS_INDEXES  comma-separated region indexes, e.g. "1,2"
 *   TOPVISOR_DATE_MODE      "lastTwo" (default) | "single"
 *
 * Secrets are never logged.
 */

import { requireEnv } from '../env.mjs';

const API_BASE = 'https://api.topvisor.com/v2/json';

// ─── Low-level client ────────────────────────────────────────────────

/**
 * POST to a Topvisor endpoint: `${operator}/${service}/${method}`.
 * Returns the parsed `result` field, throwing on transport or API errors.
 * Credentials come from env and are sent as headers, never logged.
 */
export async function topvisorRequest(operator, service, method, payload = {}) {
  const userId = requireEnv('TOPVISOR_USER_ID', 'Topvisor account user id');
  const token = requireEnv('TOPVISOR_API_TOKEN', 'Topvisor API token');

  const url = `${API_BASE}/${operator}/${service}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Id': userId,
      Authorization: `bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  let data;
  const raw = await res.text();
  try {
    data = JSON.parse(raw);
  } catch {
    // Don't echo the body — it may contain account data. Keep it generic.
    throw new Error(`Topvisor ${operator}/${service}/${method}: non-JSON response (HTTP ${res.status})`);
  }

  if (data && Array.isArray(data.errors) && data.errors.length > 0) {
    const msgs = data.errors.map((e) => e.string || e.message || e.code || 'unknown').join('; ');
    throw new Error(`Topvisor API error (${operator}/${service}/${method}): ${msgs}`);
  }
  if (!res.ok) {
    throw new Error(`Topvisor HTTP ${res.status} (${operator}/${service}/${method})`);
  }

  return data.result ?? data;
}

// ─── Read endpoints ──────────────────────────────────────────────────

/** List projects (diagnostics: verify project id + see searchers/regions). */
export function getProjects(extra = {}) {
  return topvisorRequest('get', 'projects_2', 'projects', {
    // Topvisor returns only `id` by default; request identity fields explicitly.
    fields: ['id', 'url', 'name'],
    show_searchers_and_regions: 1,
    ...extra,
  });
}

/** Keyword metadata for a project (id, name, group, target url). */
export function getKeywords(projectId, extra = {}) {
  return topvisorRequest('get', 'keywords_2', 'keywords', {
    project_id: Number(projectId),
    ...extra,
  });
}

/**
 * Position history for a project over a date range / region set.
 * `dates` is an array of YYYY-MM-DD strings (Topvisor returns a column per
 * date). `regionsIndexes` is an array of numeric region indexes.
 */
export function getHistory(projectId, { dates, regionsIndexes, extra = {} } = {}) {
  const payload = {
    project_id: Number(projectId),
    // request the fields we normalize from; harmless if some are ignored
    show_exists_dates: 1,
    show_visitors: 0,
    positions_fields: ['position', 'snippet', 'relevant_url'],
    ...extra,
  };
  if (Array.isArray(dates) && dates.length) payload.dates = dates;
  if (!payload.dates && !payload.date1 && !payload.date2) {
    const { date1, date2 } = defaultDateRange();
    payload.date1 = date1;
    payload.date2 = date2;
  }
  if (Array.isArray(regionsIndexes) && regionsIndexes.length) {
    payload.regions_indexes = regionsIndexes.map(Number);
  }
  return topvisorRequest('get', 'positions_2', 'history', payload);
}

function defaultDateRange(days = 30) {
  const date2 = new Date();
  const date1 = new Date(date2);
  date1.setUTCDate(date1.getUTCDate() - days);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { date1: fmt(date1), date2: fmt(date2) };
}

// ─── Normalization ───────────────────────────────────────────────────

function parseRegionsIndexes() {
  const raw = process.env.TOPVISOR_REGIONS_INDEXES;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

/**
 * Map a Topvisor searcher to our engine label. Topvisor identifies
 * searchers by id/name; we only care about google vs yandex for the tracker.
 * Prefer the explicit searcher name from projects_2 diagnostics because numeric
 * keys are account/provider-specific.
 */
function searcherToEngine(searcher) {
  const name = String(searcher?.searcher || searcher?.name || searcher || '').toLowerCase();
  if (name.includes('yandex')) return 'yandex';
  if (name.includes('google')) return 'google';
  return 'google';
}

function normalizeUrl(u) {
  if (!u) return undefined;
  try {
    return new URL(u).pathname.replace(/\/?$/, '/');
  } catch {
    return u; // already a path or unparseable — keep as-is
  }
}

function regionMeta(regionIndex, regions) {
  const r = regions.find((x) => Number(x.index) === Number(regionIndex) || Number(x.region_index) === Number(regionIndex));
  return {
    regionIndex: Number(regionIndex),
    regionName: r?.name || r?.region_name || undefined,
    engine: r ? searcherToEngine(r) : 'google',
    device: r?.device || (r?.device_id != null ? String(r.device_id) : 'desktop'),
  };
}

/**
 * Normalize a Topvisor positions/history result into RankEntry[].
 *
 * The history response shape varies by account/options. This parser is
 * defensive: it understands the common `result.keywords[].positionsData`
 * map keyed by "DATE:projectId:regionIndex" (or "DATE:regionIndex"), and
 * falls back gracefully when fields are missing. A keyword with no position
 * for the chosen date yields an entry with `position: null` rather than
 * being dropped.
 *
 * @param {object} history    result from getHistory()
 * @param {string} checkedAt  the date (YYYY-MM-DD) to extract positions for
 * @param {object} opts       { regions: [] } region metadata from getProjects()
 * @returns {Array} RankEntry[]
 */
export function normalizeHistory(history, checkedAt, opts = {}) {
  const regions = opts.regions || [];
  const entries = [];
  const keywords = (history && (history.keywords || history.result?.keywords)) || [];
  const wantRegions = parseRegionsIndexes();

  for (const kw of keywords) {
    const keyword = kw.name || kw.keyword || kw.title || '';
    const keywordId = kw.id != null ? `topvisor:${kw.id}` : undefined;
    const targetUrl = normalizeUrl(kw.url || kw.target_url || kw.targetUrl);
    const cluster = kw.group_name || kw.group || undefined;

    // positionsData: { "DATE:...:regionIndex": { position, relevant_url, ... } }
    const posData = kw.positionsData || kw.positions || kw.positions_data || {};
    const keys = Object.keys(posData);

    // Group the position cells that belong to our target date.
    const cellsForDate = keys
      .filter((k) => k.startsWith(`${checkedAt}:`) || k === checkedAt)
      .map((k) => ({ key: k, regionIndex: extractRegionIndex(k), cell: posData[k] }));

    // If no positionsData at all, still emit a null-position entry per region.
    const regionList = cellsForDate.length
      ? cellsForDate.map((c) => c.regionIndex).filter((r) => r != null)
      : (wantRegions.length ? wantRegions : [undefined]);

    const seen = new Set();
    for (const regionIndex of regionList) {
      if (wantRegions.length && regionIndex != null && !wantRegions.includes(Number(regionIndex))) continue;
      const dedupeKey = `${keyword}|${regionIndex}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const found = cellsForDate.find((c) => Number(c.regionIndex) === Number(regionIndex));
      const cell = found?.cell;
      const meta = regionIndex != null ? regionMeta(regionIndex, regions) : { regionIndex: undefined, regionName: undefined, engine: 'google', device: 'desktop' };

      const rawPos = cell?.position ?? cell?.pos ?? null;
      const position = rawPos == null || rawPos === '--' || rawPos === '' || Number(rawPos) > 100
        ? (rawPos == null || rawPos === '--' || rawPos === '' ? null : Number(rawPos))
        : Number(rawPos);
      const actualUrl = normalizeUrl(cell?.relevant_url || cell?.url);

      entries.push({
        keyword,
        keywordId,
        url: targetUrl || actualUrl,
        targetUrl,
        actualUrl,
        engine: meta.engine,
        regionIndex: meta.regionIndex,
        regionName: meta.regionName,
        device: meta.device,
        position: Number.isNaN(position) ? null : position,
        source: 'topvisor',
        checkedAt,
        cluster,
      });
    }
  }

  return entries;
}

function extractRegionIndex(key) {
  // keys look like "2026-06-29:project:region" or "2026-06-29:region"
  const parts = String(key).split(':');
  if (parts.length <= 1) return undefined;
  const last = parts[parts.length - 1];
  const n = Number(last);
  return Number.isNaN(n) ? undefined : n;
}

// ─── High-level entry point ──────────────────────────────────────────

/**
 * Fetch and normalize current Topvisor positions for the configured project.
 * Returns RankEntry[]. Picks the most recent available date from history.
 *
 * @param {object} options { dates?, regionsIndexes? } overrides for testing
 */
export async function fetchTopvisorPositions(options = {}) {
  const projectId = options.projectId || requireEnv('TOPVISOR_PROJECT_ID', 'Topvisor project id');
  const regionsIndexes = options.regionsIndexes || parseRegionsIndexes();

  // Diagnostics: pull region/searcher metadata (best-effort; non-fatal).
  let regions = [];
  try {
    const projects = await getProjects();
    const list = Array.isArray(projects) ? projects : projects?.projects || [];
    const project = list.find((p) => Number(p.id) === Number(projectId)) || list[0];
    regions = project?.searchers
      ? project.searchers.flatMap((s) => (s.regions || []).map((r) => ({ ...r, name: r.name, searcher: s.name, id: s.key ?? s.id })))
      : (project?.regions || []);
  } catch (e) {
    console.log(`   Topvisor: project diagnostics unavailable (${e.message})`);
  }

  // Determine which dates to request. Default: let Topvisor return its
  // available dates, then pick the latest. Callers can pin explicit dates.
  const history = await getHistory(projectId, {
    dates: options.dates,
    regionsIndexes,
  });

  const checkedAt = pickLatestDate(history, options.checkedAt);
  if (!checkedAt) {
    throw new Error('Topvisor: no dates available in history response');
  }

  return normalizeHistory(history, checkedAt, { regions });
}

/** Find the most recent date present in the history response. */
function pickLatestDate(history, override) {
  if (override) return override;
  // Topvisor returns the list of populated dates in a few possible places.
  const candidates =
    history?.dates ||
    history?.existsDates ||
    history?.exists_dates ||
    history?.headers?.dates ||
    [];
  const dates = (Array.isArray(candidates) ? candidates : Object.values(candidates))
    .map((d) => (typeof d === 'string' ? d : d?.date))
    .filter(Boolean)
    .sort();
  if (dates.length) return dates[dates.length - 1];

  // Fallback: scan positionsData keys for date prefixes.
  const kws = history?.keywords || [];
  const found = new Set();
  for (const kw of kws) {
    const pd = kw.positionsData || kw.positions || {};
    for (const k of Object.keys(pd)) {
      const m = String(k).match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) found.add(m[1]);
    }
  }
  const sorted = [...found].sort();
  return sorted.length ? sorted[sorted.length - 1] : null;
}
