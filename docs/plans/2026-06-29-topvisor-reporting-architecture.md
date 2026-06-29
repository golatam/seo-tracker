# Topvisor + Report Formats Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Перевести SEO tracker на Topvisor как основной источник позиций и заменить текущие отчеты на actionable-форматы: короткий executive digest, подробный weekly report и machine-readable snapshot.

**Architecture:** Topvisor становится read-only rank provider: tracker забирает историю позиций из Topvisor API, нормализует в общий формат, сохраняет snapshots и строит отчеты. GSC/Yandex.Webmaster остаются не источником позиций, а аналитическим/индексационным слоем. Отчеты строятся поверх нормализованной модели, а не внутри notifier-ов.

**Tech Stack:** zero-dep Node.js ESM, GitHub Actions reusable workflow, Telegram Bot API, Slack Block Kit, Topvisor API v2.

---

## Best practices для SEO-отчетов

Источники и выводы:
- Semrush: хороший SEO-отчет обычно включает executive summary, traffic summary, AI visibility, keyword rankings, conversions, backlinks; частота — weekly/monthly/quarterly по задаче.
- Практика SEO ops: отчет должен менять очередь задач, иначе это vanity dashboard.
- Для rank tracking нужны не только средние позиции, а распределение TOP-3/TOP-10/TOP-30/TOP-100, winners/losers, динамика кластеров, landing page impact и alerts.

Принципы для нашего tracker-а:
1. **Один экран = решение.** Telegram/Slack digest должен отвечать: все хорошо, что сломалось, что делать.
2. **Позиции показывать распределением, не только average.** Average position вводит в заблуждение на смеси брендовых/небрендовых и разных регионов.
3. **Группировать по intent/cluster/page.** Keyword list без кластеров плохо управляется.
4. **Разделять сигналы и шум.** Мелкие движения ±1–2 позиции не должны забивать отчет.
5. **Показывать business/action impact.** Потеря TOP-3 по high-priority ключу важнее роста с 87 на 73.
6. **Сохранять raw export.** Для анализа нужен JSON/CSV appendix, но не в чат.

---

## Новая модель отчетов

### 1. Executive Digest — Telegram/Slack, weekly

Короткий operational report для чата.

```text
📊 SEO: golatam.group — 2026-06-22 → 2026-06-29
Verdict: 🟡 watch — visibility -3.4%, 2 high-priority drops

Source: Topvisor · Google/Yandex · ES desktop · 186 keywords

Distribution:
TOP-3: 12 → 10 (-2)
TOP-10: 41 → 44 (+3)
TOP-30: 88 → 91 (+3)
TOP-100: 142 → 139 (-3)
OUT: 44 → 47 (+3)

Alerts:
🔴 high · "licencia gaming mexico" 4 → 11 · /mx/gaming-license/
🔴 high · "abrir empresa en brasil" 8 → OUT · /br/company/

Winners:
🟢 "pix payments brazil" 18 → 7 · /br/pix/
🟢 "empresa paraguay" 24 → 12 · /py/company/

Next actions:
1. Check /mx/gaming-license/ title/H1/content drift; SERP changed or page lost relevance.
2. Refresh /br/company/ intro + internal links from Brazil cluster.
3. Keep /br/pix/ unchanged; monitor next run.
```

### 2. Full Weekly Report — Markdown artifact

Сохраняется в repo artifact/path, можно потом слать ссылкой.

```text
# SEO Weekly Report — golatam.group
Period: 2026-06-22 → 2026-06-29
Source: Topvisor API

## 1. Executive summary
- Verdict
- 3–5 главных изменений
- что делать на этой неделе

## 2. Visibility distribution
- TOP-3/TOP-10/TOP-30/TOP-100/OUT
- delta WoW
- по search engine / region / device

## 3. Priority alerts
- high-priority drops
- dropped from TOP-10/TOP-30
- entered OUT
- target URL mismatch / cannibalization suspicion

## 4. Cluster performance
- cluster
- keywords
- visibility score
- TOP-10 count
- average position
- winners/losers

## 5. Landing page impact
- page URL
- tracked keywords
- TOP-10 count
- lost/gained keywords
- recommended action

## 6. Winners / losers
- top 10 improvements
- top 10 declines
- exclude noise

## 7. Indexation / technical appendix
- GSC URL Inspection summary
- sitemap status
- unknown/failed URLs

## 8. Raw appendix
- JSON snapshot path
- CSV export path
```

