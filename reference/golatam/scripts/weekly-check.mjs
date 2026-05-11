#!/usr/bin/env node
/**
 * Еженедельная проверка позиций
 *
 * Полный цикл: сбор данных → снэпшот → сравнение → отчёт в Telegram.
 *
 * Порядок работы:
 *   1. Читает семантическое ядро (только tracked: true ключи)
 *   2. Собирает позиции из Google Search Console (до 3 попыток)
 *   3. Собирает позиции из Яндекс.Вебмастер (до 3 попыток)
 *   4. Дополняет отсутствующие ключи как position: null (N/A)
 *   5. Сохраняет снэпшот
 *   6. Сравнивает с предыдущим снэпшотом
 *   7. Отправляет отчёт в Telegram
 *
 * Usage:
 *   node seo-tracking/scripts/weekly-check.mjs [--no-telegram] [--no-slack] [--dry-run]
 *
 * Env vars: см. seo-tracking/.env.example
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { SNAPSHOTS_DIR, ALERT_DECLINE_THRESHOLD, ALERT_TOP_THRESHOLD, NOTIFICATIONS } from '../config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = resolve(__dirname, '..', 'semantic-core.json');

loadEnv();

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
const noTelegram = args.includes('--no-telegram');
const noSlack = args.includes('--no-slack');
const dryRun = args.includes('--dry-run');

// ─── Retry helper ────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

async function withRetry(fn, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        console.log(`   ${YELLOW}⚠ ${label}: попытка ${attempt}/${MAX_RETRIES} не удалась: ${e.message}${RESET}`);
        console.log(`   ${DIM}Повтор через ${RETRY_DELAY_MS / 1000}с...${RESET}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        throw e;
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}🔄 Еженедельная проверка позиций${RESET}`);
  console.log(`${DIM}${new Date().toISOString()}${RESET}\n`);

  // 1. Load semantic core
  let core;
  try {
    core = JSON.parse(readFileSync(CORE_PATH, 'utf-8'));
  } catch {
    console.error(`${RED}❌ Семантическое ядро не найдено: ${CORE_PATH}${RESET}`);
    console.error(`Импортируйте ключи: npm run seo:import-keywords -- <file.csv>\n`);
    process.exit(1);
  }

  if (!core.pages || core.pages.length === 0) {
    console.error(`${RED}❌ Семантическое ядро пустое${RESET}`);
    console.error(`Импортируйте ключи: npm run seo:import-keywords -- <file.csv>\n`);
    process.exit(1);
  }

  // Extract ONLY tracked keywords per engine, with URL mapping
  const googleKeywords = [];
  const yandexKeywords = [];
  const trackedKeywordMap = new Map(); // keyword|engine → { keyword, url, engine, category }
  for (const page of core.pages) {
    for (const kw of page.keywords) {
      if (kw.tracked === false) continue;
      if (kw.engines.includes('google')) {
        googleKeywords.push(kw.keyword);
        trackedKeywordMap.set(`${kw.keyword}|google`, { keyword: kw.keyword, url: page.url, engine: 'google', category: page.category });
      }
      if (kw.engines.includes('yandex')) {
        yandexKeywords.push(kw.keyword);
        trackedKeywordMap.set(`${kw.keyword}|yandex`, { keyword: kw.keyword, url: page.url, engine: 'yandex', category: page.category });
      }
    }
  }

  const totalTracked = new Set([...googleKeywords, ...yandexKeywords]).size;
  console.log(`${CYAN}Семантическое ядро:${RESET} ${core.pages.length} страниц`);
  console.log(`   Отслеживаемых ключей: ${totalTracked} (Google: ${googleKeywords.length}, Яндекс: ${yandexKeywords.length})\n`);

  // 2. Fetch positions (with retries)
  const entries = [];
  const fetchedKeys = new Set(); // track which keyword|engine combos we got data for

  // Google Search Console
  if (googleKeywords.length > 0 && process.env.GSC_CLIENT_ID) {
    console.log(`${BOLD}📡 Google Search Console${RESET}`);
    try {
      const gscResults = await withRetry(async () => {
        const { fetchGscPositions } = await import('./fetch-gsc.mjs');
        return await fetchGscPositions(googleKeywords);
      }, 'GSC');

      const googleKwSet = new Set(googleKeywords.map(k => k.toLowerCase()));
      for (const r of gscResults) {
        if (googleKwSet.has(r.keyword.toLowerCase())) {
          const key = `${r.keyword}|google`;
          entries.push({
            keyword: r.keyword,
            url: r.url,
            engine: 'google',
            position: Math.round(r.position),
          });
          fetchedKeys.add(key);
        }
      }
      console.log(`   ${GREEN}✅ ${entries.filter(e => e.engine === 'google').length} ключей из GSC${RESET}\n`);
    } catch (e) {
      console.log(`   ${YELLOW}⚠ GSC недоступен после ${MAX_RETRIES} попыток: ${e.message}${RESET}\n`);
    }
  } else if (googleKeywords.length > 0) {
    console.log(`${DIM}⏭ Google Search Console — GSC_CLIENT_ID не задан, пропуск${RESET}\n`);
  }

  // Yandex Webmaster
  if (yandexKeywords.length > 0 && process.env.YANDEX_OAUTH_TOKEN) {
    console.log(`${BOLD}📡 Яндекс.Вебмастер${RESET}`);
    try {
      const yandexResults = await withRetry(async () => {
        const { fetchYandexPositions } = await import('./fetch-yandex.mjs');
        return await fetchYandexPositions(yandexKeywords);
      }, 'Yandex');

      const yandexKwSet = new Set(yandexKeywords.map(k => k.toLowerCase()));
      for (const r of yandexResults) {
        if (yandexKwSet.has(r.keyword.toLowerCase())) {
          const key = `${r.keyword}|yandex`;
          entries.push({
            keyword: r.keyword,
            url: r.url,
            engine: 'yandex',
            position: r.position ? Math.round(r.position) : null,
          });
          fetchedKeys.add(key);
        }
      }
      console.log(`   ${GREEN}✅ ${entries.filter(e => e.engine === 'yandex').length} ключей из Яндекса${RESET}\n`);
    } catch (e) {
      console.log(`   ${YELLOW}⚠ Яндекс.Вебмастер недоступен после ${MAX_RETRIES} попыток: ${e.message}${RESET}\n`);
    }
  } else if (yandexKeywords.length > 0) {
    console.log(`${DIM}⏭ Яндекс.Вебмастер — YANDEX_OAUTH_TOKEN не задан, пропуск${RESET}\n`);
  }

  // 3. Fill missing tracked keywords with position: null (N/A)
  let filledCount = 0;
  for (const [key, info] of trackedKeywordMap) {
    if (!fetchedKeys.has(key)) {
      entries.push({
        keyword: info.keyword,
        url: info.url,
        engine: info.engine,
        position: null,
      });
      filledCount++;
    }
  }
  if (filledCount > 0) {
    console.log(`${DIM}📝 ${filledCount} ключей без данных API → position: null (N/A)${RESET}\n`);
  }

  if (entries.length === 0) {
    console.log(`${YELLOW}⚠ Не удалось получить ни одной позиции.${RESET}`);
    console.log(`Проверьте API-ключи в .env (см. seo-tracking/.env.example)\n`);
    console.log(`${DIM}Выход без ошибки — секреты ещё не настроены.${RESET}\n`);
    return;
  }

  // 4. Save snapshot
  const today = new Date().toISOString().split('T')[0];
  const snapshot = {
    date: today,
    source: 'api',
    comment: 'weekly auto-check',
    entries,
  };

  if (dryRun) {
    console.log(`${YELLOW}🔍 Dry run — снэпшот не сохраняется${RESET}`);
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  const snapshotPath = resolve(SNAPSHOTS_DIR, `${today}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`${GREEN}💾 Снэпшот сохранён: ${snapshotPath}${RESET}\n`);

  // 5. Compare with previous
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  const currentFile = `${today}.json`;
  const prevFiles = files.filter(f => f < currentFile);

  if (prevFiles.length === 0) {
    console.log(`${YELLOW}Это первый снэпшот — сравнение недоступно.${RESET}`);
    console.log(`Отчёт о сравнении будет доступен после следующей проверки.\n`);

    // Send first-snapshot notifications
    if (NOTIFICATIONS.telegram && !noTelegram && process.env.TELEGRAM_BOT_TOKEN) {
      console.log(`${BOLD}📲 Отправка в Telegram...${RESET}`);
      const { sendTelegramReport } = await import('./notify-telegram.mjs');
      await sendTelegramReport(snapshot, 'snapshot');
    }
    if (NOTIFICATIONS.slack && !noSlack && process.env.SLACK_BOT_TOKEN) {
      console.log(`${BOLD}💬 Отправка в Slack...${RESET}`);
      const { sendSlackReport } = await import('./notify-slack.mjs');
      await sendSlackReport(snapshot, 'snapshot');
    }
    return;
  }

  const prevSnapshot = JSON.parse(
    readFileSync(resolve(SNAPSHOTS_DIR, prevFiles[prevFiles.length - 1]), 'utf-8')
  );

  // Build comparison
  const entryKey = (e) => `${e.keyword}|${e.engine}`;

  const prevMap = new Map();
  for (const e of prevSnapshot.entries) {
    prevMap.set(entryKey(e), e);
  }

  const currMap = new Map();
  for (const e of entries) {
    currMap.set(entryKey(e), e);
  }

  const prevKeywords = new Set(prevSnapshot.entries.map(e => entryKey(e)));

  const allKeys = new Set([...prevMap.keys(), ...currMap.keys()]);
  const changes = [];

  for (const key of allKeys) {
    const [keyword, engine] = key.split('|');
    const prev = prevMap.get(key);
    const curr = currMap.get(key);
    const prevPos = prev?.position ?? null;
    const currPos = curr?.position ?? null;
    const url = curr?.url || prev?.url || undefined;

    let change = null;
    if (prevPos !== null && currPos !== null) change = prevPos - currPos;

    const isNewlyTracked = !prevKeywords.has(key) && currPos !== null;

    // Get priority and category from semantic core
    let priority = 'medium';
    let category = 'unknown';
    for (const page of core.pages) {
      if (page.url === url) {
        category = page.category;
        const kw = page.keywords.find(k => k.keyword === keyword);
        if (kw) { priority = kw.priority; break; }
      }
    }

    changes.push({ keyword, url, engine, previousPosition: prevPos, currentPosition: currPos, change, priority, isNewlyTracked, category });
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
    avgPosition: avg(changes.map(c => c.currentPosition).filter(p => p !== null)),
    prevAvgPosition: avg(changes.map(c => c.previousPosition).filter(p => p !== null)),
  };

  const report = {
    currentDate: today,
    previousDate: prevSnapshot.date,
    summary,
    changes,
  };

  // Print console summary
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  📊 ${prevSnapshot.date} → ${today}${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}`);
  console.log(`  ▲ Улучшились: ${summary.improved}`);
  console.log(`  ▼ Ухудшились: ${summary.declined}`);
  console.log(`  — Без изменений: ${summary.unchanged}`);
  if (summary.noData > 0) console.log(`  ∅ Нет данных (N/A): ${summary.noData}`);
  if (summary.newlyTracked > 0) console.log(`  ⊕ Новые в отслеживании: ${summary.newlyTracked}`);
  console.log(`  Средняя: ${summary.prevAvgPosition} → ${summary.avgPosition}\n`);

  // 6. Send notifications
  if (NOTIFICATIONS.telegram && !noTelegram) {
    if (process.env.TELEGRAM_BOT_TOKEN) {
      console.log(`${BOLD}📲 Отправка в Telegram...${RESET}`);
      try {
        const { sendTelegramReport } = await import('./notify-telegram.mjs');
        await sendTelegramReport(report, 'report');
      } catch (e) {
        console.error(`${RED}❌ Ошибка Telegram: ${e.message}${RESET}`);
      }
    } else {
      console.log(`${DIM}⏭ Telegram — TELEGRAM_BOT_TOKEN не задан, пропуск${RESET}`);
    }
  } else if (!NOTIFICATIONS.telegram) {
    console.log(`${DIM}⏭ Telegram — отключён в config.mjs${RESET}`);
  }

  if (NOTIFICATIONS.slack && !noSlack) {
    if (process.env.SLACK_BOT_TOKEN) {
      console.log(`${BOLD}💬 Отправка в Slack...${RESET}`);
      try {
        const { sendSlackReport } = await import('./notify-slack.mjs');
        await sendSlackReport(report, 'report');
      } catch (e) {
        console.error(`${RED}❌ Ошибка Slack: ${e.message}${RESET}`);
      }
    } else {
      console.log(`${DIM}⏭ Slack — SLACK_BOT_TOKEN не задан, пропуск${RESET}`);
    }
  } else if (!NOTIFICATIONS.slack) {
    console.log(`${DIM}⏭ Slack — отключён в config.mjs${RESET}`);
  }

  console.log(`\n${GREEN}✅ Еженедельная проверка завершена${RESET}\n`);
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

// Run
main().catch(e => {
  console.error(`\n${RED}❌ Ошибка: ${e.message}${RESET}`);
  console.error(e.stack);
  process.exit(1);
});
