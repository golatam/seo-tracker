#!/usr/bin/env node
/**
 * Fetch positions from Google Search Console API
 *
 * Zero external dependencies. Uses OAuth2 refresh token.
 *
 * Usage:
 *   node seo-tracking/scripts/fetch-gsc.mjs [--days=30]
 *
 * Env vars: GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN
 */

import { loadEnv, requireEnv } from './env.mjs';

loadEnv();

// Domain property in GSC (sc-domain:) covers all protocols and subdomains
const SITE_URL = 'sc-domain:firmalo.io';
const GSC_API = 'https://searchconsole.googleapis.com/webmasters/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ─── Args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const daysBack = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1] || '30');

// ─── OAuth2 with Refresh Token ──────────────────────────────────────

export async function getAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google OAuth error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  return data.access_token;
}

// ─── GSC API ─────────────────────────────────────────────────────────

async function fetchSearchAnalytics(accessToken, keywords) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - daysBack);

  const fmt = d => d.toISOString().split('T')[0];

  const body = {
    startDate: fmt(startDate),
    endDate: fmt(endDate),
    dimensions: ['query', 'page'],
    rowLimit: 5000,
  };

  if (keywords.length === 1) {
    body.dimensionFilterGroups = [{
      filters: [{
        dimension: 'query',
        operator: 'equals',
        expression: keywords[0],
      }],
    }];
  }

  const siteEncoded = encodeURIComponent(SITE_URL);
  const url = `${GSC_API}/sites/${siteEncoded}/searchAnalytics/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GSC API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  const rows = data.rows || [];

  return rows.map(row => ({
    keyword: row.keys[0],
    url: new URL(row.keys[1]).pathname.replace(/\/?$/, '/'),
    position: Math.round(row.position * 10) / 10,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: Math.round(row.ctr * 1000) / 10,
  }));
}

// ─── Main ────────────────────────────────────────────────────────────

export async function fetchGscPositions(keywords = []) {
  const clientId = requireEnv('GSC_CLIENT_ID', 'Google OAuth Client ID');
  const clientSecret = requireEnv('GSC_CLIENT_SECRET', 'Google OAuth Client Secret');
  const refreshToken = requireEnv('GSC_REFRESH_TOKEN', 'Google OAuth Refresh Token');

  console.log('   Getting Google token...');
  const token = await getAccessToken(clientId, clientSecret, refreshToken);

  console.log(`   Fetching GSC data for the last ${daysBack} days...`);
  const results = await fetchSearchAnalytics(token, keywords);

  console.log(`   Got ${results.length} entries from GSC`);
  return results;
}

// Run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const results = await fetchGscPositions();
    console.log(JSON.stringify(results, null, 2));
  } catch (e) {
    console.error(`\x1b[31m${e.message}\x1b[0m`);
    process.exit(1);
  }
}
