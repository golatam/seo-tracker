# SEO Position Tracking

Система отслеживания поисковых позиций сайта golatam.group в Google и Яндекс.

## Архитектура

```
semantic-core.json          ← Семантическое ядро (498 ключей, 163 tracked)
        │
        ▼
weekly-check.mjs            ← Оркестратор (cron каждый понедельник 12:00 MSK)
   ├── fetch-gsc.mjs        ← Google Search Console API (OAuth2)
   └── fetch-yandex.mjs     ← Яндекс.Вебмастер API v4
        │
        ▼
snapshots/YYYY-MM-DD.json   ← Снэпшот позиций (стабильный набор ключей)
        │
        ▼
report.mjs                  ← Сравнение двух снэпшотов → консольный отчёт
notify-telegram.mjs         ← Отчёт в Telegram (MarkdownV2)
```

## Семантическое ядро

**Файл:** `semantic-core.json`

Содержит все ключевые слова, сгруппированные по страницам сайта.

### Структура записи

```json
{
  "url": "/strana/biznes-v-brazilii/",
  "title": "Бизнес в Бразилии",
  "category": "country",
  "keywords": [
    {
      "keyword": "бизнес в бразилии",
      "engines": ["google", "yandex"],
      "priority": "high",
      "tracked": true,
      "volume": 673,
      "intent": "navigational"
    }
  ]
}
```

### Поле `tracked`

Определяет, попадает ли ключевое слово в снэпшоты и отчёты.

- `true` — активно отслеживается (163 ключей)
- `false` — хранится в ядре, но не мониторится (335 ключей)

**Критерии `tracked: true`:**
- Приоритет `high` (28 ключей)
- Появлялся хотя бы в одном снэпшоте (96 уникальных)
- Частотность `volume ≥ 10`

### Категории страниц (кластеры)

| Категория | Описание | Эмодзи |
|-----------|----------|--------|
| `brand` | Брендовые запросы (golatam, go latam) | 🏷 |
| `main` | Главная и About | 🏠 |
| `country` | Страны (21 страница) | 🌎 |
| `service` | Услуги (17 страниц) | 🔧 |
| `audience` | Аудитории (9 страниц) | 👥 |
| `blog` | Блог (44 страницы) | 📝 |
| `landing` | Лендинги | 📄 |

### Управление ядром

```bash
# Импорт из CSV (полная замена)
npm run seo:import-keywords -- <file.csv>

# Импорт с добавлением к существующему
npm run seo:import-keywords -- <file.csv> --merge
```

После импорта нужно вручную проставить `tracked: true/false` на новых ключах.

## Снэпшоты

**Директория:** `snapshots/`

Каждый снэпшот — JSON-файл с датой в названии (`2026-02-23.json`).

### Стабильный набор ключей

Снэпшот **всегда** содержит все `tracked` ключи. Если API не вернул данные по ключу после 3 попыток, он записывается с `position: null` (N/A). Это гарантирует:

- Нет ложных «Новых в отслеживании» из-за флуктуаций API
- Корректное сравнение между снэпшотами
- `isNewlyTracked` срабатывает только при реальном добавлении ключа в ядро

### Формат записи

```json
{
  "keyword": "бизнес в бразилии",
  "url": "/strana/biznes-v-brazilii/",
  "engine": "google",
  "position": 5
}
```

`position: null` означает «нет данных» (ключ вне ТОП-100 или API не вернул).

## Отчёты

### Консольный отчёт

```bash
npm run seo:report                          # Два последних снэпшота
npm run seo:report -- --engine=google       # Только Google
npm run seo:report -- --category=country    # Только страны
npm run seo:report -- --json                # JSON для автоматизации
npm run seo:report -- --from=2026-02-19 --to=2026-02-23
```

Отчёт группирует изменения по **кластерам** (категориям страниц), показывает:
- Сводку: улучшения, падения, N/A, средняя позиция
- Алерты: критические падения (> 5 позиций или выход из ТОП)
- Детализацию по кластерам с подгруппировкой по движку
- Итоговую таблицу кластеров

### Telegram-отчёт

Автоматически отправляется при еженедельной проверке. Содержит:
- Сводку с N/A-счётчиком
- Алерты (до 10)
- Сводку по кластерам (Бренд, Страны, Услуги и т.д.)
- Топ улучшений и падений с эмодзи кластера

### Фильтрация шума

`NOISE_THRESHOLD = 2` — изменения ±1–2 позиции скрыты из детализации, но учитываются в сводке.

## Сбор данных

### Google Search Console

- **Аутентификация:** OAuth2 refresh token
- **Endpoint:** `searchAnalytics/query` (dimensions: query + page)
- **Период:** последние 30 дней
- **Особенность:** API не поддерживает OR-фильтры → запрашиваем все данные, фильтруем клиент-сайд

### Яндекс.Вебмастер

- **Аутентификация:** OAuth token
- **Endpoint:** `GET /search-queries/popular`
- **Пагинация:** offset/limit=500
- **Особенность:** возвращает только запросы с достаточным числом показов. Ключи могут временно исчезать из ответа — это не значит, что позиция потеряна.

### Ретраи

Оба API-вызова делают до **3 попыток** с паузой 5 секунд между ними. Если все попытки неудачны, соответствующие ключи получают `position: null`.

## Автоматизация

### GitHub Actions

**Файл:** `.github/workflows/seo-weekly.yml`

Расписание: каждый понедельник 12:00 MSK (`cron: '0 9 * * 1'` UTC).

**Секреты (8 шт.):**
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN`
- `YANDEX_OAUTH_TOKEN`, `YANDEX_USER_ID`, `YANDEX_HOST_ID`

Workflow имеет `permissions: contents: write` для коммита снэпшотов.

### Ручной запуск

```bash
npm run seo:weekly                    # Полный цикл с Telegram
npm run seo:weekly -- --no-telegram   # Без отправки в Telegram
npm run seo:weekly -- --dry-run       # Без сохранения снэпшота
npm run seo:telegram-test             # Тест подключения бота
```

## Конфигурация

**Файл:** `config.mjs`

| Параметр | Значение | Описание |
|----------|----------|----------|
| `NOISE_THRESHOLD` | 2 | Порог шума (±N позиций) |
| `ALERT_DECLINE_THRESHOLD` | 5 | Алерт при падении ≥ N |
| `ALERT_TOP_THRESHOLD` | 50 | Алерт при выходе из ТОП-N |
| `SITE_URL` | golatam.group | Домен сайта |

## Файловая структура

```
seo-tracking/
├── config.mjs              # Конфигурация
├── types.ts                # TypeScript-интерфейсы
├── semantic-core.json      # Семантическое ядро (498 ключей)
├── snapshots/              # Снэпшоты позиций
│   ├── 2026-02-19.json
│   ├── 2026-02-21.json
│   └── 2026-02-23.json
├── scripts/
│   ├── weekly-check.mjs    # Оркестратор еженедельной проверки
│   ├── fetch-gsc.mjs       # Google Search Console API
│   ├── fetch-yandex.mjs    # Яндекс.Вебмастер API
│   ├── report.mjs          # Генерация консольного отчёта
│   ├── notify-telegram.mjs # Отправка в Telegram
│   ├── import-keywords.mjs # Импорт ядра из CSV
│   ├── import-positions.mjs# Импорт позиций из CSV
│   └── env.mjs             # Загрузка .env
├── templates/              # CSV-шаблоны
└── .env.example            # Шаблон переменных окружения
```
