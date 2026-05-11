#!/usr/bin/env node
/**
 * Отправка SEO-отчёта в Telegram
 *
 * Форматирует отчёт по позициям и отправляет через Telegram Bot API.
 * Поддерживает MarkdownV2 с кластерами, стрелками и эмодзи.
 *
 * Usage:
 *   node seo-tracking/scripts/notify-telegram.mjs [--test]
 *
 * Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID (опционально, для топиков группы)
 */

import { loadEnv, requireEnv } from './env.mjs';
import { NOISE_THRESHOLD } from '../config.mjs';

loadEnv();

const TG_API = 'https://api.telegram.org';

// ─── Cluster labels (Telegram-safe, no special chars) ────────────────

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
  country: '🌎',
  blog: '📝',
  service: '🔧',
  audience: '👥',
  brand: '🏷',
  main: '🏠',
  landing: '📄',
  unknown: '❓',
};

const CLUSTER_ORDER = ['brand', 'main', 'country', 'service', 'audience', 'blog', 'landing', 'unknown'];

// ─── Telegram helpers ────────────────────────────────────────────────

/** Escape special chars for MarkdownV2 */
function esc(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

async function sendMessage(token, chatId, text, parseMode = 'MarkdownV2') {
  const url = `${TG_API}/bot${token}/sendMessage`;
  const threadId = process.env.TELEGRAM_THREAD_ID;

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
  };

  if (threadId) {
    payload.message_thread_id = parseInt(threadId);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Telegram API error: ${res.status}\n` +
      `${err.description || JSON.stringify(err)}\n` +
      `Message was: ${text.slice(0, 200)}...`
    );
  }

  return res.json();
}

// ─── Format report for Telegram ──────────────────────────────────────

/**
 * Форматирует отчёт по позициям в Telegram-сообщение с кластерами.
 * @param {object} report — объект PositionReport
 */
export function formatReport(report) {
  const { summary, changes, currentDate, previousDate } = report;

  const lines = [];

  // Header
  lines.push(`*📊 SEO\\-отчёт: golatam\\.group*`);
  lines.push(`${esc(previousDate)} → ${esc(currentDate)}`);
  lines.push('');

  // Summary
  const avgChange = summary.avgPosition - summary.prevAvgPosition;
  const avgDir = avgChange < 0 ? `⬆️ ${esc(Math.abs(avgChange).toFixed(1))}` : avgChange > 0 ? `⬇️ ${esc(avgChange.toFixed(1))}` : '➡️ 0';

  lines.push(`*Сводка:*`);
  lines.push(`🔑 Ключей: ${esc(summary.totalKeywords)}`);
  lines.push(`✅ Улучшились: ${esc(summary.improved)}`);
  lines.push(`❌ Ухудшились: ${esc(summary.declined)}`);
  lines.push(`➡️ Без изменений: ${esc(summary.unchanged)}`);
  if (summary.noData > 0) lines.push(`∅ N/A: ${esc(summary.noData)}`);
  if (summary.newInTop > 0) lines.push(`🆕 Вошли в ТОП: ${esc(summary.newInTop)}`);
  if (summary.newlyTracked > 0) lines.push(`⊕ Новые в отслеживании: ${esc(summary.newlyTracked)}`);
  if (summary.droppedFromTop > 0) lines.push(`💀 Вышли из ТОП: ${esc(summary.droppedFromTop)}`);
  lines.push(`📍 Средняя: ${esc(summary.prevAvgPosition)} → ${esc(summary.avgPosition)} \\(${avgDir}\\)`);
  lines.push('');

  // Alerts — critical drops (exclude newly tracked)
  const alerts = changes.filter(c =>
    !c.isNewlyTracked && (
      (c.previousPosition !== null && c.currentPosition === null) ||
      (c.change !== null && c.change < -5)
    )
  );

  if (alerts.length > 0) {
    lines.push(`*⚠️ Алерты:*`);
    for (const a of alerts.slice(0, 10)) {
      const pos = formatPositionChange(a);
      lines.push(`🔴 «${esc(a.keyword)}» ${pos}`);
    }
    lines.push('');
  }

  // Cluster summary
  const byCluster = {};
  for (const c of changes) {
    const cat = c.category || 'unknown';
    if (!byCluster[cat]) byCluster[cat] = [];
    byCluster[cat].push(c);
  }

  // Show cluster-level summaries
  const clusterSummaryLines = [];
  for (const cat of CLUSTER_ORDER) {
    const clusterChanges = byCluster[cat];
    if (!clusterChanges || clusterChanges.length === 0) continue;
    const emoji = CLUSTER_EMOJI[cat] || '❓';
    const label = CLUSTER_LABELS[cat] || cat;
    const imp = clusterChanges.filter(c => c.change !== null && c.change > 0).length;
    const dec = clusterChanges.filter(c => c.change !== null && c.change < 0).length;
    clusterSummaryLines.push(`${emoji} ${esc(label)}: ▲${esc(imp)} ▼${esc(dec)} \\(${esc(clusterChanges.length)}\\)`);
  }

  if (clusterSummaryLines.length > 0) {
    lines.push(`*По кластерам:*`);
    lines.push(...clusterSummaryLines);
    lines.push('');
  }

  // Top improvements by cluster (skip noise)
  const improved = changes
    .filter(c => c.change !== null && c.change > NOISE_THRESHOLD && !c.isNewlyTracked)
    .sort((a, b) => b.change - a.change)
    .slice(0, 10);

  if (improved.length > 0) {
    lines.push(`*📈 Лучшие улучшения:*`);
    for (const c of improved) {
      const pos = formatPositionChange(c);
      const clEmoji = CLUSTER_EMOJI[c.category] || '';
      lines.push(`${clEmoji}🟢 «${esc(c.keyword)}» ${pos}`);
    }
    lines.push('');
  }

  // Top declines by cluster (skip noise)
  const declined = changes
    .filter(c => c.change !== null && c.change < -NOISE_THRESHOLD && !c.isNewlyTracked)
    .sort((a, b) => a.change - b.change)
    .slice(0, 10);

  if (declined.length > 0) {
    lines.push(`*📉 Заметные падения:*`);
    for (const c of declined) {
      const pos = formatPositionChange(c);
      const clEmoji = CLUSTER_EMOJI[c.category] || '';
      lines.push(`${clEmoji}🔻 «${esc(c.keyword)}» ${pos}`);
    }
    lines.push('');
  }

  // Footer
  lines.push(`_Автоотчёт golatam SEO tracker_`);

  return lines.join('\n');
}

function formatPositionChange(c) {
  if (c.isNewlyTracked && c.currentPosition !== null) {
    return `→ ${esc(c.currentPosition)} \\(новый\\)`;
  }
  if (c.previousPosition === null && c.currentPosition !== null) {
    return `NEW → ${esc(c.currentPosition)}`;
  }
  if (c.previousPosition !== null && c.currentPosition === null) {
    return `${esc(c.previousPosition)} → OUT`;
  }
  if (c.previousPosition === null && c.currentPosition === null) {
    return `N/A`;
  }
  const arrow = c.change > 0 ? '⬆️' : c.change < 0 ? '⬇️' : '➡️';
  const changeStr = c.change !== 0 ? ` \\(${c.change > 0 ? '\\+' : ''}${esc(c.change)}\\)` : '';
  return `${esc(c.previousPosition)} → ${esc(c.currentPosition)} ${arrow}${changeStr}`;
}

/**
 * Форматирует краткое сообщение для одного снэпшота (без сравнения).
 */
export function formatSnapshot(snapshot) {
  const { date, entries, comment } = snapshot;
  const inTop10 = entries.filter(e => e.position !== null && e.position <= 10).length;
  const inTop30 = entries.filter(e => e.position !== null && e.position <= 30).length;
  const outOfTop = entries.filter(e => e.position === null).length;

  const lines = [
    `*📍 Снэпшот позиций: ${esc(date)}*`,
    comment ? `_${esc(comment)}_` : '',
    '',
    `🔑 Ключей: ${esc(entries.length)}`,
    `🏆 В ТОП\\-10: ${esc(inTop10)}`,
    `📊 В ТОП\\-30: ${esc(inTop30)}`,
    `∅ N/A: ${esc(outOfTop)}`,
    '',
    `_Автоотчёт golatam SEO tracker_`,
  ];

  return lines.filter(Boolean).join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────

/**
 * Отправить отчёт в Telegram.
 * @param {object} reportOrSnapshot — PositionReport или PositionSnapshot
 * @param {'report'|'snapshot'} type
 */
export async function sendTelegramReport(reportOrSnapshot, type = 'report') {
  const token = requireEnv('TELEGRAM_BOT_TOKEN', 'Токен Telegram-бота от @BotFather');
  const chatId = requireEnv('TELEGRAM_CHAT_ID', 'ID чата для отправки');

  const text = type === 'report'
    ? formatReport(reportOrSnapshot)
    : formatSnapshot(reportOrSnapshot);

  await sendMessage(token, chatId, text);
  console.log('   ✅ Отчёт отправлен в Telegram');
}

// Test mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    const token = requireEnv('TELEGRAM_BOT_TOKEN');
    const chatId = requireEnv('TELEGRAM_CHAT_ID');

    const testMsg = `*🧪 Тест SEO\\-трекера*\n\nБот работает\\! Уведомления будут приходить сюда\\.\n\n_golatam SEO tracker_`;
    await sendMessage(token, chatId, testMsg);
    console.log('✅ Тестовое сообщение отправлено!');
  } else {
    console.log(`
Использование:
  node seo-tracking/scripts/notify-telegram.mjs --test

Отправит тестовое сообщение в настроенный Telegram-чат.
Убедитесь, что TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID заданы в .env
`);
  }
}
