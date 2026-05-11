#!/usr/bin/env node
/**
 * Импорт семантического ядра из CSV в semantic-core.json
 *
 * Usage:
 *   node seo-tracking/scripts/import-keywords.mjs <file.csv> [--merge]
 *
 * Опции:
 *   --merge    Объединить с существующим ядром (по умолчанию — перезапись)
 *
 * Поддерживаемые форматы CSV:
 *   - Topvisor, Serpstat, Keys.so, ручные таблицы
 *   - Разделители: ; , TAB (автоопределение)
 *   - Кодировка: UTF-8 (если файл в Windows-1251, пересохраните в UTF-8)
 *
 * Примеры:
 *   npm run seo:import-keywords -- keywords.csv
 *   npm run seo:import-keywords -- keywords.csv --merge
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSV_COLUMN_ALIASES, CSV_DELIMITERS, DEFAULT_ENGINE } from '../config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = resolve(__dirname, '..', 'semantic-core.json');

// ANSI colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ─── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const mergeMode = args.includes('--merge');
const csvPath = args.find(a => !a.startsWith('--'));

if (!csvPath) {
  console.log(`
${BOLD}Импорт семантического ядра из CSV${RESET}

${CYAN}Использование:${RESET}
  node seo-tracking/scripts/import-keywords.mjs <file.csv> [--merge]

${CYAN}Опции:${RESET}
  --merge    Объединить с существующим ядром (по умолчанию — перезапись)

${CYAN}Формат CSV:${RESET}
  Обязательная колонка: Запрос (или Keyword, Ключевое слово)
  Опциональные: URL, Поисковик, Частотность, Конкурентность, Приоритет

${CYAN}Шаблон:${RESET}
  seo-tracking/templates/keywords-template.csv
`);
  process.exit(1);
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

function parsePriority(value) {
  if (!value) return 'medium';
  const v = value.toLowerCase().trim();
  if (v === 'high' || v === 'высокий' || v === 'высок') return 'high';
  if (v === 'low' || v === 'низкий' || v === 'низк') return 'low';
  return 'medium';
}

function normalizeUrl(url) {
  if (!url) return null;
  let u = url.trim();
  // Убрать домен, оставить только path
  try {
    const parsed = new URL(u, 'https://golatam.group');
    u = parsed.pathname;
  } catch {
    // Уже relative path
  }
  // Добавить trailing slash
  if (!u.endsWith('/')) u += '/';
  // Добавить leading slash
  if (!u.startsWith('/')) u = '/' + u;
  return u;
}

// ─── Main ────────────────────────────────────────────────────────────

console.log(`\n${BOLD}📊 Импорт семантического ядра${RESET}\n`);

// Read CSV
const raw = readFileSync(resolve(csvPath), 'utf-8')
  // Remove BOM
  .replace(/^\uFEFF/, '');

const lines = raw.split(/\r?\n/).filter(l => l.trim());
if (lines.length < 2) {
  console.error(`${RED}Ошибка: файл пуст или содержит только заголовок${RESET}`);
  process.exit(1);
}

const delimiter = detectDelimiter(lines[0]);
console.log(`${DIM}Разделитель: "${delimiter === '\t' ? 'TAB' : delimiter}"${RESET}`);

const headers = lines[0].split(delimiter).map(h => h.trim());
console.log(`${DIM}Колонки: ${headers.join(', ')}${RESET}`);

// Map columns
const colIdx = {
  keyword: findColumn(headers, 'keyword'),
  url: findColumn(headers, 'url'),
  engine: findColumn(headers, 'engine'),
  volume: findColumn(headers, 'volume'),
  difficulty: findColumn(headers, 'difficulty'),
};

// Also look for a "Приоритет" / "Priority" column
const priorityIdx = headers.findIndex(h =>
  ['приоритет', 'priority'].includes(h.toLowerCase().trim())
);

if (colIdx.keyword === -1) {
  console.error(`${RED}Ошибка: не найдена колонка с ключевыми словами.${RESET}`);
  console.error(`Ожидаемые названия: ${CSV_COLUMN_ALIASES.keyword.join(', ')}`);
  process.exit(1);
}

console.log(`${DIM}Маппинг: keyword=${headers[colIdx.keyword]}` +
  (colIdx.url !== -1 ? `, url=${headers[colIdx.url]}` : '') +
  (colIdx.engine !== -1 ? `, engine=${headers[colIdx.engine]}` : '') +
  (colIdx.volume !== -1 ? `, volume=${headers[colIdx.volume]}` : '') +
  `${RESET}\n`);

// Detect if position columns exist in headers (e.g. "Google (Москва)", "Яндекс (Москва)")
// These are common in Topvisor exports — treat them as engine-specific columns
const engineColumns = [];
for (let i = 0; i < headers.length; i++) {
  const h = headers[i].toLowerCase().trim();
  if (h.includes('google') && i !== colIdx.engine) {
    engineColumns.push({ idx: i, engine: 'google' });
  }
  if ((h.includes('yandex') || h.includes('яндекс')) && i !== colIdx.engine) {
    engineColumns.push({ idx: i, engine: 'yandex' });
  }
}

// Parse rows
/** @type {Map<string, { url: string, title: string, category: string, keywords: any[] }>} */
const pageMap = new Map();

