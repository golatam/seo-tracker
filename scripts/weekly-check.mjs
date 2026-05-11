#!/usr/bin/env node
/**
 * Weekly position check — Firmalo.io
 *
 * Full cycle: fetch GSC data -> snapshot -> compare -> Slack report.
 *
 * Usage:
 *   node seo-tracking/scripts/weekly-check.mjs [--no-slack] [--dry-run]
 *
 * Env vars: see seo-tracking/.env.example
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
import { SNAPSHOTS_DIR, NOTIFICATIONS } from '../config.mjs';

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
  console.log(`\n${BOLD}Weekly position check — Firmalo.io${RESET}`);
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

  // Extract tracked keywords (Google only for LATAM)
  const googleKeywords = [];
  const trackedKeywordMap = new Map();
  for (const page of core.pages) {
    for (const kw of page.keywords) {
      if (kw.tracked === false) continue;
      if (kw.engines.includes('google')) {
        googleKeywords.push(kw.keyword);
        trackedKeywordMap.set(`${kw.keyword}|google`, {
          keyword: kw.keyword,
          url: page.url,
          engine: 'google',
          category: page.category,
        });
      }
    }
  }

  console.log(`${CYAN}Semantic core:${RESET} ${core.pages.length} pages`);
  console.log(`   Tracked keywords: ${googleKeywords.length} (Google)\n`);

  // 2. Fetch positions from GSC
  const entries = [];
  const fetchedKeys = new Set();

  if (googleKeywords.length > 0 && process.env.GSC_CLIENT_ID) {
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
      console.log(`   ${GREEN}${entries.length} keywords from GSC${RESET}\n`);
    } catch (e) {
      console.log(`   ${YELLOW}GSC unavailable after ${MAX_RETRIES} attempts: ${e.message}${RESET}\n`);
    }
  } else if (googleKeywords.length > 0) {
    console.log(`${DIM}GSC skipped — GSC_CLIENT_ID not set${RESET}\n`);
  }

  // 2a. Ensure sitemap is registered in GSC
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

  // 2b. Fetch index status for each unique page
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
    console.log(`Check API keys in .env (see seo-tracking/.env.example)\n`);
    return;
  }

  // 4. Save snapshot
  const today = new Date().toISOString().split('T')[0];
  const snapshot = {
    date: today,
    source: 'api',
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

    if (NOTIFICATIONS.slack && !noSlack && process.env.SLACK_BOT_TOKEN) {
      console.log(`${BOLD}Sending to Slack...${RESET}`);
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
  for (const e of prevSnapshot.entries) prevMap.set(entryKey(e), e);

  const currMap = new Map();
  for (const e of entries) currMap.set(entryKey(e), e);

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
    indexStatus,
    sitemap,
  };

  // Print console summary
  console.log(`${BOLD}====================================${RESET}`);
  console.log(`${BOLD}  ${prevSnapshot.date} -> ${today}${RESET}`);
  console.log(`${BOLD}====================================${RESET}`);
  console.log(`  Improved: ${summary.improved}`);
  console.log(`  Declined: ${summary.declined}`);
  console.log(`  Unchanged: ${summary.unchanged}`);
  if (summary.noData > 0) console.log(`  No data: ${summary.noData}`);
  console.log(`  Avg position: ${summary.prevAvgPosition} -> ${summary.avgPosition}\n`);

  // 6. Send Slack notification
  if (NOTIFICATIONS.slack && !noSlack) {
    if (process.env.SLACK_BOT_TOKEN) {
      console.log(`${BOLD}Sending to Slack...${RESET}`);
      try {
        const { sendSlackReport } = await import('./notify-slack.mjs');
        await sendSlackReport(report, 'report');
      } catch (e) {
        console.error(`${RED}Slack error: ${e.message}${RESET}`);
      }
    } else {
      console.log(`${DIM}Slack skipped — SLACK_BOT_TOKEN not set${RESET}`);
    }
  }

  console.log(`\n${GREEN}Weekly check completed${RESET}\n`);
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;
}

main().catch(e => {
  console.error(`\n${RED}Error: ${e.message}${RESET}`);
  console.error(e.stack);
  process.exit(1);
});
