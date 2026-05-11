#!/usr/bin/env node
/**
 * Импорт снэпшота позиций из CSV
 *
 * Usage:
 *   node seo-tracking/scripts/import-positions.mjs <file.csv> [--date=2026-02-19] [--source=csv-import] [--comment="текст"]
 *
 * CSV должен содержать колонки: Запрос, Позиция (и опционально URL, Поисковик).
 * Если URL не указан, скрипт попытается найти его в semantic-core.json.
 *
 * Примеры:
 *   npm run seo:import-positions -- positions.csv
 *   npm run seo:import-positions -- positions.csv --date=2026-01-15 --comment="до миграции"
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSV_COLUMN_ALIASES, CSV_DELIMITERS, DEFAULT_ENGINE, SNAPSHOTS_DIR } from '../config.mjs';

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

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1];
const sourceArg = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'csv-import';
const commentArg = args.find(a => a.startsWith('--comment='))?.split('=')[1];

const snapshotDate = dateArg || new Date().toISOString().split('T')[0];

if (!csvPath) {
  console.log(`
${BOLD}Импорт снэпшота позиций из CSV${RESET}

${CYAN}Использование:${RESET}
  node seo-tracking/scripts/import-positions.mjs <file.csv> [опции]

${CYAN}Опции:${RESET}
  --date=YYYY-MM-DD    Дата снэпшота (по умолчанию: сегодня)
  --source=<src>       Источник: csv-import, manual, topvisor, serpstat, keys-so
  --comment="текст"    Комментарий к снэпшоту

${CYAN}Формат CSV:${RESET}
  Обязательные: Запрос, Позиция
  Опциональные: URL, Поисковик

${CYAN}Шаблон:${RESET}
  seo-tracking/templates/positions-template.csv
`);
  process.exit(1);
}

// ─── Load semantic core for URL lookup ───────────────────────────────

let semanticCore = { pages: [] };
try {
  semanticCore = JSON.parse(readFileSync(CORE_PATH, 'utf-8'));
} catch {
  console.log(`${YELLOW}⚠ Семантическое ядро не найдено (${CORE_PATH}). URL не будут подставляться автоматически.${RESET}`);
}

/** Find URL for a keyword from semantic core */
function findUrlForKeyword(keyword, engine) {
  for (const page of semanticCore.pages) {
    const match = page.keywords.find(k =>
      k.keyword.toLowerCase() === keyword.toLowerCase() &&
      k.engines.includes(engine)
    );
    if (match) return page.url;
  }
  // Fallback: search without engine filter
  for (const page of semanticCore.pages) {
    if (page.keywords.some(k => k.keyword.toLowerCase() === keyword.toLowerCase())) {
      return page.url;
    }
  }
  return null;
}

// ─── CSV parsing ─────────────────────────────────────────────────────

function detectDelimiter(headerLine) {
  for (const d of CSV_DELIMITERS) {
    if (headerLine.includes(d)) return d;
  }
  return ';';
}