let imported = 0;
let skipped = 0;

for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(delimiter);
  const keyword = cols[colIdx.keyword]?.trim();
  if (!keyword) { skipped++; continue; }

  const url = colIdx.url !== -1 ? normalizeUrl(cols[colIdx.url]) : '/';
  const volume = colIdx.volume !== -1 ? parseInt(cols[colIdx.volume]) || undefined : undefined;
  const difficulty = colIdx.difficulty !== -1 ? parseInt(cols[colIdx.difficulty]) || undefined : undefined;
  const priority = priorityIdx !== -1 ? parsePriority(cols[priorityIdx]) : 'medium';

  // Determine engines
  let engines;
  if (engineColumns.length > 0) {
    // Topvisor-style: multiple engine columns, add for each
    engines = engineColumns.map(ec => ec.engine);
  } else if (colIdx.engine !== -1) {
    engines = [parseEngine(cols[colIdx.engine])];
  } else {
    engines = [DEFAULT_ENGINE];
  }

  // Group by URL → page
  const pageUrl = url || '/';
  if (!pageMap.has(pageUrl)) {
    pageMap.set(pageUrl, {
      url: pageUrl,
      title: guessPageTitle(pageUrl),
      category: guessCategory(pageUrl),
      keywords: [],
    });
  }

  const page = pageMap.get(pageUrl);

  // Check if keyword already exists for this page (avoid duplicates within same engine)
  const existingKw = page.keywords.find(k => k.keyword === keyword);
  if (existingKw) {
    // Merge engines
    for (const e of engines) {
      if (!existingKw.engines.includes(e)) existingKw.engines.push(e);
    }
  } else {
    page.keywords.push({
      keyword,
      engines: [...new Set(engines)],
      ...(volume !== undefined && { volume }),
      ...(difficulty !== undefined && { difficulty }),
      priority,
    });
  }

  imported++;
}

// ─── Category and title guessing ─────────────────────────────────────

function guessCategory(url) {
  if (url === '/') return 'main';
  if (url.startsWith('/strana/')) return 'country';
  if (url.startsWith('/uslugi/') && url.split('/').filter(Boolean).length > 2) return 'service-sub';
  if (url.startsWith('/uslugi/')) return 'service';
  if (url.startsWith('/blog/')) return 'blog';
  if (url.startsWith('/novosti/')) return 'news';
  if (url.startsWith('/yuridicheskim-licam/')) return 'audience';
  return 'info';
}

function guessPageTitle(url) {
  const slug = url.split('/').filter(Boolean).pop() || 'Главная';
  return slug
    .replace(/-/g, ' ')
    .replace(/^\w/, c => c.toUpperCase());
}

// ─── Save result ─────────────────────────────────────────────────────

let core;
if (mergeMode) {
  try {
    core = JSON.parse(readFileSync(CORE_PATH, 'utf-8'));
  } catch {
    core = { updatedAt: null, pages: [] };
  }

  // Merge: add new pages, merge keywords into existing pages
  for (const [url, pageData] of pageMap) {
    const existing = core.pages.find(p => p.url === url);
    if (existing) {
      for (const kw of pageData.keywords) {
        const existingKw = existing.keywords.find(k => k.keyword === kw.keyword);
        if (existingKw) {
          // Merge engines
          for (const e of kw.engines) {
            if (!existingKw.engines.includes(e)) existingKw.engines.push(e);
          }
          // Update metadata if provided
          if (kw.volume !== undefined) existingKw.volume = kw.volume;
          if (kw.difficulty !== undefined) existingKw.difficulty = kw.difficulty;
        } else {
          existing.keywords.push(kw);
        }
      }
    } else {
      core.pages.push(pageData);
    }
  }
} else {
  core = {
    pages: Array.from(pageMap.values()),
  };
}

core.updatedAt = new Date().toISOString().split('T')[0];

writeFileSync(CORE_PATH, JSON.stringify(core, null, 2), 'utf-8');

// ─── Report ──────────────────────────────────────────────────────────

const totalPages = core.pages.length;
const totalKeywords = core.pages.reduce((sum, p) => sum + p.keywords.length, 0);

console.log(`${GREEN}✅ Импорт завершён${RESET}`);
console.log(`   ${CYAN}Строк обработано:${RESET} ${imported} (пропущено: ${skipped})`);
console.log(`   ${CYAN}Страниц:${RESET} ${totalPages}`);
console.log(`   ${CYAN}Ключевых слов:${RESET} ${totalKeywords}`);
console.log(`   ${CYAN}Режим:${RESET} ${mergeMode ? 'объединение' : 'перезапись'}`);
console.log(`   ${CYAN}Файл:${RESET} ${CORE_PATH}\n`);

// Category breakdown
const catCounts = {};
for (const p of core.pages) {
  catCounts[p.category] = (catCounts[p.category] || 0) + p.keywords.length;
}
console.log(`${BOLD}По категориям:${RESET}`);
for (const [cat, count] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${cat}: ${count} ключей`);
}
console.log();
