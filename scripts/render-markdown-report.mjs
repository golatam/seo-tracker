/**
 * Render a report model as a full weekly Markdown report.
 *
 * Pure function: takes a model from report-model.mjs and returns a
 * Markdown string. weekly-check.mjs writes it to
 * snapshots/reports/YYYY-MM-DD-weekly.md.
 *
 * Usage (standalone, against existing snapshots):
 *   node scripts/render-markdown-report.mjs [--from=DATE] [--to=DATE]
 */

function fmtPos(p) {
  return p == null ? 'OUT' : String(p);
}

function fmtMove(c) {
  if (c.previousPosition == null && c.currentPosition != null) return `NEW → ${c.currentPosition}`;
  if (c.previousPosition != null && c.currentPosition == null) return `${c.previousPosition} → OUT`;
  const sign = c.change > 0 ? `+${c.change}` : `${c.change}`;
  return `${fmtPos(c.previousPosition)} → ${fmtPos(c.currentPosition)} (${sign})`;
}

function signed(n) {
  if (n > 0) return `+${n}`;
  return `${n}`;
}

function distRow(label, prevV, curV, deltaV) {
  return `| ${label} | ${prevV} | ${curV} | ${signed(deltaV)} |`;
}

export function renderMarkdownReport(model, ctx = {}) {
  const site = ctx.siteName || model.site || 'site';
  const { summary, distribution, alerts, winners, losers, clusters, pages, verdict, nextActions, dimensions } = model;
  const L = [];

  L.push(`# SEO Weekly Report — ${site}`);
  L.push('');
  L.push(`Period: ${model.previousDate || '—'} → ${model.currentDate}`);
  L.push(`Source: ${model.source}`);
  const dims = [];
  if (dimensions.engines.length) dims.push(dimensions.engines.join('/'));
  if (dimensions.regions.length) dims.push(`regions: ${dimensions.regions.join(', ')}`);
  if (dimensions.devices.length) dims.push(dimensions.devices.join('/'));
  if (dims.length) L.push(`Dimensions: ${dims.join(' · ')}`);
  L.push('');

  // 1. Executive summary
  L.push('## 1. Executive summary');
  L.push('');
  L.push(`- **Verdict:** ${verdict.emoji} ${verdict.level} — ${verdict.text}`);
  L.push(`- **Keywords:** ${summary.keywords} · **Visibility:** ${summary.prevVisibilityScore} → ${summary.visibilityScore} (${signed(summary.visibilityDelta)}%)`);
  L.push(`- **Movement:** ${summary.improved} improved · ${summary.declined} declined · ${summary.unchanged} unchanged`);
  if (summary.newlyTracked > 0) L.push(`- **Newly tracked:** ${summary.newlyTracked}`);
  L.push('');
  L.push('**This week:**');
  for (const a of nextActions) L.push(`- ${a}`);
  L.push('');

  // 2. Visibility distribution
  L.push('## 2. Visibility distribution');
  L.push('');
  L.push('| Bucket | Previous | Current | Δ WoW |');
  L.push('|--------|---------:|--------:|------:|');
  L.push(distRow('TOP-3', distribution.previous.top3, distribution.current.top3, distribution.delta.top3));
  L.push(distRow('TOP-10', distribution.previous.top10, distribution.current.top10, distribution.delta.top10));
  L.push(distRow('TOP-30', distribution.previous.top30, distribution.current.top30, distribution.delta.top30));
  L.push(distRow('TOP-100', distribution.previous.top100, distribution.current.top100, distribution.delta.top100));
  L.push(distRow('OUT', distribution.previous.out, distribution.current.out, distribution.delta.out));
  L.push('');

  // 3. Priority alerts
  L.push('## 3. Priority alerts');
  L.push('');
  if (alerts.length === 0) {
    L.push('_None._');
  } else {
    for (const a of alerts) {
      const sev = a.severity === 'high' ? '🔴' : '🟠';
      L.push(`- ${sev} **${a.priority}** · "${a.keyword}" — ${fmtMove(a)} · ${a.reason}${a.url ? ` · ${a.url}` : ''}`);
    }
  }
  L.push('');

  // 4. Cluster performance
  L.push('## 4. Cluster performance');
  L.push('');
  L.push('| Cluster | Keywords | TOP-10 | Avg | Visibility | Δ Vis |');
  L.push('|---------|---------:|-------:|----:|-----------:|------:|');
  for (const c of clusters) {
    const label = `${c.emoji ? c.emoji + ' ' : ''}${c.label}`;
    L.push(`| ${label} | ${c.keywords} | ${c.top10} | ${c.avgPosition || '—'} | ${c.visibilityScore} | ${signed(c.visibilityDelta)} |`);
  }
  L.push('');

  // 5. Landing page impact
  L.push('## 5. Landing page impact');
  L.push('');
  const impactPages = pages.filter((p) => p.lostTop10 > 0 || p.gainedTop10 > 0 || p.lostKeywords > 0).slice(0, 20);
  if (impactPages.length === 0) {
    L.push('_No notable page-level changes._');
  } else {
    L.push('| Page | Keywords | TOP-10 | Lost TOP-10 | Gained TOP-10 | Action |');
    L.push('|------|---------:|-------:|------------:|--------------:|--------|');
    for (const p of impactPages) {
      L.push(`| ${p.url} | ${p.keywords} | ${p.top10} | ${p.lostTop10} | ${p.gainedTop10} | ${p.action || ''} |`);
    }
  }
  L.push('');

  // 6. Winners / losers
  L.push('## 6. Winners / losers');
  L.push('');
  L.push('**Top improvements:**');
  if (winners.length === 0) L.push('- _None._');
  for (const w of winners) L.push(`- 🟢 "${w.keyword}" ${fmtMove(w)}${w.url ? ` · ${w.url}` : ''}`);
  L.push('');
  L.push('**Top declines:**');
  if (losers.length === 0) L.push('- _None._');
  for (const w of losers) L.push(`- 🔻 "${w.keyword}" ${fmtMove(w)}${w.url ? ` · ${w.url}` : ''}`);
  L.push('');

  // 7. Indexation / technical appendix
  L.push('## 7. Indexation / technical appendix');
  L.push('');
  const idx = model.indexStatus || [];
  if (idx.length > 0) {
    const total = idx.length;
    const indexed = idx.filter((s) => s.verdict === 'PASS').length;
    const neutral = idx.filter((s) => s.verdict === 'NEUTRAL').length;
    const failed = idx.filter((s) => s.verdict === 'FAIL' || s.verdict === 'PARTIAL').length;
    const unknown = idx.filter((s) => s.coverageState === 'URL is unknown to Google').length;
    L.push(`- Indexed: ${indexed}/${total} · awaiting crawl: ${neutral} · failed: ${failed}${unknown ? ` · unknown to Google: ${unknown}` : ''}`);
  } else {
    L.push('- No URL Inspection data.');
  }
  if (model.sitemap) {
    const s = model.sitemap;
    if (s.submitted) L.push(`- Sitemap: just submitted (${s.url || ''})`);
    else if (s.alreadyRegistered) L.push(`- Sitemap: registered — ${s.errors} errors, ${s.warnings} warnings`);
    else if (s.scopeError) L.push('- Sitemap: not registered (OAuth write scope missing) — submit manually in GSC.');
    else if (s.submitError) L.push(`- Sitemap: submit failed — ${s.submitError}`);
  }
  L.push('');

  // 8. Raw appendix
  L.push('## 8. Raw appendix');
  L.push('');
  if (model.raw.snapshotPath) L.push(`- JSON snapshot: \`${model.raw.snapshotPath}\``);
  if (model.raw.csvPath) L.push(`- CSV export: \`${model.raw.csvPath}\``);
  L.push('');
  L.push(`_Generated by ${site} SEO tracker._`);
  L.push('');

  return L.join('\n');
}

// ─── Standalone ──────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { getCorePath, getSnapshotsDir, loadClusters, getSiteName } = await import('../config.mjs');
  const { buildReportModel } = await import('./report-model.mjs');

  const args = process.argv.slice(2);
  const fromDate = args.find((a) => a.startsWith('--from='))?.split('=')[1];
  const toDate = args.find((a) => a.startsWith('--to='))?.split('=')[1];

  const dir = getSnapshotsDir();
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length < 2) {
    console.error('Need at least two snapshots.');
    process.exit(1);
  }
  const currFile = toDate ? `${toDate}.json` : files[files.length - 1];
  const before = files.filter((f) => f < currFile);
  const prevFile = fromDate ? `${fromDate}.json` : before[before.length - 1];

  const load = (f) => JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
  let core;
  try { core = JSON.parse(readFileSync(getCorePath(), 'utf-8')); } catch { core = { pages: [] }; }

  const model = buildReportModel(load(prevFile), load(currFile), core, {
    clusters: loadClusters(core),
    site: getSiteName(),
  });
  console.log(renderMarkdownReport(model, { siteName: getSiteName() }));
}