### 3. Machine-readable JSON snapshot

```json
{
  "date": "2026-06-29",
  "source": "topvisor",
  "site": "golatam.group",
  "period": {
    "previousDate": "2026-06-22",
    "currentDate": "2026-06-29"
  },
  "dimensions": {
    "engines": ["google", "yandex"],
    "regions": [1, 2],
    "devices": ["desktop"]
  },
  "summary": {
    "keywords": 186,
    "visibilityScore": 42.7,
    "visibilityDelta": -3.4,
    "top3": 10,
    "top10": 44,
    "top30": 91,
    "top100": 139,
    "out": 47,
    "improved": 31,
    "declined": 28,
    "unchanged": 127
  },
  "alerts": [],
  "clusters": [],
  "pages": [],
  "entries": []
}
```

---

## Метрики

### Обязательные

- `top3`, `top10`, `top30`, `top100`, `out`
- `improved`, `declined`, `unchanged`, `new`, `lost`
- `visibilityScore`
- `priorityAlerts`
- `clusterSummary`
- `pageSummary`

### Visibility score

Простая, объяснимая формула:

```js
function positionWeight(pos) {
  if (pos == null || pos > 100) return 0;
  if (pos <= 3) return 1;
  if (pos <= 10) return 0.7;
  if (pos <= 30) return 0.3;
  if (pos <= 100) return 0.1;
  return 0;
}
```

Для high-priority keywords можно добавить множитель:

```js
const priorityWeight = { high: 2, medium: 1, low: 0.5 };
```

### Alert rules

```js
const alerts = [
  'high priority keyword dropped by >= 5 positions',
  'keyword dropped from TOP-10',
  'keyword dropped from TOP-30',
  'keyword went OUT',
  'target URL changed unexpectedly',
  'cluster visibility dropped by >= 10%',
  'page lost >= 3 TOP-10 keywords'
];
```

---

## Data model changes

### RankEntry

```js
{
  keywordId: 'topvisor:123456',
  keyword: 'licencia gaming mexico',
  targetUrl: '/mx/gaming-license/',
  actualUrl: '/mx/gaming-license/',
  engine: 'google',
  regionIndex: 1,
  regionName: 'Mexico',
  device: 'desktop',
  position: 7,
  previousPosition: 11,
  source: 'topvisor',
  checkedAt: '2026-06-29',
  priority: 'high',
  cluster: 'mexico',
  page: '/mx/gaming-license/'
}
```

### Report model

```js
{
  type: 'weekly',
  formatVersion: 2,
  summary: {},
  distribution: {},
  alerts: [],
  clusters: [],
  pages: [],
  winners: [],
  losers: [],
  indexation: {},
  raw: {}
}
```

---

## Implementation tasks

### Task 1: Extract report domain model

**Objective:** Убрать расчет отчетных метрик из notifier-ов.

**Files:**
- Create: `scripts/report-model.mjs`
- Modify: `scripts/notify-telegram.mjs`
- Modify: `scripts/notify-slack.mjs`

**Steps:**
1. Создать функции:
   - `buildReportModel(previousSnapshot, currentSnapshot, core, options)`
   - `calculateDistribution(entries)`
   - `calculateVisibility(entries)`
   - `buildClusterSummary(changes, core)`
   - `buildPageSummary(changes, core)`
   - `buildAlerts(changes, options)`
2. Notifier-ы должны только форматировать готовый `reportModel`.
3. Проверить `node --check scripts/*.mjs`.

### Task 2: Add Topvisor provider

**Objective:** Забрать позиции из Topvisor API read-only.

