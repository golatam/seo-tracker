#!/usr/bin/env node
/**
 * Ensure sitemap is submitted to Google Search Console.
 *
 * Calls sites.sitemaps.list; if {SITE_URL}/sitemap.xml isn't there,
 * submits it via sites.sitemaps.submit. Idempotent — safe to rerun.
 *
 * Usage:
 *   node seo-tracking/scripts/submit-sitemap.mjs
 *
 * Env vars: SITE_URL, SITE_PROPERTY, GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN
 */

import { loadEnv, requireEnv } from './env.mjs';
import { getAccessToken } from './fetch-gsc.mjs';

loadEnv();

const GSC_API = 'https://searchconsole.googleapis.com/webmasters/v3';

async function listSitemaps(token, siteProperty) {
  const url = `${GSC_API}/sites/${encodeURIComponent(siteProperty)}/sitemaps`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sitemaps.list: ${res.status} — ${await res.text()}`);
  const data = await res.json();
  return data.sitemap ?? [];
}

async function submitSitemap(token, siteProperty, feedpath) {
  const url = `${GSC_API}/sites/${encodeURIComponent(siteProperty)}/sitemaps/${encodeURIComponent(feedpath)}`;
  const res = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sitemaps.submit: ${res.status} — ${await res.text()}`);
}

export async function ensureSitemapSubmitted() {
  const siteUrl = requireEnv('SITE_URL', 'Website origin, e.g. https://example.com (no trailing slash)');
  const siteProperty = requireEnv('SITE_PROPERTY', 'GSC site property, e.g. sc-domain:example.com');
  const clientId = requireEnv('GSC_CLIENT_ID', 'Google OAuth Client ID');
  const clientSecret = requireEnv('GSC_CLIENT_SECRET', 'Google OAuth Client Secret');
  const refreshToken = requireEnv('GSC_REFRESH_TOKEN', 'Google OAuth Refresh Token');

  const sitemapUrl = `${siteUrl}/sitemap.xml`;

  console.log('   Getting Google token...');
  const token = await getAccessToken(clientId, clientSecret, refreshToken);

  const sitemaps = await listSitemaps(token, siteProperty);
  const existing = sitemaps.find((s) => s.path === sitemapUrl);

  if (!existing) {
    console.log(`   Submitting ${sitemapUrl} (first time)...`);
    try {
      await submitSitemap(token, siteProperty, sitemapUrl);
      return {
        url: sitemapUrl,
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
        url: sitemapUrl,
        submitted: false,
        alreadyRegistered: false,
        scopeError: isScopeIssue,
        submitError: isScopeIssue ? null : e.message,
      };
    }
  }

  console.log(`   Already registered — last downloaded: ${existing.lastDownloaded ?? 'never'}`);
  return {
    url: sitemapUrl,
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
