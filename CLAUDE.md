# SEO Tracker — reusable GSC monitoring package

## Цель проекта

Вынести общий SEO-трекер, который сейчас существует в двух копиях (firmalo, golatam), в отдельный репозиторий `golatam/seo-tracker` как **reusable GitHub workflow + zero-dep Node scripts**. Новые контентные проекты GoLatam подключают трекер одной строкой `uses: golatam/seo-tracker/.github/workflows/weekly-check.yml@v1` + держат у себя только `semantic-core.json`.

## Откуда это взялось (контекст)

Трекер начался в проекте **golatam** (RU+LATAM контентный сайт, Google+Yandex, уведомления в Telegram). При запуске **firmalo** (только LATAM, только Google, уведомления в Slack) был скопирован и упрощён. В сессии 2026-04-20 firmalo-версия получила три новых модуля, которых пока нет в golatam:

- `inspect-index.mjs` — дёргает GSC URL Inspection API на каждый URL из semantic-core, сохраняет `verdict/coverageState/lastCrawlTime/googleCanonical` в `snapshot.indexStatus`
- `submit-sitemap.mjs` — идемпотентно регистрирует sitemap через GSC sitemaps.submit; корректно деградирует на 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT (текущий refresh token только с read scope)
- `indexationBlocks()` в `notify-slack.mjs` — секция «Indexation» в недельном отчёте: PASS/NEUTRAL/FAIL + «URL is unknown to Google» + статус sitemap

Эти три модуля **нужно унести в пакет целиком**, они проектно-нейтральные.

## Исходники (что лежит в reference/)

- `reference/golatam/` — полная копия `/Volumes/Kirill_HDD/_CLAUDE/golatam/seo-tracking/` на 2026-04-20 (scripts, snapshots, config, semantic-core). У golatam богаче: есть `fetch-yandex.mjs`, `notify-telegram.mjs`, `import-keywords.mjs`, `import-positions.mjs`, и в `report.mjs` есть эвристики (антиканнибализация, recovery OUT-ключей) которых у firmalo нет
- `reference/firmalo-seo-weekly.yml` — текущий workflow firmalo для справки

Рабочие копии firmalo лежат в корне: `scripts/`, `config.mjs`, `.env.example`. Это — **улучшенная версия 2026-04-20**, стартовая точка для рефакторинга.

## Архитектурные договорённости из сессии

- **Форма артефакта:** отдельный git-репо `golatam/seo-tracker` (**приватный**, см. ниже про access setting). Два слоя: (1) zero-dep Node-скрипты в `scripts/`, (2) reusable workflow `.github/workflows/weekly-check.yml` с `workflow_call + secrets: inherit`. Без npm publish — версионирование через git tag
- **Разметка проектное vs общее:**
  - **Проектное:** `semantic-core.json`, env-vars (`SITE_URL`, `SITE_PROPERTY`, `NOTIFIER=slack|telegram`, `ENABLE_YANDEX=true|false`)
  - **Общее:** всё в `scripts/`, workflow, общий `config.mjs`
- **Feature flags — только реальные, не «про запас»:** Yandex (golatam нужен, firmalo нет), notifier (slack/telegram), опциональные эвристики в report.mjs
- **Миграция `report.mjs` — в последнюю очередь и построчной диффой:** именно там голден-точка, где у golatam есть эвристики (антиканнибализация, recovery), отсутствующие в firmalo. Вариант: оставить их в пакете как опциональные (`--features=anti-cannibalization`) либо вынести в `extensions/` с hook-интерфейсом
- **«Telegram-бот» = `notify-telegram.mjs`**, никакого отдельного long-running сервиса. GitHub Action раз в неделю делает POST в Bot API `sendMessage`. Stateless, без webhook'ов, без хостинга

## Принятые решения (2026-05-11)

