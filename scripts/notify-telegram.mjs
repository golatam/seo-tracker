#!/usr/bin/env node
/**
 * Send SEO report to Telegram (HTML parse mode).
 *
 * Usage:
 *   node scripts/notify-telegram.mjs [--test]
 *
 * Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID (optional)
 */

import { loadEnv, requireEnv } from './env.mjs';
import { NOISE_THRESHOLD, getSiteName, loadClusters } from '../config.mjs';

loadEnv();

const TELEGRAM_MAX_LEN = 4096;
const SAFE_MAX_LEN = 3900;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMessage(token, chatId, html) {
  const payload = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const threadId = process.env.TELEGRAM_THREAD_ID;
  if (threadId) payload.message_thread_id = parseInt(threadId, 10);

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description || res.statusText} (code ${data.error_code || res.status})`);
  }
  return data;
}

// Split a long HTML message into chunks <= SAFE_MAX_LEN, breaking on blank
// lines first, then on single newlines. Never splits inside an HTML tag.
function splitForTelegram(html) {
  if (html.length <= SAFE_MAX_LEN) return [html];

  const chunks = [];
  const sections = html.split('\n\n');
  let buf = '';

  const flush = () => {
    if (buf) { chunks.push(buf); buf = ''; }
  };

  for (const section of sections) {
    const candidate = buf ? `${buf}\n\n${section}` : section;
    if (candidate.length <= SAFE_MAX_LEN) {
      buf = candidate;
      continue;
    }
    flush();
    if (section.length <= SAFE_MAX_LEN) {
      buf = section;
    } else {
      const lines = section.split('\n');
      let lineBuf = '';
      for (const line of lines) {
        const c = lineBuf ? `${lineBuf}\n${line}` : line;
        if (c.length <= SAFE_MAX_LEN) {
          lineBuf = c;
        } else {
          if (lineBuf) chunks.push(lineBuf);
          lineBuf = line.slice(0, SAFE_MAX_LEN);
        }
      }
      buf = lineBuf;
    }
  }
  flush();
  return chunks;
}

function posChangeText(c) {
  if (c.isNewlyTracked && c.currentPosition !== null) {
    return `→ <b>${c.currentPosition}</b> <i>(new)</i>`;
  }
  if (c.previousPosition === null && c.currentPosition !== null) {
    return `NEW → <b>${c.currentPosition}</b>`;
  }
  if (c.previousPosition !== null && c.currentPosition === null) {
    return `${c.previousPosition} → <b>OUT</b>`;
  }
  if (c.previousPosition === null && c.currentPosition === null) {
    return `N/A`;
  }
  const arrow = c.change > 0 ? '⬆️' : c.change < 0 ? '⬇️' : '→';
  const sign = c.change > 0 ? `+${c.change}` : `${c.change}`;
  const changeStr = c.change !== 0 ? ` (${sign})` : '';
  return `${c.previousPosition} → <b>${c.currentPosition}</b> ${arrow}${changeStr}`;
}

function indexationSection(indexStatus, sitemap) {
  const lines = [];
  const hasIndex = Array.isArray(indexStatus) && indexStatus.length > 0;
  if (!hasIndex && !sitemap) return '';

  lines.push('<b>Indexation</b>');

  if (hasIndex) {
    const total = indexStatus.length;
    const indexed = indexStatus.filter((s) => s.verdict === 'PASS').length;
    const neutral = indexStatus.filter((s) => s.verdict === 'NEUTRAL').length;
    const failed = indexStatus.filter((s) => s.verdict === 'FAIL' || s.verdict === 'PARTIAL').length;
    const unknown = indexStatus.filter((s) => s.coverageState === 'URL is unknown to Google').length;

    lines.push(`✅ <b>Indexed:</b> ${indexed}/${total}`);
    lines.push(`⏳ <b>Awaiting crawl:</b> ${neutral}`);
    lines.push(`❌ <b>Failed:</b> ${failed}`);
    if (unknown > 0) lines.push(`❔ <b>Unknown to Google:</b> ${unknown}`);
  }

  if (sitemap) {
    const lastDl = sitemap.lastDownloaded ? sitemap.lastDownloaded.split('T')[0] : 'never';
    let line;
    if (sitemap.submitted) {
      line = `📡 Sitemap: <b>just submitted</b> (${escapeHtml(sitemap.url || '')})`;
    } else if (sitemap.alreadyRegistered) {
      line = `📡 Sitemap: registered, last downloaded <b>${lastDl}</b> — ${sitemap.errors} errors, ${sitemap.warnings} warnings`;
    } else if (sitemap.scopeError) {
      line = `⚠️ Sitemap: <b>not registered</b> — submit needs OAuth write scope, please submit manually in GSC UI`;
    } else if (sitemap.submitError) {
      line = `⚠️ Sitemap: submit failed — ${escapeHtml(sitemap.submitError)}`;
    } else {
      line = `📡 Sitemap: status unknown`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

function resolveCtx(ctx = {}) {
  return {
    siteName: ctx.siteName || getSiteName(),
    clusters: ctx.clusters || loadClusters(null),
  };
}

export function formatReport(report, ctx = {}) {
  const { siteName, clusters } = resolveCtx(ctx);
  const { summary, changes, currentDate, previousDate, indexStatus, sitemap } = report;
  const sections = [];

  sections.push(`📊 <b>SEO report: ${escapeHtml(siteName)}</b>\n<i>${previousDate} → ${currentDate}</i>`);

  const avgChange = summary.avgPosition - summary.prevAvgPosition;
  const avgDir = avgChange < 0
    ? `⬆️ ${Math.abs(avgChange).toFixed(1)}`
    : avgChange > 0
      ? `⬇️ ${avgChange.toFixed(1)}`
      : '→ 0';

  const summaryLines = [
    '<b>Summary</b>',
    `🔑 <b>Keywords:</b> ${summary.totalKeywords}`,
    `🎯 <b>Avg:</b> ${summary.prevAvgPosition} → ${summary.avgPosition} (${avgDir})`,
    `✅ Improved: <b>${summary.improved}</b>`,
    `❌ Declined: <b>${summary.declined}</b>`,
    `➡️ Unchanged: <b>${summary.unchanged}</b>`,
  ];
  if (summary.noData > 0) summaryLines.push(`N/A: <b>${summary.noData}</b>`);
  if (summary.newInTop > 0) summaryLines.push(`🆕 Entered TOP: <b>${summary.newInTop}</b>`);
  if (summary.newlyTracked > 0) summaryLines.push(`➕ Newly tracked: <b>${summary.newlyTracked}</b>`);
  if (summary.droppedFromTop > 0) summaryLines.push(`💀 Left TOP: <b>${summary.droppedFromTop}</b>`);
  sections.push(summaryLines.join('\n'));

  const indexBlock = indexationSection(indexStatus, sitemap);
  if (indexBlock) sections.push(indexBlock);

  const alerts = changes.filter(c =>
    !c.isNewlyTracked && (
      (c.previousPosition !== null && c.currentPosition === null) ||
      (c.change !== null && c.change < -5)
    )
  );
  if (alerts.length > 0) {
    const lines = ['⚠️ <b>Alerts</b>'];
    for (const a of alerts.slice(0, 10)) {
      lines.push(`🔴 "${escapeHtml(a.keyword)}" ${posChangeText(a)}`);
    }
    sections.push(lines.join('\n'));
  }

  const byCluster = {};
  for (const c of changes) {
    const cat = c.category || 'unknown';
    if (!byCluster[cat]) byCluster[cat] = [];
    byCluster[cat].push(c);
  }

  const clusterLines = ['<b>By cluster</b>'];
  for (const cat of clusters.order) {
    const cl = byCluster[cat];
    if (!cl || cl.length === 0) continue;
    const emoji = clusters.emoji[cat] || '';
    const label = clusters.labels[cat] || cat;
    const imp = cl.filter(c => c.change !== null && c.change > 0).length;
    const dec = cl.filter(c => c.change !== null && c.change < 0).length;
    const prefix = emoji ? `${emoji} ` : '';
    clusterLines.push(`${prefix}<b>${escapeHtml(label)}:</b> +${imp} -${dec} (${cl.length})`);
  }
  if (clusterLines.length > 1) sections.push(clusterLines.join('\n'));

  const improved = changes
    .filter(c => c.change !== null && c.change > NOISE_THRESHOLD && !c.isNewlyTracked)
    .sort((a, b) => b.change - a.change)
    .slice(0, 10);
  if (improved.length > 0) {
    const lines = ['📈 <b>Top improvements</b>'];
    for (const c of improved) {
      const clEmoji = clusters.emoji[c.category] || '';
      const prefix = clEmoji ? `${clEmoji} ` : '';
      lines.push(`${prefix}🟢 "${escapeHtml(c.keyword)}" ${posChangeText(c)}`);
    }
    sections.push(lines.join('\n'));
  }

  const declined = changes
    .filter(c => c.change !== null && c.change < -NOISE_THRESHOLD && !c.isNewlyTracked)
    .sort((a, b) => a.change - b.change)
    .slice(0, 10);
  if (declined.length > 0) {
    const lines = ['📉 <b>Notable declines</b>'];
    for (const c of declined) {
      const clEmoji = clusters.emoji[c.category] || '';
      const prefix = clEmoji ? `${clEmoji} ` : '';
      lines.push(`${prefix}🔻 "${escapeHtml(c.keyword)}" ${posChangeText(c)}`);
    }
    sections.push(lines.join('\n'));
  }

  sections.push(`<i>${escapeHtml(siteName)} SEO tracker</i>`);
  return sections.join('\n\n');
}

export function formatSnapshot(snapshot, ctx = {}) {
  const { siteName } = resolveCtx(ctx);
  const { date, entries, comment, indexStatus, sitemap } = snapshot;
  const inTop10 = entries.filter(e => e.position !== null && e.position <= 10).length;
  const inTop30 = entries.filter(e => e.position !== null && e.position <= 30).length;
  const outOfTop = entries.filter(e => e.position === null).length;

  const sections = [];
  sections.push(`📍 <b>Position snapshot — ${escapeHtml(siteName)}</b>\n<i>${date}${comment ? ` — ${escapeHtml(comment)}` : ''}</i>`);
  sections.push([
    `🔑 <b>Keywords:</b> ${entries.length}`,
    `🏆 <b>TOP-10:</b> ${inTop10}`,
    `📊 <b>TOP-30:</b> ${inTop30}`,
    `N/A: <b>${outOfTop}</b>`,
  ].join('\n'));

  const indexBlock = indexationSection(indexStatus, sitemap);
  if (indexBlock) sections.push(indexBlock);

  sections.push(`<i>${escapeHtml(siteName)} SEO tracker</i>`);
  return sections.join('\n\n');
}

export async function sendTelegramReport(reportOrSnapshot, type = 'report', ctx = {}) {
  const token = requireEnv('TELEGRAM_BOT_TOKEN', 'Bot token from @BotFather (123456:ABC-...)');
  const chatId = requireEnv('TELEGRAM_CHAT_ID', 'Chat or channel ID (negative for channels: -100...)');

  const html = type === 'report'
    ? formatReport(reportOrSnapshot, ctx)
    : formatSnapshot(reportOrSnapshot, ctx);

  const parts = splitForTelegram(html);
  for (const part of parts) {
    await sendMessage(token, chatId, part);
  }
  console.log(`   Sent to Telegram${parts.length > 1 ? ` (${parts.length} parts)` : ''}`);
}

// Test mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--test')) {
    const token = requireEnv('TELEGRAM_BOT_TOKEN');
    const chatId = requireEnv('TELEGRAM_CHAT_ID');
    const siteName = getSiteName();
    const html = [
      `🧪 <b>SEO tracker test — ${escapeHtml(siteName)}</b>`,
      'Bot is working. Reports will be sent here.',
      `<i>${escapeHtml(siteName)} SEO tracker</i>`,
    ].join('\n\n');
    await sendMessage(token, chatId, html);
    console.log('Test message sent to Telegram!');
  } else {
    console.log('Usage: node scripts/notify-telegram.mjs --test');
  }
}
