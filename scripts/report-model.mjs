/**
 * Report domain model.
 *
 * Single source of truth for turning two snapshots into a normalized,
 * notifier-agnostic report. Notifiers (Slack/Telegram), the markdown
 * renderer and the CSV exporter all consume the model this module builds —
 * they only format, they never recompute metrics.
 *
 * The model intentionally keeps the legacy `summary` + `changes` shape so
 * the console `report.mjs` and the old notifier code paths keep working,
 * while adding the v2 fields the new actionable formats need
 * (distribution, visibility, verdict, nextActions, clusters, pages).
 */

import {
  NOISE_THRESHOLD,
  ALERT_DECLINE_THRESHOLD,
  ALERT_TOP_THRESHOLD,
  getSiteName,
  loadClusters,
} from '../config.mjs';

// ─── Primitives ──────────────────────────────────────────────────────

const entryKey = (e) => `${e.keyword}|${e.engine}`;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return round1(arr.reduce((a, b) => a + b, 0) / arr.length);
}

/**
 * Resolve cluster + priority for a keyword. Two-pass: first an exact
 * (url, keyword) match, then a keyword-only fallback. Mirrors the logic
 * that used to live inline in report.mjs.
 */
export function makeGetKeywordMeta(core) {
  const pages = (core && core.pages) || [];
  return function getKeywordMeta(keyword, url) {
    for (const page of pages) {
      if (page.url === url) {
        const kw = page.keywords.find((k) => k.keyword === keyword);
        if (kw) return { priority: kw.priority || 'medium', category: page.category || 'unknown' };
      }
    }
    for (const page of pages) {
      const kw = page.keywords.find((k) => k.keyword === keyword);
      if (kw) return { priority: kw.priority || 'medium', category: page.category || 'unknown' };
    }
    return { priority: 'medium', category: 'unknown' };
  };
}

/**
 * Build per-keyword change records from two snapshots.
 * Optional { engineFilter, categoryFilter } prune the result set
 * (used by report.mjs CLI). Returns unsorted changes.
 */
export function buildChanges(previousSnapshot, currentSnapshot, core, options = {}) {
  const { engineFilter, categoryFilter } = options;
  const getKeywordMeta = makeGetKeywordMeta(core);

  const prevEntries = (previousSnapshot && previousSnapshot.entries) || [];
  const currEntries = (currentSnapshot && currentSnapshot.entries) || [];

  const prevMap = new Map();
  for (const e of prevEntries) prevMap.set(entryKey(e), e);
  const currMap = new Map();
  for (const e of currEntries) currMap.set(entryKey(e), e);
  const prevKeywords = new Set(prevMap.keys());

  const allKeys = new Set([...prevMap.keys(), ...currMap.keys()]);
  const changes = [];

  for (const key of allKeys) {
    const idx = key.lastIndexOf('|');
    const keyword = key.slice(0, idx);
    const engine = key.slice(idx + 1);
    const prev = prevMap.get(key);
    const curr = currMap.get(key);
    const url = curr?.url || prev?.url || undefined;

    if (engineFilter && engine !== engineFilter) continue;

    const meta = getKeywordMeta(keyword, url);
    if (categoryFilter && meta.category !== categoryFilter) continue;

    const prevPos = prev?.position ?? null;
    const currPos = curr?.position ?? null;
    let change = null;
    if (prevPos !== null && currPos !== null) change = prevPos - currPos;

    const isNewlyTracked = !prevKeywords.has(key) && currPos !== null;

    changes.push({
      keyword,
      url,
      engine,
      previousPosition: prevPos,
      currentPosition: currPos,
      change,
      priority: meta.priority,
      category: meta.category,
      // carry through any provider-supplied dimensions for CSV / future use
      regionIndex: curr?.regionIndex ?? prev?.regionIndex,
      regionName: curr?.regionName ?? prev?.regionName,
      device: curr?.device ?? prev?.device,
      actualUrl: curr?.actualUrl ?? curr?.url ?? prev?.actualUrl,
      isNewlyTracked,
    });
  }

  return changes;
}

// ─── Distribution & visibility ───────────────────────────────────────

/** TOP-N bucket counts. Buckets are cumulative (top3 ⊆ top10 ⊆ …). */
export function calculateDistribution(entries = []) {
  const inTop = (max) => entries.filter((e) => e.position != null && e.position <= max).length;
  return {
    total: entries.length,
    top3: inTop(3),
    top10: inTop(10),
    top30: inTop(30),
    top100: inTop(100),
    out: entries.filter((e) => e.position == null || e.position > 100).length,
  };
}

/** Simple, explainable position weight (0..1). */
export function positionWeight(pos) {
  if (pos == null || pos > 100) return 0;
  if (pos <= 3) return 1;
  if (pos <= 10) return 0.7;
  if (pos <= 30) return 0.3;
  if (pos <= 100) return 0.1;
  return 0;
}

