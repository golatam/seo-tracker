/**
 * seo-tracker — package config
 *
 * Project-neutral constants and helpers. Per-project values live in env
 * (SITE_URL, SITE_PROPERTY, NOTIFIER, ENABLE_YANDEX, SITE_NAME) and in
 * semantic-core.json (cluster labels). Paths resolve from process.cwd()
 * so the same scripts work both for local dev and as a reusable workflow.
 */

import { resolve } from 'node:path';

/** Noise threshold: position changes within ±N are considered insignificant. */
export const NOISE_THRESHOLD = 2;

/** Alert: position drop of at least N. */
export const ALERT_DECLINE_THRESHOLD = 5;

/** Alert: dropping out of TOP-N. */
export const ALERT_TOP_THRESHOLD = 50;

// ─── Paths (resolved from CWD = consumer repo root) ─────────────────

export function getCorePath() {
  return process.env.CORE_PATH
    ? resolve(process.env.CORE_PATH)
    : resolve(process.cwd(), 'semantic-core.json');
}

export function getSnapshotsDir() {
  return process.env.SNAPSHOTS_DIR
    ? resolve(process.env.SNAPSHOTS_DIR)
    : resolve(process.cwd(), 'snapshots');
}

// ─── Identity ───────────────────────────────────────────────────────

/** Display name for report headers. Defaults to SITE_URL hostname. */
export function getSiteName() {
  if (process.env.SITE_NAME) return process.env.SITE_NAME;
  const url = process.env.SITE_URL;
  if (!url) return 'site';
  try { return new URL(url).hostname; } catch { return url; }
}

// ─── Notifiers ──────────────────────────────────────────────────────

/**
 * Parse NOTIFIER env. Accepts: slack | telegram | both | none.
 * Returns { slack: boolean, telegram: boolean }.
 */
export function getNotifiers() {
  const n = (process.env.NOTIFIER || 'slack').toLowerCase();
  return {
    slack: n === 'slack' || n === 'both',
    telegram: n === 'telegram' || n === 'both',
  };
}

// ─── Feature flags ──────────────────────────────────────────────────

export function isYandexEnabled() {
  const v = process.env.ENABLE_YANDEX;
  return v === 'true' || v === '1';
}

// ─── Clusters (read from semantic-core.json: core.clusters) ─────────

const FALLBACK_CLUSTERS = {
  unknown: { label: 'Other', emoji: '', order: 99 },
};

/**
 * Build cluster lookup from semantic-core.
 * Reads core.clusters (optional) — { [key]: { label, emoji, order } } —
 * and returns { labels, emoji, order: [keys sorted by order] }.
 * Falls back to a single "unknown" cluster if the field is absent.
 */
export function loadClusters(core) {
  const raw = (core && core.clusters) || FALLBACK_CLUSTERS;
  const entries = Object.entries(raw).map(([key, c]) => ({
    key,
    label: c.label || key,
    emoji: c.emoji || '',
    order: typeof c.order === 'number' ? c.order : 99,
  }));
  entries.sort((a, b) => a.order - b.order);
  const labels = {};
  const emoji = {};
  const order = [];
  for (const e of entries) {
    labels[e.key] = e.label;
    emoji[e.key] = e.emoji;
    order.push(e.key);
  }
  if (!labels.unknown) {
    labels.unknown = 'Other';
    emoji.unknown = '';
    order.push('unknown');
  }
  return { labels, emoji, order };
}
