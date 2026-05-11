#!/usr/bin/env node
/**
 * Fetch indexing status from Google Search Console URL Inspection API.
 *
 * Zero external dependencies. Reuses OAuth2 refresh token from fetch-gsc.mjs.
 *
 * Usage:
 *   node seo-tracking/scripts/inspect-index.mjs
 *
 * Env vars: GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN
 */

import { loadEnv, requireEnv } from './env.mjs';
import { getAccessToken } from './fetch-gsc.mjs';
import { SITE_URL } from '../config.mjs';

loadEnv();

const SITE_PROPERTY = 'sc-domain:firmalo.io';
const INSPECT_API = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

// URL Inspection API quota: 2000/day, 600/min. Sleep between requests to stay under burst.
const REQUEST_DELAY_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inspectOne(accessToken, inspectionUrl) {
  const res = await fetch(INSPECT_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inspectionUrl,
      siteUrl: SITE_PROPERTY,
      languageCode: 'en-US',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Inspect ${inspectionUrl}: ${res.status} — ${err}`);
  }

  const data = await res.json();
  const index = data.inspectionResult?.indexStatusResult ?? {};

  return {
    verdict: index.verdict ?? null,
    coverageState: index.coverageState ?? null,
    indexingState: index.indexingState ?? null,
    robotsTxtState: index.robotsTxtState ?? null,
    pageFetchState: index.pageFetchState ?? null,
    crawledAs: index.crawledAs ?? null,
    lastCrawlTime: index.lastCrawlTime ?? null,
    googleCanonical: index.googleCanonical ?? null,
    userCanonical: index.userCanonical ?? null,
  };
}

/**
 * @param {string[]} paths — pathnames like "/es/firmar-pdf-online-gratis"
 * @returns {Promise<Array<{url: string} & Awaited<ReturnType<typeof inspectOne>>>>}
 */
export async function fetchIndexStatus(paths) {
  const clientId = requireEnv('GSC_CLIENT_ID', 'Google OAuth Client ID');
  const clientSecret = requireEnv('GSC_CLIENT_SECRET', 'Google OAuth Client Secret');
  const refreshToken = requireEnv('GSC_REFRESH_TOKEN', 'Google OAuth Refresh Token');

  console.log('   Getting Google token...');
  const token = await getAccessToken(clientId, clientSecret, refreshToken);

  const results = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const inspectionUrl = `${SITE_URL}${path}`;
    process.stdout.write(`   [${i + 1}/${paths.length}] ${path}... `);
    try {
      const status = await inspectOne(token, inspectionUrl);
      results.push({ url: path, ...status });
      console.log(status.verdict || 'UNKNOWN');
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      results.push({ url: path, error: e.message });
    }
    if (i < paths.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  return results;
}

// Run standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const core = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'semantic-core.json'), 'utf-8')
    );
    const paths = [...new Set(core.pages.map((p) => p.url))];
    const results = await fetchIndexStatus(paths);
    console.log('\n' + JSON.stringify(results, null, 2));
  } catch (e) {
    console.error(`\x1b[31m${e.message}\x1b[0m`);
    process.exit(1);
  }
}