/**
 * Visibility score 0..100 = average position weight × 100.
 * Deliberately ignores priority multipliers in the headline number so it
 * stays comparable WoW; priority is surfaced via alerts instead.
 */
export function calculateVisibility(entries = []) {
  if (entries.length === 0) return 0;
  const sum = entries.reduce((a, e) => a + positionWeight(e.position), 0);
  return round1((sum / entries.length) * 100);
}

// ─── Alerts ──────────────────────────────────────────────────────────

/**
 * Keyword-level priority alerts. One alert per keyword, tagged with the
 * most relevant reason + severity. Newly-tracked keywords never alert.
 */
export function buildAlerts(changes, options = {}) {
  const declineThreshold = options.declineThreshold ?? ALERT_DECLINE_THRESHOLD;
  const topThreshold = options.topThreshold ?? ALERT_TOP_THRESHOLD;
  const alerts = [];

  for (const c of changes) {
    if (c.isNewlyTracked) continue;
    const { previousPosition: p, currentPosition: cur } = c;

    let reason = null;
    if (p !== null && cur === null) {
      reason = 'went OUT';
    } else if (p !== null && p <= 10 && (cur === null || cur > 10)) {
      reason = 'dropped from TOP-10';
    } else if (p !== null && p <= 30 && (cur === null || cur > 30)) {
      reason = 'dropped from TOP-30';
    } else if (c.change !== null && c.change < -declineThreshold) {
      reason = `dropped ${Math.abs(c.change)} positions`;
    } else if (
      p !== null && p <= topThreshold &&
      cur !== null && cur > topThreshold
    ) {
      reason = `left TOP-${topThreshold}`;
    }

    if (!reason) continue;

    const wentOut = p !== null && cur === null;
    const lostTop10 = p !== null && p <= 10 && (cur === null || cur > 10);
    const severity = c.priority === 'high' || wentOut || lostTop10 ? 'high' : 'medium';

    alerts.push({
      keyword: c.keyword,
      url: c.url,
      engine: c.engine,
      cluster: c.category,
      previousPosition: p,
      currentPosition: cur,
      change: c.change,
      priority: c.priority,
      reason,
      severity,
    });
  }

  // Most severe first, then by magnitude of drop.
  const sev = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => {
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
    return (a.change ?? -999) - (b.change ?? -999);
  });
  return alerts;
}

// ─── Winners / losers ────────────────────────────────────────────────

function decorate(c, clusters) {
  return {
    keyword: c.keyword,
    url: c.url,
    engine: c.engine,
    cluster: c.category,
    clusterLabel: clusters.labels[c.category] || c.category,
    clusterEmoji: clusters.emoji[c.category] || '',
    previousPosition: c.previousPosition,
    currentPosition: c.currentPosition,
    change: c.change,
    priority: c.priority,
  };
}

export function buildWinners(changes, clusters, { noiseThreshold = NOISE_THRESHOLD, limit = 10 } = {}) {
  return changes
    .filter((c) => c.change !== null && c.change > noiseThreshold && !c.isNewlyTracked)
    .sort((a, b) => b.change - a.change)
    .slice(0, limit)
    .map((c) => decorate(c, clusters));
}

export function buildLosers(changes, clusters, { noiseThreshold = NOISE_THRESHOLD, limit = 10 } = {}) {
  return changes
    .filter((c) => c.change !== null && c.change < -noiseThreshold && !c.isNewlyTracked)
    .sort((a, b) => a.change - b.change)
    .slice(0, limit)
    .map((c) => decorate(c, clusters));
}

// ─── Cluster summary ─────────────────────────────────────────────────

export function buildClusterSummary(changes, core, options = {}) {
  const clusters = options.clusters || loadClusters(core);
  const byCluster = {};
  for (const c of changes) {
    const cat = c.category || 'unknown';
    (byCluster[cat] ||= []).push(c);
  }

  const out = [];
  for (const cat of clusters.order) {
    const cl = byCluster[cat];
    if (!cl || cl.length === 0) continue;

    const currEntries = cl.map((c) => ({ position: c.currentPosition }));
    const prevEntries = cl.map((c) => ({ position: c.previousPosition }));
    const visibilityScore = calculateVisibility(currEntries);
    const prevVisibility = calculateVisibility(prevEntries);

    out.push({
      key: cat,
      label: clusters.labels[cat] || cat,
      emoji: clusters.emoji[cat] || '',
      keywords: cl.length,
      improved: cl.filter((c) => c.change !== null && c.change > 0).length,
      declined: cl.filter((c) => c.change !== null && c.change < 0).length,
      unchanged: cl.filter((c) => c.change === 0).length,
      noData: cl.filter((c) => c.currentPosition === null && c.previousPosition === null).length,
      top10: cl.filter((c) => c.currentPosition != null && c.currentPosition <= 10).length,
      avgPosition: avg(cl.map((c) => c.currentPosition).filter((p) => p !== null)),
      visibilityScore,
      visibilityDelta: round1(visibilityScore - prevVisibility),
    });
  }
  return out;
}

