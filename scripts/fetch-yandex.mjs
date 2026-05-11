#!/usr/bin/env node
/**
 * Fetch positions from Yandex.Webmaster API v4.
 *
 * Zero external dependencies. Uses OAuth token.
 *
 * Usage:
 *   node scripts/fetch-yandex.mjs
 *
 * Env vars: SITE_URL, YANDEX_OAUTH_TOKEN, YANDEX_USER_ID (optional),
 *           YANDEX_HOST_ID (optional)
 */

import { readFileSync } from 'node:fs';
import { loadEnv, requireEnv } from './env.mjs';
import { getCorePath } from '../config.mjs';

loadEnv();

const API_BASE = 'https://api.webmaster.yandex.net/v4';

function siteHostname() {
  const url = process.env.SITE_URL;
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
}

function buildKeywordUrlMap() {
  try {
    const core = JSON.parse(readFileSync(getCorePath(), 'utf-8'));
    const map = new Map();
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

async function yandexApi(path, token, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `OAuth ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Yandex API error: ${res.status} — ${err}`);
  }
  return res.json();
}

async function fetchSearchQueries(token, userId, hostId, keywords = []) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 30);

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

    if (queries.length < limit) break;
    offset += limit;
  }

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

async function detectUserAndHost(token, hostname) {
  const userData = await yandexApi('/user/', token);
  const userId = userData.user_id;

  const hostsData = await yandexApi(`/user/${userId}/hosts/`, token);
  const hosts = hostsData.hosts || [];

  const targetHost = hosts.find(h => {
    const hostUrl = h.unicode_host_url || h.ascii_host_url || '';
    return hostUrl.includes(hostname);
  });

  return {
    userId,
    hostId: targetHost?.host_id || null,
  };
}

export async function fetchYandexPositions(keywords = []) {
  const token = requireEnv('YANDEX_OAUTH_TOKEN', 'Yandex OAuth token');
  const hostname = siteHostname();
  if (!hostname) throw new Error('SITE_URL is not set — required to locate the Yandex host');

  let userId = process.env.YANDEX_USER_ID;
  let hostId = process.env.YANDEX_HOST_ID;

  if (!userId || !hostId) {
    console.log('   Detecting user_id and host_id...');
    const detected = await detectUserAndHost(token, hostname);
    userId = userId || detected.userId;
    hostId = hostId || detected.hostId;

    if (!hostId) {
      throw new Error(
        `Site ${hostname} not found in Yandex.Webmaster.\n` +
        `Add and verify the site at https://webmaster.yandex.com/`
      );
    }

    console.log(`   user_id=${userId}, host_id=${hostId}`);
    console.log(`   Tip: set YANDEX_USER_ID and YANDEX_HOST_ID in .env to skip detection.\n`);
  }

  console.log('   Fetching data from Yandex.Webmaster...');
  const results = await fetchSearchQueries(token, userId, hostId, keywords);

  console.log(`   Got ${results.length} entries from Yandex`);
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const results = await fetchYandexPositions();
    console.log(JSON.stringify(results, null, 2));
  } catch (e) {
    console.error(`\x1b[31m${e.message}\x1b[0m`);
    process.exit(1);
  }
}