1. **Название репо:** `golatam/seo-tracker` — подтверждено
2. **Приватный.** Перед первым прогоном reusable workflow в consumer-репо: **Settings → Actions → General → Access → "Accessible from repositories owned by the organization"** в `seo-tracker`. Без этого consumer'ы получат ошибку «workflow not found»
3. **Миграция итеративно (вариант b):** канарейка = **firmalo первым** (проще: только Google + Slack), golatam вторым после 1-2 недель стабильной работы пакета на firmalo
4. **Telegram-токен** хранится локально у пользователя; перед миграцией golatam — положить в GitHub Secrets `golatam/golatam-website` как `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`. В secrets `seo-tracker` НЕ кладём — пакет должен быть stateless, токен пробрасывается через `secrets: inherit`
5. **README с инструкцией «как подключить к новому проекту»** — обязательная часть v1.0 (отдельный пункт плана)
6. **Strategy B — параметризовать до подключения.** Не создаём GitHub remote и не подключаем consumer'ов, пока не закрыты Tasks #1 (config), #3 (weekly-check flags), #4 (notify-telegram union), #5 (notify-slack cluster labels). Альтернатива (firmalo-canary сейчас, breaking v2.0.0 потом) явно отвергнута — пакет должен быть «настоящим» с первой минуты

## Что в этой папке сейчас

```
seo-tracker/
├── .gitignore                       # node_modules, .env, macOS resource forks
├── .github/workflows/
│   └── weekly-check.yml             # reusable workflow (workflow_call) — Task #5 done
├── CLAUDE.md                        # этот файл
├── README.md                        # caller-yaml шаблон + secrets + semantic-core пример
├── .env.example                     # GSC + Slack + Telegram + Yandex + NOTIFIER/ENABLE_YANDEX
├── config.mjs                       # constants + helpers: getSiteName/getNotifiers/loadClusters/etc
├── scripts/
│   ├── env.mjs                      # .env loader (резолвит из process.cwd())
│   ├── fetch-gsc.mjs                # searchAnalytics.query; exports getAccessToken
│   ├── fetch-yandex.mjs             # Yandex.Webmaster popular queries — Task #4 done
│   ├── inspect-index.mjs            # urlInspection.index:inspect
│   ├── submit-sitemap.mjs           # sitemaps.list + submit, handles 403 scope
│   ├── notify-slack.mjs             # Block Kit report; принимает ctx={siteName,clusters}
│   ├── notify-telegram.mjs          # HTML report со splitForTelegram; thread support
│   ├── report.mjs                   # console-инспектор: engine sub-grouping + cluster table
│   └── weekly-check.mjs             # orchestrator: NOTIFIER, ENABLE_YANDEX, ctx
└── reference/
    ├── firmalo-seo-weekly.yml       # workflow для справки
    └── golatam/                     # полная копия golatam/seo-tracking (как стоп-кадр)
```

Каталоги `snapshots/` и `semantic-core.json` в корне проекта отсутствуют осознанно — они **проектные, не принадлежат пакету**.

## Ключевые архитектурные решения (зафиксированы по итогу сессии 2026-05-11)

1. **Cluster labels хранятся в `semantic-core.json`** (опциональное поле `core.clusters`). `config.mjs::loadClusters(core)` парсит их в `{ labels, emoji, order }` и отдаёт обоим нотификаторам + `report.mjs`. Fallback: единственный «Other»-кластер. Это убрало хардкод из 3 файлов.
2. **Пути резолвятся от `process.cwd()`**, не от `__dirname` пакета. `getCorePath()`/`getSnapshotsDir()` читают `CORE_PATH`/`SNAPSHOTS_DIR` env с дефолтами в CWD. Это критично для reusable workflow: пакет чекаутится в `.seo-tracker/`, но данные лежат в корне consumer-репо. `env.mjs` тоже резолвит `.env` из CWD.
3. **Эвристик антиканнибализации/recovery в коде нет** — упоминание в раннем плане было ошибочным. Hook-интерфейс для эвристик НЕ нужен; обе версии `report.mjs` (firmalo и golatam) используют идентичную формулу alerts. Union сделан без extension-механизма.
4. **Нотификаторы принимают `ctx = { siteName, clusters }`** третьим аргументом, не лазают в `config.mjs` сами. `weekly-check.mjs` собирает ctx один раз и передаёт обоим — это держит нотификаторы чистыми.

## План работы v1.0 (актуальный, 2026-05-11)

