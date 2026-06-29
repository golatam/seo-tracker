#!/usr/bin/env node
/**
 * Send SEO report to Slack (Block Kit).
 *
 * Usage:
 *   node scripts/notify-slack.mjs [--test]
 *
 * Env vars: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 */

import { loadEnv, requireEnv } from './env.mjs';
import { getSiteName, loadClusters } from '../config.mjs';

loadEnv();

function resolveCtx(ctx = {}) {
  return {
    siteName: ctx.siteName || getSiteName(),
    clusters: ctx.clusters || loadClusters(null),
  };
}

// ─── Slack helpers ──────────────────────────────────────────────────

async function postMessage(token, channel, blocks, text, attachments) {
  const payload = { channel, text, blocks };
  if (attachments) payload.attachments = attachments;

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}${data.response_metadata?.messages ? ' — ' + data.response_metadata.messages.join(', ') : ''}`);
  }
  return data;
}

// ─── Format helpers ─────────────────────────────────────────────────

function posChangeText(c) {
  if (c.isNewlyTracked && c.currentPosition !== null) {
    return `-> *${c.currentPosition}* _(new)_`;
  }
  if (c.previousPosition === null && c.currentPosition !== null) {
    return `NEW -> *${c.currentPosition}*`;
  }
  if (c.previousPosition !== null && c.currentPosition === null) {
    return `${c.previousPosition} -> *OUT*`;
  }
  if (c.previousPosition === null && c.currentPosition === null) {
    return `N/A`;
  }
  const arrow = c.change > 0 ? ':arrow_up:' : c.change < 0 ? ':arrow_down:' : '->';
  const sign = c.change > 0 ? `+${c.change}` : `${c.change}`;
  const changeStr = c.change !== 0 ? ` (${sign})` : '';
  return `${c.previousPosition} -> *${c.currentPosition}* ${arrow}${changeStr}`;
}

function indexationBlocks(indexStatus, sitemap) {
  const blocks = [];
  const hasIndex = Array.isArray(indexStatus) && indexStatus.length > 0;
  if (!hasIndex && !sitemap) return blocks;

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Indexation*' } });

  if (hasIndex) {
    const total = indexStatus.length;
    const indexed = indexStatus.filter((s) => s.verdict === 'PASS').length;
    const neutral = indexStatus.filter((s) => s.verdict === 'NEUTRAL').length;
    const failed = indexStatus.filter((s) => s.verdict === 'FAIL' || s.verdict === 'PARTIAL').length;
    const unknown = indexStatus.filter((s) => s.coverageState === 'URL is unknown to Google').length;

    const fields = [
      { type: 'mrkdwn', text: `:white_check_mark: *Indexed:* ${indexed}/${total}` },
      { type: 'mrkdwn', text: `:hourglass_flowing_sand: *Awaiting crawl:* ${neutral}` },
      { type: 'mrkdwn', text: `:x: *Failed:* ${failed}` },
    ];
    if (unknown > 0) fields.push({ type: 'mrkdwn', text: `:grey_question: *Unknown to Google:* ${unknown}` });

    blocks.push({ type: 'section', fields });
  }

  if (sitemap) {
    const lastDl = sitemap.lastDownloaded ? sitemap.lastDownloaded.split('T')[0] : 'never';
    let line;
    if (sitemap.submitted) {
      line = `:satellite: Sitemap: *just submitted* (${sitemap.url})`;
    } else if (sitemap.alreadyRegistered) {
      line = `:satellite: Sitemap: registered, last downloaded *${lastDl}* — ${sitemap.errors} errors, ${sitemap.warnings} warnings`;
    } else if (sitemap.scopeError) {
      line = `:warning: Sitemap: *not registered* — submit needs OAuth write scope, please submit manually in GSC UI`;
    } else if (sitemap.submitError) {
      line = `:warning: Sitemap: submit failed — ${sitemap.submitError}`;
    } else {
      line = `:satellite: Sitemap: status unknown`;
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: line }] });
  }

  return blocks;
}

// ─── Format report for Slack Block Kit ──────────────────────────────

function moveText(a) {
  const prev = a.previousPosition == null ? 'NEW' : a.previousPosition;
  const cur = a.currentPosition == null ? 'OUT' : a.currentPosition;
  return `${prev} -> ${cur}`;
}

function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function distField(label, prev, cur, delta) {
  const d = delta === 0 ? '' : ` (${signed(delta)})`;
  return { type: 'mrkdwn', text: `*${label}:* ${prev} -> ${cur}${d}` };
}

/**
 * Operational dashboard. Consumes a report model (formatVersion 2) from
 * report-model.mjs: header + verdict, distribution fields, alert/winner
 * attachments, next-action section, indexation appendix.
 */
export function formatReport(report, ctx = {}) {
  const { siteName } = resolveCtx(ctx);
  const site = report.site || siteName;
  const {
    summary, distribution, alerts = [], winners = [],
    verdict, nextActions = [], dimensions = {}, currentDate, previousDate,
    indexStatus, sitemap, source,
  } = report;
  const blocks = [];
  const attachments = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `:bar_chart: SEO: ${site}`, emoji: true },
  });

  if (verdict) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${verdict.emoji} *${verdict.level}* — ${verdict.text}` },
    });
  }

  const dimBits = [];
  if (dimensions.engines?.length) dimBits.push(dimensions.engines.join('/'));
  if (dimensions.regions?.length) dimBits.push(`regions ${dimensions.regions.join(',')}`);
  if (dimensions.devices?.length) dimBits.push(dimensions.devices.join('/'));
  dimBits.push(`${summary.keywords} keywords`);
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${previousDate || '—'} -> ${currentDate} · ${source || 'api'} · ${dimBits.join(' · ')}` }],
  });

  blocks.push({ type: 'divider' });

  // Distribution
  if (distribution) {
    const d = distribution;
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Distribution*' } });
    blocks.push({
      type: 'section',
      fields: [
        distField('TOP-3', d.previous.top3, d.current.top3, d.delta.top3),
        distField('TOP-10', d.previous.top10, d.current.top10, d.delta.top10),
        distField('TOP-30', d.previous.top30, d.current.top30, d.delta.top30),
        distField('TOP-100', d.previous.top100, d.current.top100, d.delta.top100),
        distField('OUT', d.previous.out, d.current.out, d.delta.out),
        { type: 'mrkdwn', text: `*Visibility:* ${summary.prevVisibilityScore} -> ${summary.visibilityScore} (${signed(summary.visibilityDelta)}%)` },
      ],
    });
  }

  for (const b of indexationBlocks(indexStatus, sitemap)) blocks.push(b);

  // Next actions
  if (nextActions.length > 0) {
    const lines = nextActions.map((a, i) => `${i + 1}. ${a}`);
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Next actions*\n${lines.join('\n')}` } });
  }

  // Alerts (red attachment)
  if (alerts.length > 0) {
    const lines = alerts.slice(0, 10).map(a => {
      const dot = a.severity === 'high' ? ':red_circle:' : ':large_orange_circle:';
      return `${dot} ${a.priority} · "${a.keyword}" ${moveText(a)}`;
    });
    attachments.push({
      color: '#E01E5A',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*:warning: Alerts*\n${lines.join('\n')}` } }],
    });
  }

  // Winners (green attachment)
  if (winners.length > 0) {
    const lines = winners.slice(0, 10).map(w =>
      `:large_green_circle: "${w.keyword}" ${moveText(w)}`
    );
    attachments.push({
      color: '#2EB67D',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*:chart_with_upwards_trend: Winners*\n${lines.join('\n')}` } }],
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_${site} SEO tracker_` }] });

  const text = `SEO ${previousDate || '—'} -> ${currentDate}: ${verdict ? verdict.level : ''} +${summary.improved} -${summary.declined} (${summary.keywords} keywords)`;

  return { blocks, attachments, text };
}

export function formatSnapshot(snapshot, ctx = {}) {
  const { siteName } = resolveCtx(ctx);
  const { date, entries, comment, indexStatus, sitemap } = snapshot;
  const inTop10 = entries.filter(e => e.position !== null && e.position <= 10).length;
  const inTop30 = entries.filter(e => e.position !== null && e.position <= 30).length;
  const outOfTop = entries.filter(e => e.position === null).length;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `:round_pushpin: Position snapshot — ${siteName}`, emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: date + (comment ? ` — _${comment}_` : '') }] },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `:key: *Keywords:* ${entries.length}` },
        { type: 'mrkdwn', text: `:trophy: *TOP-10:* ${inTop10}` },
        { type: 'mrkdwn', text: `:bar_chart: *TOP-30:* ${inTop30}` },
        { type: 'mrkdwn', text: `N/A: *${outOfTop}*` },
      ],
    },
  ];

  for (const b of indexationBlocks(indexStatus, sitemap)) blocks.push(b);

  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_${siteName} SEO tracker_` }] });

  return { blocks, attachments: [], text: `Position snapshot ${date}: ${entries.length} keywords, TOP-10: ${inTop10}` };
}

// ─── Main ────────────────────────────────────────────────────────────

export async function sendSlackReport(reportOrSnapshot, type = 'report', ctx = {}) {
  const token = requireEnv('SLACK_BOT_TOKEN', 'Bot User OAuth Token from Slack App (xoxb-...)');
  const channel = requireEnv('SLACK_CHANNEL_ID', 'Slack channel ID');

  const { blocks, attachments, text } = type === 'report'
    ? formatReport(reportOrSnapshot, ctx)
    : formatSnapshot(reportOrSnapshot, ctx);

  await postMessage(token, channel, blocks, text, attachments.length > 0 ? attachments : undefined);
  console.log('   Sent to Slack');
}

// Test mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--test')) {
    const token = requireEnv('SLACK_BOT_TOKEN');
    const channel = requireEnv('SLACK_CHANNEL_ID');
    const siteName = getSiteName();
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `:test_tube: SEO tracker test — ${siteName}`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: 'Bot is working. Reports will be sent here.' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `_${siteName} SEO tracker_` }] },
    ];
    await postMessage(token, channel, blocks, `${siteName} SEO tracker test — bot is working`);
    console.log('Test message sent to Slack!');
  } else {
    console.log('Usage: node scripts/notify-slack.mjs --test');
  }
}
