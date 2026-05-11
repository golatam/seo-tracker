#!/usr/bin/env node
/**
 * Отправка SEO-отчёта в Slack (Block Kit)
 *
 * Форматирует отчёт по позициям и отправляет через Slack Web API.
 * Использует Block Kit для красивых карточек с цветными индикаторами.
 *
 * Usage:
 *   node seo-tracking/scripts/notify-slack.mjs [--test]
 *
 * Env vars: SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 */

import { loadEnv, requireEnv } from './env.mjs';
import { NOISE_THRESHOLD } from '../config.mjs';

loadEnv();

// ─── Cluster labels ─────────────────────────────────────────────────

const CLUSTER_LABELS = {
  country: 'Страны',
  blog: 'Блог',
  service: 'Услуги',
  audience: 'Аудитории',
  brand: 'Бренд',
  main: 'Главная',
  landing: 'Лендинги',
  unknown: 'Прочее',
};

const CLUSTER_EMOJI = {
  country: ':earth_americas:',
  blog: ':memo:',
  service: ':wrench:',
  audience: ':busts_in_silhouette:',
  brand: ':label:',
  main: ':house:',
  landing: ':page_facing_up:',
  unknown: ':grey_question:',
};

const CLUSTER_ORDER = ['brand', 'main', 'country', 'service', 'audience', 'blog', 'landing', 'unknown'];

// ─── Slack helpers ──────────────────────────────────────────────────

async function postMessage(token, channel, blocks, text, attachments) {
  const payload = {
    channel,
    text, // fallback for notifications
    blocks,
  };
  if (attachments) {
    payload.attachments = attachments;
  }

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
    return `→ *${c.currentPosition}* _(новый)_`;
  }
  if (c.previousPosition === null && c.currentPosition !== null) {
    return `NEW → *${c.currentPosition}*`;
  }
  if (c.previousPosition !== null && c.currentPosition === null) {
    return `${c.previousPosition} → *OUT*`;
  }
  if (c.previousPosition === null && c.currentPosition === null) {
    return `N/A`;
  }
  const arrow = c.change > 0 ? ':arrow_up:' : c.change < 0 ? ':arrow_down:' : '→';
  const sign = c.change > 0 ? `+${c.change}` : `${c.change}`;
  const changeStr = c.change !== 0 ? ` (${sign})` : '';
  return `${c.previousPosition} → *${c.currentPosition}* ${arrow}${changeStr}`;
}

// ─── Format report for Slack Block Kit ──────────────────────────────

/**
 * Форматирует PositionReport в Slack Block Kit blocks + attachments.
 * @param {object} report — PositionReport
 * @returns {{ blocks: object[], attachments: object[], text: string }}
 */
export function formatReport(report) {
  const { summary, changes, currentDate, previousDate } = report;

  const blocks = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: ':bar_chart: SEO-отчёт: golatam.group', emoji: true },
  });

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${previousDate} → ${currentDate}` }],
  });

  blocks.push({ type: 'divider' });

  // Summary — two-column fields
  const avgChange = summary.avgPosition - summary.prevAvgPosition;
  const avgDir = avgChange < 0 ? `:arrow_up: ${Math.abs(avgChange).toFixed(1)}` : avgChange > 0 ? `:arrow_down: ${avgChange.toFixed(1)}` : '→ 0';

  const summaryFields = [
    { type: 'mrkdwn', text: `:key: *Ключей:* ${summary.totalKeywords}` },
    { type: 'mrkdwn', text: `:dart: *Средняя:* ${summary.prevAvgPosition} → ${summary.avgPosition} (${avgDir})` },
    { type: 'mrkdwn', text: `:white_check_mark: Улучшились: *${summary.improved}*` },
    { type: 'mrkdwn', text: `:x: Ухудшились: *${summary.declined}*` },
    { type: 'mrkdwn', text: `:arrow_right: Без изменений: *${summary.unchanged}*` },
  ];

  if (summary.noData > 0) summaryFields.push({ type: 'mrkdwn', text: `∅ N/A: *${summary.noData}*` });
  if (summary.newInTop > 0) summaryFields.push({ type: 'mrkdwn', text: `:new: Вошли в ТОП: *${summary.newInTop}*` });
  if (summary.newlyTracked > 0) summaryFields.push({ type: 'mrkdwn', text: `:heavy_plus_sign: Новые в отслеживании: *${summary.newlyTracked}*` });
  if (summary.droppedFromTop > 0) summaryFields.push({ type: 'mrkdwn', text: `:skull: Вышли из ТОП: *${summary.droppedFromTop}*` });

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*Сводка*' },
  });

  // Slack allows max 10 fields per section
  blocks.push({ type: 'section', fields: summaryFields.slice(0, 10) });

  // Alerts — as red attachment
  const alerts = changes.filter(c =>
    !c.isNewlyTracked && (
      (c.previousPosition !== null && c.currentPosition === null) ||
      (c.change !== null && c.change < -5)
    )
  );

  const attachments = [];

  if (alerts.length > 0) {
    const alertLines = alerts.slice(0, 10).map(a =>
      `:red_circle: «${a.keyword}» ${posChangeText(a)}`
    );
    attachments.push({
      color: '#E01E5A', // red
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*:warning: Алерты*\n${alertLines.join('\n')}` },
      }],
    });
  }

  // Cluster summary
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*По кластерам*' },
  });

  const byCluster = {};
  for (const c of changes) {
    const cat = c.category || 'unknown';
    if (!byCluster[cat]) byCluster[cat] = [];
    byCluster[cat].push(c);
  }

  const clusterLines = [];
  for (const cat of CLUSTER_ORDER) {
    const clusterChanges = byCluster[cat];
    if (!clusterChanges || clusterChanges.length === 0) continue;
    const emoji = CLUSTER_EMOJI[cat] || ':grey_question:';
    const label = CLUSTER_LABELS[cat] || cat;
    const imp = clusterChanges.filter(c => c.change !== null && c.change > 0).length;
    const dec = clusterChanges.filter(c => c.change !== null && c.change < 0).length;
    clusterLines.push(`${emoji} *${label}:* ▲${imp} ▼${dec} (${clusterChanges.length})`);
  }

  if (clusterLines.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: clusterLines.join('\n') },
    });
  }

  // Top improvements — green attachment
  const improved = changes
    .filter(c => c.change !== null && c.change > NOISE_THRESHOLD && !c.isNewlyTracked)
    .sort((a, b) => b.change - a.change)
    .slice(0, 10);

  if (improved.length > 0) {
    const lines = improved.map(c => {
      const clEmoji = CLUSTER_EMOJI[c.category] || '';
      return `${clEmoji} :large_green_circle: «${c.keyword}» ${posChangeText(c)}`;
    });
    attachments.push({
      color: '#2EB67D', // green
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*:chart_with_upwards_trend: Лучшие улучшения*\n${lines.join('\n')}` },
      }],
    });
  }

  // Top declines — orange attachment
  const declined = changes
    .filter(c => c.change !== null && c.change < -NOISE_THRESHOLD && !c.isNewlyTracked)
    .sort((a, b) => a.change - b.change)
    .slice(0, 10);

  if (declined.length > 0) {
    const lines = declined.map(c => {
      const clEmoji = CLUSTER_EMOJI[c.category] || '';
      return `${clEmoji} :small_red_triangle_down: «${c.keyword}» ${posChangeText(c)}`;
    });
    attachments.push({
      color: '#ECB22E', // orange/warning
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*:chart_with_downwards_trend: Заметные падения*\n${lines.join('\n')}` },
      }],
    });
  }

  // Footer
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_Автоотчёт golatam SEO tracker_' }],
  });

  const text = `SEO-отчёт ${previousDate} → ${currentDate}: ▲${summary.improved} ▼${summary.declined} (${summary.totalKeywords} ключей)`;

  return { blocks, attachments, text };
}

