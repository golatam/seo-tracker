#!/usr/bin/env node
/**
 * Сбор позиций из Яндекс.Вебмастер API v4
 *
 * Без внешних зависимостей. Использует OAuth-токен.
 *
 * Яндекс.Вебмастер API возвращает популярные запросы с показателями:
 * позиция, показы, клики, CTR.
 *
 * Usage:
 *   node seo-tracking/scripts/fetch-yandex.mjs
 *
 * Env vars: YANDEX_OAUTH_TOKEN, YANDEX_USER_ID, YANDEX_HOST_ID
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, requireEnv } from './env.mjs';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = resolve(__dirname, '..', 'semantic-core.json');
const API_BASE = 'https://api.webmaster.yandex.net/v4';

// ─── Keyword → URL mapping from semantic core ───────────────────────

function buildKeywordUrlMap() {
  try {
    const core = JSON.parse(readFileSync(CORE_PATH, 'utf-8'));
    const map = new Map(); // keyword.toLowerCase() → url
    for (const page of core.pages) {
      for (const kw of page.keywords) {
        if (kw.engines.includes('yandex')) {
          map.set(kw.keyword.toLowerCase(), page.url);
        }
      }
    }
    return map;
  } catch { return new Map(); }
}

// ─── API helpers ─────────────────────────────────────────────────────

async function yandexApi(path, token, method = 'GET', body = null) {
  const url = `${API_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': `OAuth ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Яндекс API error: ${res.status} — ${err}`);
  }

  return res.json();
}

/**
 * Получает поисковые запросы с позициями из Яндекс.Вебмастер.
 *
 * API endpoint: GET /user/{user_id}/hosts/{host_id}/search-queries/popular
 * Возвращает популярные запросы за указанный период с показателями.
 *
 * Пагинация: API возвращает до 500 записей за запрос.
 * При count > 500 делаем повторные запросы с offset.
 */
async function fetchSearchQueries(token, userId, hostId, keywords = []) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 30); // последние 30 дней

  const fmt = d => d.toISOString().split('T')[0];
  const encodedHost = encodeURIComponent(hostId);

  const indicators = ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION'];
  const indicatorParams = indicators.map(i => `query_indicator=${i}`).join('&');

  let allQueries = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const path = `/user/${userId}/hosts/${encodedHost}/search-queries/popular`
      + `?date_from=${fmt(startDate)}&date_to=${fmt(endDate)}`
      + `&${indicatorParams}`
      + `&order_by=TOTAL_SHOWS&offset=${offset}&limit=${limit}`;

    const data = await yandexApi(path, token, 'GET');
    const queries = data.queries || [];
    allQueries = allQueries.concat(queries);

    // Если получили меньше limit — это последняя страница
    if (queries.length < limit) break;
    offset += limit;
  }

  // Фильтруем по ключевым словам, если переданы
  let filtered = allQueries;
  if (keywords.length > 0) {
    const keywordSet = new Set(keywords.map(k => k.toLowerCase()));
    filtered = allQueries.filter(q => keywordSet.has(q.query_text.toLowerCase()));
  }

  const kwUrlMap = buildKeywordUrlMap();

  return filtered.map(q => ({
    keyword: q.query_text,
    url: kwUrlMap.get(q.query_text.toLowerCase()) || null,
    position: q.indicators?.AVG_SHOW_POSITION != null
      ? Math.round(q.indicators.AVG_SHOW_POSITION * 10) / 10
      : null,
    clicks: q.indicators?.TOTAL_CLICKS || 0,
    impressions: q.indicators?.TOTAL_SHOWS || 0,
  }));
}

// ─── Auto-detect user_id and host_id ─────────────────────────────────

async function detectUserAndHost(token, siteUrl) {
  // Get user_id
  const userData = await yandexApi('/user/', token);
  const userId = userData.user_id;

  // Get hosts
  const hostsData = await yandexApi(`/user/${userId}/hosts/`, token);
  const hosts = hostsData.hosts || [];

  // Find matching host
  const targetHost = hosts.find(h => {
    const hostUrl = h.unicode_host_url || h.ascii_host_url || '';
    return hostUrl.includes('golatam.group');
  });

  return {
    userId,
    hostId: targetHost?.host_id || null,
  };
}

// ─── Main ────────────────────────────────────────────────────────────

export async function fetchYandexPositions(keywords = []) {
  const token = requireEnv('YANDEX_OAUTH_TOKEN', 'OAuth-токен Яндекса');

  let userId = process.env.YANDEX_USER_ID;
  let hostId = process.env.YANDEX_HOST_ID;

  // Автоопределение, если не указаны
  if (!userId || !hostId) {
    console.log('   Определяю user_id и host_id...');
    const detected = await detectUserAndHost(token, 'golatam.group');
    userId = userId || detected.userId;
    hostId = hostId || detected.hostId;

    if (!hostId) {
      throw new Error(
        'Сайт golatam.group не найден в Яндекс.Вебмастере.\n' +
        'Добавьте и подтвердите сайт в https://webmaster.yandex.ru/'
      );
    }

    console.log(`   user_id=${userId}, host_id=${hostId}`);
    console.log(`   Совет: добавьте YANDEX_USER_ID и YANDEX_HOST_ID в .env для ускорения.\n`);
  }

  console.log('   Запрашиваю данные из Яндекс.Вебмастер...');
  const results = await fetchSearchQueries(token, userId, hostId, keywords);

  console.log(`   Получено ${results.length} записей из Яндекса`);
  return results;
}

// Run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const results = await fetchYandexPositions();
    console.log(JSON.stringify(results, null, 2));
  } catch (e) {
    console.error(`\x1b[31m${e.message}\x1b[0m`);
    process.exit(1);
  }
}
