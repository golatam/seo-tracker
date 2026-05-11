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

## Что в этой папке сейчас

```
seo-tracker/
├── CLAUDE.md                        # этот файл
├── .env.example                     # GSC + Slack env (из firmalo)
├── config.mjs                       # из firmalo, только Google, Slack-only
├── scripts/
│   ├── env.mjs                      # .env loader, zero-dep
│   ├── fetch-gsc.mjs                # searchAnalytics.query; exports getAccessToken
│   ├── inspect-index.mjs            # NEW: urlInspection.index:inspect
│   ├── submit-sitemap.mjs           # NEW: sitemaps.list + submit, handles 403 scope
│   ├── notify-slack.mjs             # Block Kit report, новая секция Indexation
│   ├── report.mjs                   # снапшот-диф, нужно слить с golatam-версией
│   └── weekly-check.mjs             # orchestrator, нужен feature flag на notifier
└── reference/
    ├── firmalo-seo-weekly.yml       # workflow для справки
    └── golatam/                     # полная копия golatam/seo-tracking
        ├── scripts/ (с fetch-yandex, notify-telegram, import-*)
        ├── config.mjs  (Google+Yandex, Telegram)
        ├── semantic-core.json (RU+ES+PT, 32+ ключей)
        ├── snapshots/ (10 недельных снапшотов — видны реальные эвристики в диффах)
        └── templates/, types.ts, uslugi-traffic-baseline.json
```

Каталоги `snapshots/` и `semantic-core.json` в корне проекта отсутствуют осознанно — они **проектные, не принадлежат пакету**.

## План работы v1.0 (актуальный, 2026-05-11)

**Фаза 0 — bootstrap пакета (текущая сессия или ближайшая):**
1. `git init` + `.gitignore` + первичный коммит текущего состояния
2. Инвентаризация диффов `scripts/` vs `reference/golatam/scripts/` — построчная дифф `weekly-check.mjs`, `notify-slack.mjs` / `notify-telegram.mjs`, `report.mjs`, `fetch-gsc.mjs`. Цель — список переносов и решений по `report.mjs` эвристикам
3. Дизайн `config.mjs`: `defaults.mjs` (shared) + runtime-конфиг из env-vars
4. Параметризовать `weekly-check.mjs` — условные импорты yandex/telegram через feature flags
5. Reusable workflow `.github/workflows/weekly-check.yml` с `workflow_call` + inputs (`site_url`, `notifier`, `enable_yandex`) + `secrets: inherit`
6. **README с инструкцией «как подключить пакет к новому проекту»** — минимум: caller-yaml шаблон, список secrets, пример `semantic-core.json`

**Фаза 1 — миграция firmalo (канарейка):**
7. Заменить `firmar/.github/workflows/seo-weekly.yml` на caller-yaml с `uses: golatam/seo-tracker/.github/workflows/weekly-check.yml@v1`
8. Удалить `firmar/seo-tracking/scripts/`, оставить только `semantic-core.json`
9. Прогнать 1-2 недели, убедиться что снапшоты и Slack-репорты идентичны старым

**Фаза 2 — миграция golatam:**
10. Реализовать Yandex feature flag (если ещё не сделан в фазе 0)
11. Реализовать `notifier=telegram` ветку (если ещё не сделана)
12. Принять решение по `report.mjs` эвристикам (антиканнибализация, recovery): встроить опционально или вынести в `extensions/`
13. Положить `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` в GitHub Secrets `golatam/golatam-website`
14. Заменить caller-yaml в golatam, удалить локальные scripts

**Фаза 3 — релиз:**
15. Тэг `v1.0.0` в `seo-tracker`, обновить `@v1` references в обоих consumer'ах

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
