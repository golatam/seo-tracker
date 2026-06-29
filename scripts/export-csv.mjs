/**
 * CSV export of keyword-level positions (raw appendix).
 *
 * Pure function: takes a report model and returns a CSV string.
 * weekly-check.mjs writes it to snapshots/reports/YYYY-MM-DD-positions.csv.
 *
 * Usage (standalone, against existing snapshots):
 *   node scripts/export-csv.mjs [--from=DATE] [--to=DATE]
 */

const COLUMNS = [
  'date',
  'keyword',
  'cluster',
  'page',
  'engine',
  'region',
  'device',
  'previous',
  'current',
  'delta',
  'priority',
  'actualUrl',
];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsv(model) {
  const date = model.currentDate || '';
  const rows = [COLUMNS.join(',')];

  for (const c of model.changes) {
    rows.push([
      date,
      c.keyword,
      c.category,
      c.url,
      c.engine,
      c.regionName ?? c.regionIndex ?? '',
      c.device ?? '',
      c.previousPosition ?? '',
      c.currentPosition ?? '',
      c.change ?? '',
      c.priority,
      c.actualUrl ?? c.url ?? '',
    ].map(csvCell).join(','));
  }

  return rows.join('\n') + '\n';
}

// ─── Standalone ──────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { getCorePath, getSnapshotsDir, loadClusters, getSiteName } = await import('../config.mjs');
  const { buildReportModel } = await import('./report-model.mjs');

  const args = process.argv.slice(2);
  const fromDate = args.find((a) => a.startsWith('--from='))?.split('=')[1];
  const toDate = args.find((a) => a.startsWith('--to='))?.split('=')[1];

  const dir = getSnapshotsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length < 2) {
    console.error('Need at least two snapshots.');
    process.exit(1);
  }
  const currFile = toDate ? `${toDate}.json` : files[files.length - 1];
  const before = files.filter((f) => f < currFile);
  const prevFile = fromDate ? `${fromDate}.json` : before[before.length - 1];

  const load = (f) => JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
  let core;
  try { core = JSON.parse(readFileSync(getCorePath(), 'utf-8')); } catch { core = { pages: [] }; }

  const model = buildReportModel(load(prevFile), load(currFile), core, {
    clusters: loadClusters(core),
    site: getSiteName(),
  });
  process.stdout.write(buildCsv(model));
}