**Files:**
- Create: `scripts/providers/topvisor.mjs`
- Modify: `.env.example`
- Modify: `.github/workflows/weekly-check.yml`

**Steps:**
1. Добавить env:
   - `RANK_SOURCE=topvisor|gsc|mixed`
   - `TOPVISOR_USER_ID`
   - `TOPVISOR_API_TOKEN`
   - `TOPVISOR_PROJECT_ID`
   - `TOPVISOR_REGIONS_INDEXES`
2. Реализовать API client:
   - `topvisorRequest(operator, service, method, payload)`
3. Использовать только read endpoints:
   - `get/positions_2/history`
   - `get/keywords_2/keywords`
   - `get/projects_2/projects` для диагностики
4. Не вызывать `edit/positions_2/checker/go` в MVP.

### Task 3: Normalize Topvisor history

**Objective:** Привести Topvisor response к `RankEntry[]`.

**Files:**
- Create: `scripts/normalize-ranks.mjs`
- Modify: `scripts/providers/topvisor.mjs`

**Steps:**
1. Ключ snapshot-а должен включать:
   - keywordId/name
   - engine
   - regionIndex
   - device
2. Поддержать `position`, `relevant_url`, `snippet` если есть.
3. Если нет позиции — писать `position: null`, не терять keyword.

### Task 4: Rework Telegram digest

**Objective:** Новый короткий executive формат.

**Files:**
- Modify: `scripts/notify-telegram.mjs`

**Steps:**
1. Добавить sections:
   - Verdict
   - Source/dimensions
   - Distribution
   - Alerts
   - Winners
   - Next actions
2. Ограничить digest до 1 Telegram message, остальное — markdown artifact/link.
3. Проверить split сохраняется для fallback.

### Task 5: Rework Slack report

**Objective:** Slack Block Kit как operational dashboard.

**Files:**
- Modify: `scripts/notify-slack.mjs`

**Steps:**
1. Header + verdict.
2. Fields для distribution.
3. Red attachment для alerts.
4. Green attachment для winners.
5. Context с source/date/provider.

### Task 6: Generate markdown report artifact

**Objective:** Полный weekly report сохранить как файл.

**Files:**
- Create: `scripts/render-markdown-report.mjs`
- Modify: `scripts/weekly-check.mjs`

**Steps:**
1. Сохранять в `snapshots/reports/YYYY-MM-DD-weekly.md`.
2. Включить sections из Full Weekly Report.
3. В GitHub Actions upload artifact или commit в consumer repo — выбрать позже.

### Task 7: Add CSV export

**Objective:** Raw appendix для ручного анализа.

**Files:**
- Create: `scripts/export-csv.mjs`

**Steps:**
1. Экспортировать keyword-level rows:
   - date, keyword, cluster, page, engine, region, device, previous, current, delta, priority, actualUrl
2. Сохранять в `snapshots/reports/YYYY-MM-DD-positions.csv`.

### Task 8: Update README

**Objective:** Объяснить новую архитектуру и setup.

**Files:**
- Modify: `README.md`

**Steps:**
1. Добавить section `Rank sources`.
2. Добавить Topvisor setup.
3. Добавить report formats.
4. Добавить migration notes from GSC/Yandex average positions.

---

## Verification

Run:

```bash
node --check config.mjs scripts/*.mjs
```

Then with fixtures/mocks:

```bash
RANK_SOURCE=topvisor node scripts/weekly-check.mjs --dry-run
node scripts/report.mjs --latest
```

Expected:
- no API secrets printed;
- snapshot source is `topvisor`;
- report includes distribution TOP-3/TOP-10/TOP-30/TOP-100/OUT;
- Telegram digest has verdict/actions;
- Slack blocks render without exceeding limits.

---

## Explicit non-goals for MVP

- Не запускать проверки Topvisor из tracker-а.
- Не auto-sync semantic-core → Topvisor.
- Не строить веб-дашборд.
- Не смешивать GSC avg position с Topvisor exact position в одной метрике average.
