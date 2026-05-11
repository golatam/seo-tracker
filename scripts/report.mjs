#!/usr/bin/env node
/**
 * Position change report — Firmalo.io
 *
 * Compares two snapshots and outputs:
 * — summary (improvements, drops, average position)
 * — cluster breakdown
 * — critical alerts
 *
 * Usage:
 *   node seo-tracking/scripts/report.mjs [--from=2026-01-15] [--to=2026-02-19] [--engine=google] [--category=core] [--json]
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOTS_DIR, ALERT_DECLINE_THRESHOLD, ALERT_TOP_THRESHOLD, NOISE_THRESHOLD } from '../config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = resolve(__dirname, '..', 'semantic-core.json');

// ANSI
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BG_RED = '\x1b[41m';
const BG_GREEN = '\x1b[42m';
const WHITE = '\x1b[37m';

// ─── Cluster labels ──────────────────────────────────────────────────

const CLUSTER_LABELS = {
  core: ':page_facing_up: Firma PDF',
  feature: ':wrench: Funciones',
  usecase: ':briefcase: Casos de uso',
  competitor: ':vs: Alternativas',
  unknown: ':grey_question: Otro',
};

const CLUSTER_ORDER = ['core', 'feature', 'usecase', 'competitor', 'unknown'];

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fromDate = args.find(a => a.startsWith('--from='))?.split('=')[1];
const toDate = args.find(a => a.startsWith('--to='))?.split('=')[1];
const engineFilter = args.find(a => a.startsWith('--engine='))?.split('=')[1];
const categoryFilter = args.find(a => a.startsWith('--category='))?.split('=')[1];
const jsonOutput = args.includes('--json');

// ─── Load data ───────────────────────────────────────────────────────

function getSnapshotFiles() {
  try {
    return readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.json')).sort();
  } catch { return []; }
}

function loadSnapshot(filename) {
  return JSON.parse(readFileSync(resolve(SNAPSHOTS_DIR, filename), 'utf-8'));
}

function loadSemanticCore() {
  try { return JSON.parse(readFileSync(CORE_PATH, 'utf-8')); }
  catch { return { pages: [] }; }
}

// ─── Main ────────────────────────────────────────────────────────────

const files = getSnapshotFiles();

if (files.length === 0) {
  console.log(`\n${YELLOW}No snapshots found.${RESET}\n`);
  process.exit(0);
}

if (files.length === 1 && !fromDate) {
  printSingleSnapshot(loadSnapshot(files[0]));
  process.exit(0);
}

let prevFile, currFile;
if (fromDate && toDate) {
  prevFile = `${fromDate}.json`;
  currFile = `${toDate}.json`;
} else if (toDate) {
  currFile = `${toDate}.json`;
  const before = files.filter(f => f < currFile);
  prevFile = before.length > 0 ? before[before.length - 1] : null;
} else {
  currFile = files[files.length - 1];
  prevFile = files.length > 1 ? files[files.length - 2] : null;
}

if (!prevFile) {
  printSingleSnapshot(loadSnapshot(currFile));
  process.exit(0);
}

const prevSnap = loadSnapshot(prevFile);
const currSnap = loadSnapshot(currFile);
const core = loadSemanticCore();

const entryKey = (e) => `${e.keyword}|${e.engine}`;

const prevMap = new Map();
for (const e of prevSnap.entries) prevMap.set(entryKey(e), e);

const currMap = new Map();
for (const e of currSnap.entries) currMap.set(entryKey(e), e);

const prevKeywords = new Set(prevSnap.entries.map(e => entryKey(e)));

function getKeywordMeta(keyword, url) {
  for (const page of core.pages) {
    if (page.url === url) {
      const kw = page.keywords.find(k => k.keyword === keyword);
      if (kw) return { priority: kw.priority, category: page.category };
    }
  }
  for (const page of core.pages) {
    const kw = page.keywords.find(k => k.keyword === keyword);
    if (kw) return { priority: kw.priority, category: page.category };
  }
  return { priority: 'medium', category: 'unknown' };
}

// ─── Calculate changes ───────────────────────────────────────────────

const allKeys = new Set([...prevMap.keys(), ...currMap.keys()]);
const changes = [];

for (const key of allKeys) {
  const [keyword, engine] = key.split('|');
  const prev = prevMap.get(key);
  const curr = currMap.get(key);
  const url = curr?.url || prev?.url || undefined;

  if (engineFilter && engine !== engineFilter) continue;
  if (categoryFilter) {
    const meta = getKeywordMeta(keyword, url);
    if (meta.category !== categoryFilter) continue;
  }

  const prevPos = prev?.position ?? null;
  const currPos = curr?.position ?? null;
  let change = null;
  if (prevPos !== null && currPos !== null) change = prevPos - currPos;

  const isNewlyTracked = !prevKeywords.has(key) && currPos !== null;
  const meta = getKeywordMeta(keyword, url);

  changes.push({
    keyword, url, engine,
    previousPosition: prevPos, currentPosition: currPos,
    change, priority: meta.priority, category: meta.category, isNewlyTracked,
  });
}

changes.sort((a, b) => {
  const aDropped = a.previousPosition !== null && a.currentPosition === null;
  const bDropped = b.previousPosition !== null && b.currentPosition === null;
  if (aDropped && !bDropped) return -1;
  if (!aDropped && bDropped) return 1;
  return (a.change ?? 0) - (b.change ?? 0);
});

// ─── Summary ─────────────────────────────────────────────────────────

function calcAvg(arr) {
  if (arr.length === 0) return 0;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

const summary = {
  totalKeywords: changes.length,
  improved: changes.filter(c => c.change !== null && c.change > 0).length,
  declined: changes.filter(c => c.change !== null && c.change < 0).length,
  unchanged: changes.filter(c => c.change === 0).length,
  noData: changes.filter(c => c.previousPosition === null && c.currentPosition === null).length,
  newInTop: changes.filter(c => c.previousPosition === null && c.currentPosition !== null && !c.isNewlyTracked).length,
  newlyTracked: changes.filter(c => c.isNewlyTracked).length,
  droppedFromTop: changes.filter(c => c.previousPosition !== null && c.currentPosition === null).length,
  avgPosition: calcAvg(changes.map(c => c.currentPosition).filter(p => p !== null)),
  prevAvgPosition: calcAvg(changes.map(c => c.previousPosition).filter(p => p !== null)),
};

if (jsonOutput) {
  console.log(JSON.stringify({ currentDate: currSnap.date, previousDate: prevSnap.date, summary, changes }, null, 2));
  process.exit(0);
}

// ─── Console report ──────────────────────────────────────────────────

console.log(`\n${BOLD}=======================================================${RESET}`);
console.log(`${BOLD}  Position report: ${prevSnap.date} -> ${currSnap.date}${RESET}`);
if (engineFilter) console.log(`${DIM}  Filter: ${engineFilter}${RESET}`);
console.log(`${BOLD}=======================================================${RESET}\n`);

const avgChange = summary.avgPosition - summary.prevAvgPosition;
const avgDir = avgChange < 0 ? `${GREEN}+${Math.abs(avgChange).toFixed(1)}${RESET}` : avgChange > 0 ? `${RED}-${avgChange.toFixed(1)}${RESET}` : '0';

console.log(`${BOLD}Summary:${RESET}`);
console.log(`  Keywords:        ${summary.totalKeywords}`);
console.log(`  ${GREEN}Improved:${RESET}        ${summary.improved}`);
console.log(`  ${RED}Declined:${RESET}        ${summary.declined}`);
console.log(`  Unchanged:       ${summary.unchanged}`);
if (summary.noData > 0) console.log(`  ${DIM}No data (N/A):${RESET}   ${summary.noData}`);
console.log(`  ${GREEN}Entered TOP:${RESET}     ${summary.newInTop}`);
console.log(`  ${RED}Left TOP:${RESET}        ${summary.droppedFromTop}`);
console.log(`  Avg position:    ${summary.prevAvgPosition} -> ${summary.avgPosition} (${avgDir})`);
console.log();

// Alerts
const alerts = changes.filter(c =>
  !c.isNewlyTracked && (
    (c.previousPosition !== null && c.currentPosition === null) ||
    (c.change !== null && c.change < -ALERT_DECLINE_THRESHOLD) ||
    (c.previousPosition !== null && c.previousPosition <= ALERT_TOP_THRESHOLD && c.currentPosition !== null && c.currentPosition > ALERT_TOP_THRESHOLD)
  )
);

if (alerts.length > 0) {
  console.log(`${BG_RED}${WHITE}${BOLD} ALERTS (${alerts.length}) ${RESET}\n`);
  for (const a of alerts) {
    console.log(`  ${RED}*${RESET} [${a.engine}] "${a.keyword}" ${formatPosition(a.previousPosition, a.currentPosition, a.change)}`);
    if (a.url) console.log(`    ${DIM}${a.url}${RESET}`);
  }
  console.log();
}

// Cluster detail
console.log(`${BOLD}By cluster:${RESET}\n`);

const byCluster = {};
for (const c of changes) {
  const cat = c.category || 'unknown';
  if (!byCluster[cat]) byCluster[cat] = [];
  byCluster[cat].push(c);
}

for (const cat of CLUSTER_ORDER) {
  const clusterChanges = byCluster[cat];
  if (!clusterChanges || clusterChanges.length === 0) continue;

  const label = CLUSTER_LABELS[cat] || cat;
  const imp = clusterChanges.filter(c => c.change !== null && c.change > 0).length;
  const dec = clusterChanges.filter(c => c.change !== null && c.change < 0).length;

  console.log(`${CYAN}${BOLD}  ${label}${RESET} ${DIM}(${clusterChanges.length} keywords: +${imp} -${dec})${RESET}`);
  console.log(`  ${'─'.repeat(55)}`);

  let noiseCount = 0;
  for (const c of clusterChanges) {
    if (c.change !== null && Math.abs(c.change) <= NOISE_THRESHOLD && !c.isNewlyTracked) { noiseCount++; continue; }
    if (c.previousPosition === null && c.currentPosition === null) continue;

    const kwTrunc = c.keyword.length > 40 ? c.keyword.slice(0, 37) + '...' : c.keyword;
    const posStr = c.isNewlyTracked
      ? `${CYAN}-> ${c.currentPosition ?? '—'} (new)${RESET}`
      : formatPosition(c.previousPosition, c.currentPosition, c.change);
    console.log(`    ${kwTrunc.padEnd(42)} ${posStr}`);
  }
  if (noiseCount > 0) console.log(`  ${DIM}  ... and ${noiseCount} keywords with +-${NOISE_THRESHOLD} change (noise)${RESET}`);
  console.log();
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatPosition(prev, curr, change) {
  if (prev === null && curr !== null) return `${BG_GREEN}${WHITE} NEW ${RESET} -> ${curr}`;
  if (prev !== null && curr === null) return `${prev} -> ${BG_RED}${WHITE} OUT ${RESET}`;
  if (prev === null && curr === null) return `${DIM}N/A${RESET}`;
  if (change === 0) return `${prev} -> ${curr} ${DIM}=${RESET}`;
  if (change > 0) return `${prev} -> ${GREEN}${curr} +${change}${RESET}`;
  return `${prev} -> ${RED}${curr} ${change}${RESET}`;
}

function printSingleSnapshot(snap) {
  const core = loadSemanticCore();
  console.log(`\n${BOLD}Positions on ${snap.date}${RESET}`);
  console.log(`${DIM}Source: ${snap.source}${snap.comment ? ` (${snap.comment})` : ''}${RESET}\n`);

  const positions = snap.entries
    .filter(e => !engineFilter || e.engine === engineFilter)
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));

  const inTop10 = positions.filter(e => e.position !== null && e.position <= 10).length;
  const inTop30 = positions.filter(e => e.position !== null && e.position <= 30).length;

  console.log(`${BOLD}Summary:${RESET}`);
  console.log(`  Keywords:     ${positions.length}`);
  console.log(`  ${GREEN}In TOP-10:${RESET}    ${inTop10}`);
  console.log(`  ${CYAN}In TOP-30:${RESET}    ${inTop30}\n`);

  const byCluster = {};
  for (const e of positions) {
    const meta = getKeywordMeta(e.keyword, e.url);
    const cat = meta.category;
    if (!byCluster[cat]) byCluster[cat] = [];
    byCluster[cat].push(e);
  }

  for (const cat of CLUSTER_ORDER) {
    const entries = byCluster[cat];
    if (!entries || entries.length === 0) continue;
    const label = CLUSTER_LABELS[cat] || cat;
    console.log(`${CYAN}${BOLD}  ${label}${RESET}`);
    console.log(`  ${'─'.repeat(50)}`);
    for (const e of entries) {
      const kwTrunc = e.keyword.length > 40 ? e.keyword.slice(0, 37) + '...' : e.keyword;
      let posStr;
      if (e.position === null) posStr = `${DIM}N/A${RESET}`;
      else if (e.position <= 10) posStr = `${GREEN}${e.position}${RESET}`;
      else if (e.position <= 30) posStr = `${CYAN}${e.position}${RESET}`;
      else posStr = `${e.position}`;
      console.log(`    ${kwTrunc.padEnd(42)} ${posStr}`);
    }
    console.log();
  }
}
