#!/usr/bin/env node
/**
 * Weekly position check — orchestrator.
 *
 * Full cycle: fetch GSC (+ optional Yandex) -> snapshot -> compare ->
 * notify (Slack and/or Telegram).
 *
 * Usage:
 *   node scripts/weekly-check.mjs [--no-slack] [--no-telegram] [--dry-run]
 *
 * Env vars: see .env.example
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from './env.mjs';
import {
  getCorePath,
  getSnapshotsDir,
  getSiteName,
  getNotifiers,
  isYandexEnabled,
  loadClusters,
} from '../config.mjs';
import { buildReportModel } from './report-model.mjs';
import { renderMarkdownReport } from './render-markdown-report.mjs';
import { buildCsv } from './export-csv.mjs';

loadEnv();

const SNAPSHOTS_DIR = getSnapshotsDir();
const CORE_PATH = getCorePath();

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
const noSlack = args.includes('--no-slack');
const noTelegram = args.includes('--no-telegram');
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
        console.log(`   ${YELLOW}Warning: ${label}: attempt ${attempt}/${MAX_RETRIES} failed: ${e.message}${RESET}`);
        console.log(`   ${DIM}Retrying in ${RETRY_DELAY_MS / 1000}s...${RESET}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      } else {
        throw e;
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const siteName = getSiteName();
  const notifiers = getNotifiers();
  const yandexEnabled = isYandexEnabled();
  // Rank source: where keyword POSITIONS come from. GSC/Yandex stay the
  // analytics/indexing layer regardless. Default keeps the legacy behavior.
  const rankSource = (process.env.RANK_SOURCE || 'gsc').toLowerCase();
  const useTopvisor = rankSource === 'topvisor';

  console.log(`\n${BOLD}Weekly position check — ${siteName}${RESET}`);
  console.log(`${DIM}${new Date().toISOString()}${RESET}\n`);

  // 1. Load semantic core
  let core;
  try {
    core = JSON.parse(readFileSync(CORE_PATH, 'utf-8'));
  } catch {
    console.error(`${RED}Semantic core not found: ${CORE_PATH}${RESET}`);
    process.exit(1);
  }

  if (!core.pages || core.pages.length === 0) {
    console.error(`${RED}Semantic core is empty${RESET}`);
    process.exit(1);
  }

  const clusters = loadClusters(core);
  const ctx = { siteName, clusters };

  // Extract tracked keywords per engine
  const googleKeywords = [];
  const yandexKeywords = [];
  const trackedKeywordMap = new Map();
  for (const page of core.pages) {
    for (const kw of page.keywords) {
      if (kw.tracked === false) continue;
      if (kw.engines.includes('google')) {
        googleKeywords.push(kw.keyword);
        trackedKeywordMap.set(`${kw.keyword}|google`, {
          keyword: kw.keyword, url: page.url, engine: 'google', category: page.category,
        });
      }
      if (yandexEnabled && kw.engines.includes('yandex')) {
        yandexKeywords.push(kw.keyword);
        trackedKeywordMap.set(`${kw.keyword}|yandex`, {
          keyword: kw.keyword, url: page.url, engine: 'yandex', category: page.category,
        });
      }
    }
  }

  const totalTracked = googleKeywords.length + yandexKeywords.length;
  console.log(`${CYAN}Semantic core:${RESET} ${core.pages.length} pages`);
  console.log(`   Tracked keywords: ${totalTracked} (Google: ${googleKeywords.length}${yandexEnabled ? `, Yandex: ${yandexKeywords.length}` : ''})\n`);

  // 2. Fetch positions
  const entries = [];
  const fetchedKeys = new Set();

  // 2-topvisor. Topvisor as the rank source (read-only). Covers all engines
  // configured in the Topvisor project, so it replaces the GSC/Yandex
  // position fetch below (those remain only for indexation analytics).
  if (useTopvisor) {
    console.log(`${BOLD}Topvisor${RESET}`);
    try {
      const tvEntries = await withRetry(async () => {
        const { fetchTopvisorPositions } = await import('./providers/topvisor.mjs');
        return await fetchTopvisorPositions();
      }, 'Topvisor');

      for (const e of tvEntries) {
        entries.push({
          keyword: e.keyword,
          url: e.url,
          engine: e.engine,
          position: e.position,
          regionIndex: e.regionIndex,
          regionName: e.regionName,
          device: e.device,
          actualUrl: e.actualUrl,
        });
        fetchedKeys.add(`${e.keyword}|${e.engine}`);
      }
      console.log(`   ${GREEN}${tvEntries.length} entries from Topvisor${RESET}\n`);
    } catch (e) {
      console.log(`   ${YELLOW}Topvisor unavailable after ${MAX_RETRIES} attempts: ${e.message}${RESET}\n`);
    }
  }

  // 2a. Google Search Console
  if (!useTopvisor && googleKeywords.length > 0 && process.env.GSC_CLIENT_ID) {
    console.log(`${BOLD}Google Search Console${RESET}`);
    try {
      const gscResults = await withRetry(async () => {
        const { fetchGscPositions } = await import('./fetch-gsc.mjs');
        return await fetchGscPositions(googleKeywords);
      }, 'GSC');

      const googleKwSet = new Set(googleKeywords.map(k => k.toLowerCase()));
      for (const r of gscResults) {
        if (googleKwSet.has(r.keyword.toLowerCase())) {
          entries.push({
            keyword: r.keyword,
            url: r.url,
            engine: 'google',
            position: Math.round(r.position),
          });
          fetchedKeys.add(`${r.keyword}|google`);
        }
      }
      console.log(`   ${GREEN}${entries.filter(e => e.engine === 'google').length} keywords from GSC${RESET}\n`);
    } catch (e) {
      console.log(`   ${YELLOW}GSC unavailable after ${MAX_RETRIES} attempts: ${e.message}${RESET}\n`);
    }
  } else if (!useTopvisor && googleKeywords.length > 0) {
    console.log(`${DIM}GSC skipped — GSC_CLIENT_ID not set${RESET}\n`);
  }

  // 2b. Yandex.Webmaster (optional)
  if (!useTopvisor && yandexEnabled && yandexKeywords.length > 0 && process.env.YANDEX_OAUTH_TOKEN) {
    console.log(`${BOLD}Yandex.Webmaster${RESET}`);
    try {
      const yandexResults = await withRetry(async () => {
        const { fetchYandexPositions } = await import('./fetch-yandex.mjs');
        return await fetchYandexPositions(yandexKeywords);
      }, 'Yandex');

      const yandexKwSet = new Set(yandexKeywords.map(k => k.toLowerCase()));
      for (const r of yandexResults) {
        if (yandexKwSet.has(r.keyword.toLowerCase())) {
          entries.push({
            keyword: r.keyword,
            url: r.url,
            engine: 'yandex',
            position: r.position ? Math.round(r.position) : null,
          });
          fetchedKeys.add(`${r.keyword}|yandex`);
        }
      }
      console.log(`   ${GREEN}${entries.filter(e => e.engine === 'yandex').length} keywords from Yandex${RESET}\n`);
    } catch (e) {
      console.log(`   ${YELLOW}Yandex unavailable after ${MAX_RETRIES} attempts: ${e.message}${RESET}\n`);
    }
  } else if (yandexEnabled && yandexKeywords.length > 0) {
    console.log(`${DIM}Yandex skipped — YANDEX_OAUTH_TOKEN not set${RESET}\n`);
  }

  // 2c. Ensure sitemap is registered in GSC
  let sitemap = null;
  if (process.env.GSC_CLIENT_ID) {
    console.log(`${BOLD}Sitemap${RESET}`);
    try {
      sitemap = await withRetry(async () => {
        const { ensureSitemapSubmitted } = await import('./submit-sitemap.mjs');
        return await ensureSitemapSubmitted();
      }, 'Sitemap');
      console.log('');
    } catch (e) {
      console.log(`   ${YELLOW}Sitemap check failed: ${e.message}${RESET}\n`);
    }
  }

  // 2d. Fetch index status for each unique page
  let indexStatus = [];
  const uniquePaths = [...new Set(core.pages.map((p) => p.url))];
  if (uniquePaths.length > 0 && process.env.GSC_CLIENT_ID) {
    console.log(`${BOLD}Google URL Inspection${RESET}`);
    try {
      indexStatus = await withRetry(async () => {
        const { fetchIndexStatus } = await import('./inspect-index.mjs');
        return await fetchIndexStatus(uniquePaths);
      }, 'URL Inspection');

      const indexed = indexStatus.filter((s) => s.verdict === 'PASS').length;
      const partial = indexStatus.filter((s) => s.verdict === 'PARTIAL').length;
      const failed = indexStatus.filter((s) => s.verdict === 'FAIL').length;
      const neutral = indexStatus.filter((s) => s.verdict === 'NEUTRAL').length;
      const errors = indexStatus.filter((s) => s.error).length;
      console.log(
        `   ${GREEN}indexed: ${indexed}${RESET} / partial: ${partial} / ${RED}failed: ${failed}${RESET} / neutral: ${neutral}` +
        (errors ? ` / ${RED}errors: ${errors}${RESET}` : '') +
        ` (total: ${indexStatus.length})\n`
      );
    } catch (e) {
      console.log(`   ${YELLOW}URL Inspection unavailable after ${MAX_RETRIES} attempts: ${e.message}${RESET}\n`);
    }
  }

  // 3. Fill missing tracked keywords with position: null
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
    console.log(`${DIM}${filledCount} keywords without API data -> position: null${RESET}\n`);
  }

  if (entries.length === 0) {
    console.log(`${YELLOW}No positions fetched.${RESET}`);
    console.log(`Check API keys in .env (see .env.example)\n`);
    return;
  }

  // 4. Save snapshot
  const today = new Date().toISOString().split('T')[0];
  const snapshot = {
    date: today,
    source: useTopvisor ? 'topvisor' : 'api',
    comment: 'weekly auto-check',
    entries,
    indexStatus,
    sitemap,
  };

  if (dryRun) {
    console.log(`${YELLOW}Dry run — snapshot not saved${RESET}`);
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  const snapshotPath = resolve(SNAPSHOTS_DIR, `${today}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`${GREEN}Snapshot saved: ${snapshotPath}${RESET}\n`);

  // 5. Compare with previous
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  const currentFile = `${today}.json`;
  const prevFiles = files.filter(f => f < currentFile);

  if (prevFiles.length === 0) {
    console.log(`${YELLOW}First snapshot — comparison unavailable.${RESET}\n`);
    await sendNotifications(snapshot, 'snapshot', notifiers, ctx);
    return;
  }

  const prevSnapshot = JSON.parse(
    readFileSync(resolve(SNAPSHOTS_DIR, prevFiles[prevFiles.length - 1]), 'utf-8')
  );

  // Build the normalized report model — the single source of truth shared by
  // the notifiers, the markdown renderer and the CSV exporter. Metrics are
  // computed once here, never recomputed downstream.
  const reportsDir = resolve(SNAPSHOTS_DIR, 'reports');
  const markdownPath = resolve(reportsDir, `${today}-weekly.md`);
  const csvPath = resolve(reportsDir, `${today}-positions.csv`);

  const model = buildReportModel(prevSnapshot, snapshot, core, {
    clusters,
    site: siteName,
    source: snapshot.source,
    snapshotPath,
    markdownPath,
    csvPath,
  });

  // Save full weekly markdown report + raw CSV appendix next to the snapshots.
  // (dry-run returns earlier, so this only runs for real snapshots that have
  //  a previous snapshot to diff against.)
  try {
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(markdownPath, renderMarkdownReport(model, ctx), 'utf-8');
    writeFileSync(csvPath, buildCsv(model), 'utf-8');
    console.log(`${GREEN}Report saved: ${markdownPath}${RESET}`);
    console.log(`${GREEN}CSV saved:    ${csvPath}${RESET}\n`);
  } catch (e) {
    console.log(`${YELLOW}Could not write report files: ${e.message}${RESET}\n`);
  }

  // Print console summary
  const { summary, verdict } = model;
  console.log(`${BOLD}====================================${RESET}`);
  console.log(`${BOLD}  ${prevSnapshot.date} -> ${today}${RESET}`);
  console.log(`${BOLD}====================================${RESET}`);
  console.log(`  Verdict: ${verdict.emoji} ${verdict.level} — ${verdict.text}`);
  console.log(`  Improved: ${summary.improved}`);
  console.log(`  Declined: ${summary.declined}`);
  console.log(`  Unchanged: ${summary.unchanged}`);
  if (summary.noData > 0) console.log(`  No data: ${summary.noData}`);
  if (summary.newlyTracked > 0) console.log(`  Newly tracked: ${summary.newlyTracked}`);
  console.log(`  Visibility: ${summary.prevVisibilityScore} -> ${summary.visibilityScore} (${signed(summary.visibilityDelta)}%)`);
  console.log(`  Avg position: ${summary.prevAvgPosition} -> ${summary.avgPosition}\n`);

  // 6. Send notifications
  await sendNotifications(model, 'report', notifiers, ctx);

  console.log(`\n${GREEN}Weekly check completed${RESET}\n`);
}

function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

async function sendNotifications(payload, type, notifiers, ctx) {
  if (notifiers.slack && !noSlack) {
    if (process.env.SLACK_BOT_TOKEN) {
      console.log(`${BOLD}Sending to Slack...${RESET}`);
      try {
        const { sendSlackReport } = await import('./notify-slack.mjs');
        await sendSlackReport(payload, type, ctx);
      } catch (e) {
        console.error(`${RED}Slack error: ${e.message}${RESET}`);
      }
    } else {
      console.log(`${DIM}Slack skipped — SLACK_BOT_TOKEN not set${RESET}`);
    }
  }

  if (notifiers.telegram && !noTelegram) {
    if (process.env.TELEGRAM_BOT_TOKEN) {
      console.log(`${BOLD}Sending to Telegram...${RESET}`);
      try {
        const { sendTelegramReport } = await import('./notify-telegram.mjs');
        await sendTelegramReport(payload, type, ctx);
      } catch (e) {
        console.error(`${RED}Telegram error: ${e.message}${RESET}`);
      }
    } else {
      console.log(`${DIM}Telegram skipped — TELEGRAM_BOT_TOKEN not set${RESET}`);
    }
  }
}

main().catch(e => {
  console.error(`\n${RED}Error: ${e.message}${RESET}`);
  console.error(e.stack);
  process.exit(1);
});