**Фаза 0 — bootstrap пакета (✅ закрыта 2026-05-11):**
1. ✅ `git init` + `.gitignore` + первичный коммит
2. ✅ Инвентаризация диффов `scripts/` vs `reference/golatam/scripts/` (4 пары)
3. ✅ `config.mjs`: удалены unused exports; добавлены helpers `getCorePath/getSnapshotsDir/getSiteName/getNotifiers/isYandexEnabled/loadClusters`. `env.mjs` резолвит из `process.cwd()`
4. ✅ Нотификаторы (`notify-slack`, `notify-telegram`): параметризованы через `ctx = { siteName, clusters }`; убран хардкод «firmalo.io»; cluster labels — из `core.clusters`; добавлен `newlyTracked` summary line; Telegram сохраняет `TELEGRAM_THREAD_ID` support
5. ✅ `fetch-yandex.mjs` перенесён из reference с параметризацией (`SITE_URL` hostname вместо хардкода `golatam.group`)
6. ✅ `weekly-check.mjs` параметризован: `NOTIFIER` (slack/telegram/both/none), `ENABLE_YANDEX`, условные импорты, ctx для нотификаторов
7. ✅ Reusable workflow `.github/workflows/weekly-check.yml` с `workflow_call` + inputs + `secrets: inherit`
8. ✅ README с caller-yaml шаблоном, таблицей secrets, схемой semantic-core.json
9. ✅ Бонус: `report.mjs` унифицирован (engine sub-grouping, cluster summary table, priority indicator, cluster labels из core)
10. ✅ Smoke-tested: `weekly-check.mjs --dry-run` проходит и с `ENABLE_YANDEX=false`, и с `=true`

**Фаза 1 — миграция firmalo (канарейка) — следующая сессия:**
- Создать GitHub remote `golatam/seo-tracker` (приватный), включить «Accessible from repositories owned by the organization»
- Заменить `firmar/.github/workflows/seo-weekly.yml` на caller-yaml с `uses: golatam/seo-tracker/.github/workflows/weekly-check.yml@v1`
- Добавить опциональное `clusters` поле в `firmar/seo-tracking/semantic-core.json` (с теми же `core/feature/usecase/competitor` метками, что были захардкожены)
- Удалить `firmar/seo-tracking/scripts/`, оставить только `semantic-core.json` (плюс перенести `snapshots/` если они не в корне)
- Прогнать 1-2 недели, убедиться что снапшоты и Slack-репорты идентичны старым

**Фаза 2 — миграция golatam:**
- Добавить `clusters` поле в `golatam/seo-tracking/semantic-core.json` (`country/blog/service/audience/brand/main/landing`)
- Положить `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` в GitHub Secrets `golatam/golatam-website`
- Заменить caller-yaml в golatam (`notifier: both`, `enable_yandex: true`), удалить локальные scripts

**Фаза 3 — релиз:**
- Тэг `v1.0.0` в `seo-tracker`, обновить `@v1` references в обоих consumer'ах

## v1.1 — отложено

- **Визуальный дашборд (вариант A — статический HTML через GitHub Pages).** Новый `scripts/build-dashboard.mjs` агрегирует снапшоты всех проектов в один `index.html` с графиками (Chart.js через CDN, zero-dep сохраняется), публикация в `gh-pages`-ветке `seo-tracker`. Проекты пушат `snapshot.json` через `repo_dispatch` или артефакт. **Не включать в v1.0** — делаем после того, как firmalo+golatam мигрированы и стабилизированы. Вариант B (Next.js/Vercel) отвергнут: избыточно для недельного cadence и крошечного датасета, ломает zero-dep.

## Что НЕ делать

- Не копировать сюда `snapshots/` или `semantic-core.json` из firmalo — они проектные
- Не публиковать в npm registry — избыточно, git tag достаточно
- Не добавлять feature flags, которых нет ни в одном реальном проекте — только те, что уже существуют в golatam/firmalo
- Не делать «настоящего» Telegram-бота с webhook/long-polling — `notify-telegram.mjs` (POST в Bot API из GitHub Action) достаточен
- Не класть `TELEGRAM_BOT_TOKEN` в secrets `seo-tracker` — он должен жить в consumer-репо и пробрасываться через `secrets: inherit`

## Связанные проекты

- `/Volumes/Kirill_HDD/_CLAUDE/firmar/` — firmalo, production (`main` ahead of origin на 0 коммитов на 2026-04-20)
- `/Volumes/Kirill_HDD/_CLAUDE/golatam/` — golatam-website, production