// ─── Page summary ────────────────────────────────────────────────────

export function buildPageSummary(changes, core, options = {}) {
  void core;
  const limit = options.limit ?? Infinity;
  const byPage = {};
  for (const c of changes) {
    const url = c.url || '(unknown)';
    (byPage[url] ||= []).push(c);
  }

  const pages = [];
  for (const [url, cl] of Object.entries(byPage)) {
    const top10 = cl.filter((c) => c.currentPosition != null && c.currentPosition <= 10).length;
    const prevTop10 = cl.filter((c) => c.previousPosition != null && c.previousPosition <= 10).length;
    const lostTop10 = cl.filter(
      (c) => c.previousPosition != null && c.previousPosition <= 10 &&
        (c.currentPosition == null || c.currentPosition > 10)
    ).length;
    const gainedTop10 = cl.filter(
      (c) => (c.previousPosition == null || c.previousPosition > 10) &&
        c.currentPosition != null && c.currentPosition <= 10
    ).length;
    const lostKeywords = cl.filter((c) => c.previousPosition !== null && c.currentPosition === null).length;
    const gainedKeywords = cl.filter((c) => c.isNewlyTracked).length;

    let action = '';
    if (lostTop10 >= 3) action = 'Investigate: lost 3+ TOP-10 keywords — check content/SERP changes.';
    else if (lostTop10 > 0) action = 'Review on-page content and internal links.';
    else if (gainedTop10 > 0) action = 'Keep as-is; monitor.';

    pages.push({
      url,
      keywords: cl.length,
      top10,
      prevTop10,
      lostTop10,
      gainedTop10,
      lostKeywords,
      gainedKeywords,
      avgPosition: avg(cl.map((c) => c.currentPosition).filter((p) => p !== null)),
      action,
    });
  }

  // Most impacted (lost TOP-10) first.
  pages.sort((a, b) => b.lostTop10 - a.lostTop10 || a.avgPosition - b.avgPosition);
  return limit === Infinity ? pages : pages.slice(0, limit);
}

// ─── Verdict & next actions ──────────────────────────────────────────

function buildVerdict(visibilityDelta, alerts, summary) {
  const highAlerts = alerts.filter((a) => a.severity === 'high').length;
  const reasons = [];
  if (visibilityDelta !== 0) {
    reasons.push(`visibility ${visibilityDelta > 0 ? '+' : ''}${visibilityDelta}%`);
  }
  if (highAlerts > 0) reasons.push(`${highAlerts} high-priority drop${highAlerts > 1 ? 's' : ''}`);
  if (summary.droppedFromTop > 0) reasons.push(`${summary.droppedFromTop} left TOP`);

  let level, emoji;
  if (visibilityDelta <= -10 || highAlerts >= 5) {
    level = 'critical';
    emoji = '🔴';
  } else if (visibilityDelta < 0 || alerts.length > 0) {
    level = 'watch';
    emoji = '🟡';
  } else {
    level = 'ok';
    emoji = '🟢';
  }

  const text = reasons.length > 0 ? reasons.join(', ') : 'no significant changes';
  return { level, emoji, text };
}

function buildNextActions(alerts, winners, pages) {
  const actions = [];

  for (const a of alerts.filter((x) => x.severity === 'high').slice(0, 3)) {
    const where = a.url ? ` ${a.url}` : '';
    const move = a.currentPosition === null
      ? `${a.previousPosition} → OUT`
      : `${a.previousPosition} → ${a.currentPosition}`;
    actions.push(`Check${where} — "${a.keyword}" ${move}; review title/H1/content drift or SERP change.`);
  }

  const lostPage = pages.find((p) => p.lostTop10 >= 3);
  if (lostPage && actions.length < 5) {
    actions.push(`Refresh ${lostPage.url}: lost ${lostPage.lostTop10} TOP-10 keywords — update content + internal links.`);
  }

  const topWinner = winners[0];
  if (topWinner && actions.length < 5) {
    actions.push(`Keep ${topWinner.url || `"${topWinner.keyword}"`} unchanged; monitor "${topWinner.keyword}" (${topWinner.previousPosition} → ${topWinner.currentPosition}).`);
  }

  if (actions.length === 0) {
    actions.push('No action required this week; keep monitoring.');
  }
  return actions.slice(0, 5);
}

// ─── Dimensions ──────────────────────────────────────────────────────