/**
 * Форматирует снэпшот (без сравнения) для Slack.
 */
export function formatSnapshot(snapshot) {
  const { date, entries, comment } = snapshot;
  const inTop10 = entries.filter(e => e.position !== null && e.position <= 10).length;
  const inTop30 = entries.filter(e => e.position !== null && e.position <= 30).length;
  const outOfTop = entries.filter(e => e.position === null).length;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':round_pushpin: Снэпшот позиций', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: date + (comment ? ` — _${comment}_` : '') }],
    },
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `:key: *Ключей:* ${entries.length}` },
        { type: 'mrkdwn', text: `:trophy: *В ТОП-10:* ${inTop10}` },
        { type: 'mrkdwn', text: `:bar_chart: *В ТОП-30:* ${inTop30}` },
        { type: 'mrkdwn', text: `∅ *N/A:* ${outOfTop}` },
      ],
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Автоотчёт golatam SEO tracker_' }],
    },
  ];

  const text = `Снэпшот позиций ${date}: ${entries.length} ключей, ТОП-10: ${inTop10}, N/A: ${outOfTop}`;

  return { blocks, attachments: [], text };
}

// ─── Main ────────────────────────────────────────────────────────────

/**
 * Отправить отчёт в Slack.
 * @param {object} reportOrSnapshot — PositionReport или PositionSnapshot
 * @param {'report'|'snapshot'} type
 */
export async function sendSlackReport(reportOrSnapshot, type = 'report') {
  const token = requireEnv('SLACK_BOT_TOKEN', 'Bot User OAuth Token из Slack App (xoxb-...)');
  const channel = requireEnv('SLACK_CHANNEL_ID', 'ID канала Slack (правый клик → Copy link → последний сегмент)');

  const { blocks, attachments, text } = type === 'report'
    ? formatReport(reportOrSnapshot)
    : formatSnapshot(reportOrSnapshot);

  await postMessage(token, channel, blocks, text, attachments.length > 0 ? attachments : undefined);
  console.log('   ✅ Отчёт отправлен в Slack');
}

// Test mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    const token = requireEnv('SLACK_BOT_TOKEN');
    const channel = requireEnv('SLACK_CHANNEL_ID');

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: ':test_tube: Тест SEO-трекера', emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: 'Бот работает! Уведомления будут приходить сюда.' },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '_golatam SEO tracker_' }],
      },
    ];

    await postMessage(token, channel, blocks, 'Тест SEO-трекера — бот работает!');
    console.log('✅ Тестовое сообщение отправлено в Slack!');
  } else {
    console.log(`
Использование:
  node seo-tracking/scripts/notify-slack.mjs --test

Отправит тестовое сообщение в настроенный Slack-канал.
Убедитесь, что SLACK_BOT_TOKEN и SLACK_CHANNEL_ID заданы в .env
`);
  }
}
