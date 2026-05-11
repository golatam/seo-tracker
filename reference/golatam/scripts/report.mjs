#!/usr/bin/env node
/**
 * Генерация отчёта по изменению позиций
 *
 * Сравнивает два последних снэпшота (или указанные даты) и выводит:
 * — общую статистику (улучшения, падения, средняя позиция)
 * — детали по кластерам (категориям страниц)
 * — алерты по критическим падениям
 *
 * Usage:
 *   node seo-tracking/scripts/report.mjs [--from=2026-01-15] [--to=2026-02-19] [--engine=google|yandex] [--category=country] [--json]
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
  country: '🌎 Страны',
  blog: '📝 Блог',
  service: '🔧 Услуги',
  audience: '👥 Аудитории',
  brand: '🏷 Бренд',
  main: '🏠 Главная',
  landing: '📄 Лендинги',
  unknown: '❓ Прочее',
};

const CLUSTER_ORDER = ['brand', 'main', 'country', 'service', 'audience', 'blog', 'landing', 'unknown'];

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
    return readdirSync(SNAPSHOTS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

function loadSnapshot(filename) {
  return JSON.parse(readFileSync(resolve(SNAPSHOTS_DIR, filename), 'utf-8'));
}

function loadSemanticCore() {
  try {
    return JSON.parse(readFileSync(CORE_PATH, 'utf-8'));
  } catch {
    return { pages: [] };
  }
}

// ─── Main ────────────────────────────────────────────────────────────

const files = getSnapshotFiles();

if (files.length === 0) {
  console.log(`\n${YELLOW}Нет снэпшотов позиций.${RESET}`);
  console.log(`Импортируйте данные: npm run seo:import-positions -- <file.csv>\n`);
  process.exit(0);
}

if (files.length === 1 && !fromDate) {
  const snap = loadSnapshot(files[0]);
  printSingleSnapshot(snap);
  process.exit(0);
}

// Determine which snapshots to compare
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
  const snap = loadSnapshot(currFile);
  printSingleSnapshot(snap);
  process.exit(0);
}

const prevSnap = loadSnapshot(prevFile);
const currSnap = loadSnapshot(currFile);
const core = loadSemanticCore();

// Build lookup maps
const entryKey = (e) => `${e.keyword}|${e.engine}`;

const prevMap = new Map();
for (const e of prevSnap.entries) {
  prevMap.set(entryKey(e), e);
}

const currMap = new Map();
for (const e of currSnap.entries) {
  currMap.set(entryKey(e), e);
}

const prevKeywords = new Set(prevSnap.entries.map(e => entryKey(e)));

// Get priority and category from semantic core
function getKeywordMeta(keyword, url) {
  for (const page of core.pages) {
    if (page.url === url) {
      const kw = page.keywords.find(k => k.keyword === keyword);
      if (kw) return { priority: kw.priority, category: page.category };
    }
  }
  // Try matching just by keyword across all pages
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
  if (prevPos !== null && currPos !== null) {
    change = prevPos - currPos;
  }

  const isNewlyTracked = !prevKeywords.has(key) && currPos !== null;
  const meta = getKeywordMeta(keyword, url);

  changes.push({
    keyword,
    url,
    engine,
    previousPosition: prevPos,
    currentPosition: currPos,
    change,
    priority: meta.priority,
    category: meta.category,
    isNewlyTracked,
  });
}

// Sort: biggest drops first, then biggest improvements
changes.sort((a, b) => {
  const aDropped = a.previousPosition !== null && a.currentPosition === null;
  const bDropped = b.previousPosition !== null && b.currentPosition === null;
  if (aDropped && !bDropped) return -1;
  if (!aDropped && bDropped) return 1;
  const ac = a.change ?? 0;
  const bc = b.change ?? 0;
  return ac - bc;
});

// ─── Summary ─────────────────────────────────────────────────────────

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

function calcAvg(arr) {
  if (arr.length === 0) return 0;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

// ─── JSON output ─────────────────────────────────────────────────────

if (jsonOutput) {
  console.log(JSON.stringify({
    currentDate: currSnap.date,
    previousDate: prevSnap.date,
    summary,
    changes,
  }, null, 2));
  process.exit(0);
}

// ─── Console report ──────────────────────────────────────────────────

console.log(`\n${BOLD}═══════════════════════════════════════════════════════════${RESET}`);
console.log(`${BOLD}  📊 Отчёт по позициям: ${prevSnap.date} → ${currSnap.date}${RESET}`);
if (engineFilter) console.log(`${DIM}  Фильтр: ${engineFilter}${RESET}`);
if (categoryFilter) console.log(`${DIM}  Категория: ${categoryFilter}${RESET}`);
console.log(`${BOLD}═══════════════════════════════════════════════════════════${RESET}\n`);

// Summary block
const avgChange = summary.avgPosition - summary.prevAvgPosition;
const avgDir = avgChange < 0 ? `${GREEN}↑${Math.abs(avgChange).toFixed(1)}${RESET}` : avgChange > 0 ? `${RED}↓${avgChange.toFixed(1)}${RESET}` : '—';

console.log(`${BOLD}Сводка:${RESET}`);
console.log(`  Ключевых слов:     ${summary.totalKeywords}`);
console.log(`  ${GREEN}▲ Улучшились:${RESET}       ${summary.improved}`);
console.log(`  ${RED}▼ Ухудшились:${RESET}       ${summary.declined}`);
console.log(`  — Без изменений:   ${summary.unchanged}`);
if (summary.noData > 0) console.log(`  ${DIM}∅ Нет данных (N/A):${RESET} ${summary.noData}`);
console.log(`  ${GREEN}★ Вошли в ТОП:${RESET}     ${summary.newInTop}`);
if (summary.newlyTracked > 0) console.log(`  ${CYAN}⊕ Новые в отсл.:${RESET}   ${summary.newlyTracked}`);
console.log(`  ${RED}✕ Вышли из ТОП:${RESET}    ${summary.droppedFromTop}`);
console.log(`  Средняя позиция:   ${summary.prevAvgPosition} → ${summary.avgPosition} (${avgDir})`);
console.log();

// ─── Alerts ──────────────────────────────────────────────────────────

const alerts = changes.filter(c =>
  !c.isNewlyTracked && (
    (c.previousPosition !== null && c.currentPosition === null) ||
    (c.change !== null && c.change < -ALERT_DECLINE_THRESHOLD) ||
    (c.previousPosition !== null && c.previousPosition <= ALERT_TOP_THRESHOLD && c.currentPosition !== null && c.currentPosition > ALERT_TOP_THRESHOLD)
  )
);

if (alerts.length > 0) {
  console.log(`${BG_RED}${WHITE}${BOLD} ⚠ АЛЕРТЫ (${alerts.length}) ${RESET}\n`);
  for (const a of alerts) {
    const posStr = formatPosition(a.previousPosition, a.currentPosition, a.change);
    console.log(`  ${RED}●${RESET} [${a.engine}] "${a.keyword}" ${posStr}`);
    if (a.url) console.log(`    ${DIM}${a.url}${RESET}`);
  }
  console.log();
}

// ─── Cluster-based detail ────────────────────────────────────────────

console.log(`${BOLD}Детализация по кластерам:${RESET}\n`);

// Group by category
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
  const clImproved = clusterChanges.filter(c => c.change !== null && c.change > 0).length;
  const clDeclined = clusterChanges.filter(c => c.change !== null && c.change < 0).length;
  const clNoData = clusterChanges.filter(c => c.currentPosition === null && c.previousPosition === null).length;

  console.log(`${CYAN}${BOLD}  ${label}${RESET} ${DIM}(${clusterChanges.length} ключей: ▲${clImproved} ▼${clDeclined}${clNoData > 0 ? ` ∅${clNoData}` : ''})${RESET}`);
  console.log(`  ${'─'.repeat(55)}`);

  // Sub-group by engine within cluster
  const byEngine = {};
  for (const c of clusterChanges) {
    if (!byEngine[c.engine]) byEngine[c.engine] = [];
    byEngine[c.engine].push(c);
  }

  for (const [engine, engineChanges] of Object.entries(byEngine)) {
    if (Object.keys(byEngine).length > 1) {
      console.log(`  ${DIM}${engine}:${RESET}`);
    }

    let noiseCount = 0;
    for (const c of engineChanges) {
      // Skip noise (small position changes) — show only significant moves
      if (c.change !== null && Math.abs(c.change) <= NOISE_THRESHOLD && !c.isNewlyTracked) {
        noiseCount++;
        continue;
      }
      // Skip N/A → N/A (no data both times)
      if (c.previousPosition === null && c.currentPosition === null) {
        continue;
      }

      const prio = c.priority === 'high' ? `${RED}!${RESET}` : c.priority === 'low' ? `${DIM}·${RESET}` : ' ';
      const posStr = c.isNewlyTracked
        ? `${CYAN}→ ${c.currentPosition ?? '—'} (новый)${RESET}`
        : formatPosition(c.previousPosition, c.currentPosition, c.change);
      const kwTrunc = c.keyword.length > 35 ? c.keyword.slice(0, 32) + '...' : c.keyword;
      console.log(`  ${prio} ${kwTrunc.padEnd(36)} ${posStr}`);
    }

    if (noiseCount > 0) {
      console.log(`  ${DIM}  ... и ${noiseCount} ключей с изменением ±${NOISE_THRESHOLD} (шум)${RESET}`);
    }
  }
  console.log();
}

// ─── Cluster summary table ───────────────────────────────────────────

console.log(`${BOLD}Сводка по кластерам:${RESET}`);
for (const cat of CLUSTER_ORDER) {
  const clusterChanges = byCluster[cat];
  if (!clusterChanges || clusterChanges.length === 0) continue;

  const label = CLUSTER_LABELS[cat] || cat;
  const stats = {
    improved: clusterChanges.filter(c => c.change > 0).length,
    declined: clusterChanges.filter(c => c.change !== null && c.change < 0).length,
    unchanged: clusterChanges.filter(c => c.change === 0).length,
    noData: clusterChanges.filter(c => c.currentPosition === null && c.previousPosition === null).length,
    total: clusterChanges.length,
    avg: calcAvg(clusterChanges.map(c => c.currentPosition).filter(p => p !== null)),
  };
  const avgStr = stats.avg > 0 ? ` avg:${stats.avg}` : '';
  console.log(`  ${(label).padEnd(18)} ▲${stats.improved} ▼${stats.declined} —${stats.unchanged}${stats.noData > 0 ? ` ∅${stats.noData}` : ''} (${stats.total} всего${avgStr})`);
}
console.log();

// ─── Helpers ─────────────────────────────────────────────────────────

function formatPosition(prev, curr, change) {
  if (prev === null && curr !== null) {
    return `${BG_GREEN}${WHITE} NEW ${RESET} → ${curr}`;
  }
  if (prev !== null && curr === null) {
    return `${prev} → ${BG_RED}${WHITE} OUT ${RESET}`;
  }
  if (prev === null && curr === null) {
    return `${DIM}N/A${RESET}`;
  }
  if (change === 0) {
    return `${prev} → ${curr} ${DIM}=${RESET}`;
  }
  if (change > 0) {
    return `${prev} → ${GREEN}${curr} ▲${change}${RESET}`;
  }
  return `${prev} → ${RED}${curr} ▼${Math.abs(change)}${RESET}`;
}

// ─── Single snapshot view ────────────────────────────────────────────

function printSingleSnapshot(snap) {
  const core = loadSemanticCore();

  console.log(`\n${BOLD}📍 Позиции на ${snap.date}${RESET}`);
  console.log(`${DIM}Источник: ${snap.source}${snap.comment ? ` (${snap.comment})` : ''}${RESET}\n`);

  const positions = snap.entries
    .filter(e => !engineFilter || e.engine === engineFilter)
    .sort((a, b) => (a.position ?? 999) - (b.position ?? 999));

  const inTop10 = positions.filter(e => e.position !== null && e.position <= 10).length;
  const inTop30 = positions.filter(e => e.position !== null && e.position <= 30).length;
  const notInTop = positions.filter(e => e.position === null).length;

  console.log(`${BOLD}Сводка:${RESET}`);
  console.log(`  Ключевых слов:   ${positions.length}`);
  console.log(`  ${GREEN}В ТОП-10:${RESET}        ${inTop10}`);
  console.log(`  ${CYAN}В ТОП-30:${RESET}        ${inTop30}`);
  if (notInTop > 0) console.log(`  ${DIM}N/A (нет данных):${RESET} ${notInTop}`);
  console.log();

  // Group by cluster, then by engine
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
      const kwTrunc = e.keyword.length > 35 ? e.keyword.slice(0, 32) + '...' : e.keyword;
      let posStr;
      if (e.position === null) {
        posStr = `${DIM}N/A${RESET}`;
      } else if (e.position <= 10) {
        posStr = `${GREEN}${e.position}${RESET}`;
      } else if (e.position <= 30) {
        posStr = `${CYAN}${e.position}${RESET}`;
      } else {
        posStr = `${e.position}`;
      }
      const engLabel = `${DIM}[${e.engine[0]}]${RESET}`;
      console.log(`  ${engLabel} ${kwTrunc.padEnd(36)} ${posStr}`);
    }
    console.log();
  }
}