function deriveDimensions(entries, options) {
  const engines = [...new Set(entries.map((e) => e.engine).filter(Boolean))];
  const regions = [...new Set(entries.map((e) => e.regionIndex).filter((r) => r != null))];
  const devices = [...new Set(entries.map((e) => e.device).filter(Boolean))];
  return {
    engines: engines.length ? engines : options.engines || [],
    regions: regions.length ? regions : options.regions || [],
    devices: devices.length ? devices : options.devices || [],
  };
}

// ─── Full model ──────────────────────────────────────────────────────

/**
 * Build the complete report model from two snapshots.
 *
 * @param {object|null} previousSnapshot — { date, entries, ... } or null
 * @param {object} currentSnapshot — { date, source, entries, indexStatus, sitemap }
 * @param {object} core — semantic-core.json
 * @param {object} options — { clusters, site, source, noiseThreshold,
 *                             declineThreshold, engineFilter, categoryFilter }
 */
export function buildReportModel(previousSnapshot, currentSnapshot, core, options = {}) {
  const clusters = options.clusters || loadClusters(core);
  const noiseThreshold = options.noiseThreshold ?? NOISE_THRESHOLD;
  const declineThreshold = options.declineThreshold ?? ALERT_DECLINE_THRESHOLD;

  const prev = previousSnapshot || { entries: [] };
  const currentEntries = currentSnapshot.entries || [];
  const previousEntries = prev.entries || [];

  const changes = buildChanges(prev, currentSnapshot, core, {
    engineFilter: options.engineFilter,
    categoryFilter: options.categoryFilter,
  });

  const distPrev = calculateDistribution(previousEntries);
  const distCur = calculateDistribution(currentEntries);
  const distDelta = {
    total: distCur.total - distPrev.total,
    top3: distCur.top3 - distPrev.top3,
    top10: distCur.top10 - distPrev.top10,
    top30: distCur.top30 - distPrev.top30,
    top100: distCur.top100 - distPrev.top100,
    out: distCur.out - distPrev.out,
  };

  const visCur = calculateVisibility(currentEntries);
  const visPrev = calculateVisibility(previousEntries);
  const visibilityDelta = round1(visCur - visPrev);

  const summary = {
    keywords: changes.length,
    totalKeywords: changes.length, // legacy alias
    improved: changes.filter((c) => c.change !== null && c.change > 0).length,
    declined: changes.filter((c) => c.change !== null && c.change < 0).length,
    unchanged: changes.filter((c) => c.change === 0).length,
    noData: changes.filter((c) => c.previousPosition === null && c.currentPosition === null).length,
    newInTop: changes.filter((c) => c.previousPosition === null && c.currentPosition !== null && !c.isNewlyTracked).length,
    newlyTracked: changes.filter((c) => c.isNewlyTracked).length,
    droppedFromTop: changes.filter((c) => c.previousPosition !== null && c.currentPosition === null).length,
    avgPosition: avg(changes.map((c) => c.currentPosition).filter((p) => p !== null)),
    prevAvgPosition: avg(changes.map((c) => c.previousPosition).filter((p) => p !== null)),
    visibilityScore: visCur,
    prevVisibilityScore: visPrev,
    visibilityDelta,
    top3: distCur.top3,
    top10: distCur.top10,
    top30: distCur.top30,
    top100: distCur.top100,
    out: distCur.out,
  };
  // plan aliases
  summary.new = summary.newInTop;
  summary.lost = summary.droppedFromTop;

  const alerts = buildAlerts(changes, { declineThreshold });
  const winners = buildWinners(changes, clusters, { noiseThreshold });
  const losers = buildLosers(changes, clusters, { noiseThreshold });
  const clusterSummary = buildClusterSummary(changes, core, { clusters });
  const pages = buildPageSummary(changes, core);
  const verdict = buildVerdict(visibilityDelta, alerts, summary);
  const nextActions = buildNextActions(alerts, winners, pages);
  const dimensions = deriveDimensions(currentEntries, options);

  return {
    type: 'weekly',
    formatVersion: 2,
    site: options.site || getSiteName(),
    source: options.source || currentSnapshot.source || 'api',
    currentDate: currentSnapshot.date,
    previousDate: prev.date || null,
    dimensions,
    summary,
    distribution: { previous: distPrev, current: distCur, delta: distDelta },
    alerts,
    winners,
    losers,
    clusters: clusterSummary,
    pages,
    verdict,
    nextActions,
    // legacy / appendix
    changes,
    indexStatus: currentSnapshot.indexStatus || [],
    sitemap: currentSnapshot.sitemap || null,
    raw: {
      currentDate: currentSnapshot.date,
      previousDate: prev.date || null,
      source: options.source || currentSnapshot.source || 'api',
      snapshotPath: options.snapshotPath || null,
      csvPath: options.csvPath || null,
      markdownPath: options.markdownPath || null,
    },
  };
}
