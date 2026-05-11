#!/usr/bin/env node
/**
 * Ensure sitemap is submitted to Google Search Console.
 *
 * Calls sites.sitemaps.list; if firmalo.io/sitemap.xml isn't there,
 * submits it via sites.sitemaps.submit. Idempotent — safe to rerun.
 *
 * Usage:
 *   node seo-tracking/scripts/submit-sitemap.mjs
 *
 * Env vars: GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN
 */

import { loadEnv, requireEnv } from './env.mjs';
import { getAccessToken } from './fetch-gsc.mjs';
import { SITE_URL } from '../config.mjs';

loadEnv();

const SITE_PROPERTY = 'sc-domain:firmalo.io';
const SITEMAP_URL = `${SITE_URL}/sitemap.xml`;
const GSC_API = 'https://searchconsole.googleapis.com/webmasters/v3';

async function listSitemaps(token) {
  const url = `${GSC_API}/sites/${encodeURIComponent(SITE_PROPERTY)}/sitemaps`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sitemaps.list: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  return data.sitemap ?? [];
}

async function submitSitemap(token, feedpath) {
  const url = `${GSC_API}/sites/${encodeURIComponent(SITE_PROPERTY)}/sitemaps/${encodeURIComponent(feedpath)}`;
  const res = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sitemaps.submit: ${res.status} — ${await res.text()}`);
}

export async function ensureSitemapSubmitted() {
  const clientId = requireEnv('GSC_CLIENT_ID', 'Google OAuth Client ID');
  const clientSecret = requireEnv('GSC_CLIENT_SECRET', 'Google OAuth Client Secret');
  const refreshToken = requireEnv('GSC_REFRESH_TOKEN', 'Google OAuth Refresh Token');

  console.log('   Getting Google token...');
  const token = await getAccessToken(clientId, clientSecret, refreshToken);

  const sitemaps = await listSitemaps(token);
  const existing = sitemaps.find((s) => s.path === SITEMAP_URL);

  if (!existing) {
    console.log(`   Submitting ${SITEMAP_URL} (first time)...`);
    try {
      await submitSitemap(token, SITEMAP_URL);
      return {
        url: SITEMAP_URL,
        submitted: true,
        alreadyRegistered: false,
        lastSubmitted: null,
        lastDownloaded: null,
        warnings: 0,
        errors: 0,
        isPending: true,
      };
    } catch (e) {
      const isScopeIssue = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/.test(e.message);
      console.log(`   ${isScopeIssue ? 'Submit needs write scope (https://www.googleapis.com/auth/webmasters) — skipping' : 'Submit failed: ' + e.message}`);
      return {
        url: SITEMAP_URL,
        submitted: false,
        alreadyRegistered: false,
        scopeError: isScopeIssue,
        submitError: isScopeIssue ? null : e.message,
      };
    }
  }

  console.log(`   Already registered — last downloaded: ${existing.lastDownloaded ?? 'never'}`);
  return {
    url: SITEMAP_URL,
    submitted: false,
    alreadyRegistered: true,
    lastSubmitted: existing.lastSubmitted ?? null,
    lastDownloaded: existing.lastDownloaded ?? null,
    warnings: Number(existing.warnings ?? 0),
    errors: Number(existing.errors ?? 0),
    isPending: Boolean(existing.isPending),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await ensureSitemapSubmitted();
    console.log('\n' + JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`\x1b[31m${e.message}\x1b[0m`);
    process.exit(1);
  }
}