function findColumn(headers, field) {
  const aliases = CSV_COLUMN_ALIASES[field] || [];
  for (const alias of aliases) {
    const idx = headers.findIndex(h => h.trim().toLowerCase() === alias.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseEngine(value) {
  if (!value) return DEFAULT_ENGINE;
  const v = value.toLowerCase().trim();
  if (v.includes('yandex') || v.includes('яндекс')) return 'yandex';
  if (v.includes('google') || v.includes('гугл')) return 'google';
  return DEFAULT_ENGINE;
}

function normalizeUrl(url) {
  if (!url) return null;
  let u = url.trim();
  try {
    const parsed = new URL(u, 'https://golatam.group');
    u = parsed.pathname;
  } catch { /* already relative */ }
  if (!u.endsWith('/')) u += '/';
  if (!u.startsWith('/')) u = '/' + u;
  return u;
}

function parsePosition(value) {
  if (!value) return null;
  const v = value.trim();
  if (v === '-' || v === '—' || v === '' || v === 'n/a' || v === '>100') return null;
  const num = parseInt(v);
  return isNaN(num) ? null : num;
}

// ─── Main ────────────────────────────────────────────────────────────

console.log(`\n${BOLD}📍 Импорт снэпшота позиций${RESET}`);
console.log(`   ${CYAN}Дата:${RESET} ${snapshotDate}`);
console.log(`   ${CYAN}Источник:${RESET} ${sourceArg}`);
if (commentArg) console.log(`   ${CYAN}Комментарий:${RESET} ${commentArg}`);
console.log();

// Read CSV
const raw = readFileSync(resolve(csvPath), 'utf-8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/).filter(l => l.trim());
if (lines.length < 2) {
  console.error(`${RED}Ошибка: файл пуст${RESET}`);
  process.exit(1);
}

const delimiter = detectDelimiter(lines[0]);
const headers = lines[0].split(delimiter).map(h => h.trim());
console.log(`${DIM}Колонки: ${headers.join(', ')}${RESET}`);

const colIdx = {
  keyword: findColumn(headers, 'keyword'),
  url: findColumn(headers, 'url'),
  position: findColumn(headers, 'position'),
  engine: findColumn(headers, 'engine'),
};

// Detect engine-named position columns (Topvisor style: "Google (Москва)", "Яндекс (Москва)")
const enginePositionCols = [];
for (let i = 0; i < headers.length; i++) {
  if (i === colIdx.keyword || i === colIdx.url || i === colIdx.engine) continue;
  const h = headers[i].toLowerCase().trim();
  if (h.includes('google')) {
    enginePositionCols.push({ idx: i, engine: 'google' });
  } else if (h.includes('yandex') || h.includes('яндекс')) {
    enginePositionCols.push({ idx: i, engine: 'yandex' });
  }
}

if (colIdx.keyword === -1) {
  console.error(`${RED}Ошибка: не найдена колонка "Запрос"${RESET}`);
  process.exit(1);
}

if (colIdx.position === -1 && enginePositionCols.length === 0) {
  console.error(`${RED}Ошибка: не найдена колонка с позицией${RESET}`);
  console.error(`Ожидаемые названия: ${CSV_COLUMN_ALIASES.position.join(', ')}`);
  process.exit(1);
}

// Parse rows
const entries = [];
let imported = 0;
let noUrl = 0;

for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(delimiter);
  const keyword = cols[colIdx.keyword]?.trim();
  if (!keyword) continue;

  const explicitUrl = colIdx.url !== -1 ? normalizeUrl(cols[colIdx.url]) : null;

  if (enginePositionCols.length > 0) {
    // Topvisor-style: one row has positions for multiple engines
    for (const { idx, engine } of enginePositionCols) {
      const position = parsePosition(cols[idx]);
      const url = explicitUrl || findUrlForKeyword(keyword, engine);
      if (!url) { noUrl++; continue; }
      entries.push({ keyword, url, engine, position });
      imported++;
    }
  } else {
    // Standard format: one position per row
    const engine = colIdx.engine !== -1 ? parseEngine(cols[colIdx.engine]) : DEFAULT_ENGINE;
    const position = parsePosition(cols[colIdx.position]);
    const url = explicitUrl || findUrlForKeyword(keyword, engine);
    if (!url) { noUrl++; continue; }
    entries.push({ keyword, url, engine, position });
    imported++;
  }
}

// Build snapshot
const snapshot = {
  date: snapshotDate,
  source: sourceArg,
  ...(commentArg && { comment: commentArg }),
  entries,
};

// Save
const snapshotPath = resolve(SNAPSHOTS_DIR, `${snapshotDate}.json`);

// If file for this date already exists, merge entries
if (existsSync(snapshotPath)) {
  const existing = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  console.log(`${YELLOW}⚠ Снэпшот за ${snapshotDate} уже существует — объединяю данные${RESET}`);

  for (const entry of entries) {
    const existingIdx = existing.entries.findIndex(e =>
      e.keyword === entry.keyword && e.engine === entry.engine && e.url === entry.url
    );
    if (existingIdx !== -1) {
      existing.entries[existingIdx] = entry; // overwrite
    } else {
      existing.entries.push(entry);
    }
  }
  existing.source = sourceArg;
  if (commentArg) existing.comment = commentArg;
  writeFileSync(snapshotPath, JSON.stringify(existing, null, 2), 'utf-8');
} else {
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

// ─── Report ──────────────────────────────────────────────────────────

const inTop10 = entries.filter(e => e.position !== null && e.position <= 10).length;
const inTop30 = entries.filter(e => e.position !== null && e.position <= 30).length;
const notInTop = entries.filter(e => e.position === null).length;

console.log(`\n${GREEN}✅ Снэпшот сохранён${RESET}`);
console.log(`   ${CYAN}Записей:${RESET} ${imported}`);
if (noUrl > 0) console.log(`   ${YELLOW}Без URL (пропущены):${RESET} ${noUrl}`);
console.log(`   ${CYAN}В ТОП-10:${RESET} ${inTop10}`);
console.log(`   ${CYAN}В ТОП-30:${RESET} ${inTop30}`);
console.log(`   ${CYAN}Вне ТОП-100:${RESET} ${notInTop}`);
console.log(`   ${CYAN}Файл:${RESET} ${snapshotPath}\n`);
