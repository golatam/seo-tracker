# STATUS

## Сейчас (2026-06-29): standalone Topvisor-сервис

Направление сменилось с «reusable workflow в каждом consumer» на **central
monitoring service** (решение 2026-06-29, см. CLAUDE.md «Текущее направление» и
`docs/architecture/2026-06-29-standalone-topvisor-service.md`).

**Готово:**
- `scripts/project-registry.mjs` — загрузка/валидация/нормализация дескрипторов,
  отказ при секрет-подобных ключах, статусы проекта.
- `scripts/check-project.mjs` — runner (`<id>` / `--all` / `--dry-run` /
  `--validate-only`); инъекция per-project env, graceful skip без semantic-core.
- `scripts/weekly-check.mjs` — `main(options)` экспортируется; Topvisor как
  rank source; CLI-guard оставлен для legacy/workflow-пути.
- `projects/golatam.json` (`status: waiting_for_keywords`), `data/README.md`.
- Topvisor read-only provider (`scripts/providers/topvisor.mjs`) — без `checker/go`.
- README / CLAUDE / STATUS / .env.example переписаны под standalone (2026-06-29).

**Готово 2026-06-30:**
- `data/golatam/semantic-core.json` перенесён из актуального `golatam-website/seo-tracking/semantic-core.json`.
- Topvisor credentials сохранены локально в `.env` (`0600`, файл игнорируется Git; значения не логировать).
- Локальная валидация проходит: `check-project.mjs --validate-only golatam`.
- Topvisor project `29486769` настроен: 222 ключа, Google+Yandex, Москва desktop,
  region indexes `1,2`; первичная проверка позиций запущена через `checker/go`.
- `projects/golatam.json` переведён в `status: active`, `enableYandex: true`, `topvisorRegions: "1,2"`.

**Осталось:**
- Дождаться 1-2 cron-прогонов и при необходимости добавить другие LATAM-регионы отдельным решением, чтобы не раздувать стоимость проверок.
- Зарегистрировать firmalo дескриптором; решить судьбу legacy reusable workflow.
- Развести multi-project секреты/роутинг (один `.env` = один аккаунт/бот; см.
  caveat в README и architecture-доке).

---

## История миграции (legacy reusable-workflow канарейка)

> Контекст «как сюда пришли». Reusable workflow остаётся compatibility-слоем для
> firmalo/golatam; новые проекты идут через реестр.

**Зафиксировано**: 2026-05-25 (Phase 2 миграция golatam запущена)

## История

| Дата | Событие | Run |
|------|---------|-----|
| 2026-05-11 | Phase 0 закрыта (пакет параметризован), Phase 1 стартовала (firmalo caller-yaml) | — |
| 2026-05-18 | **Incident**: cron firmalo упал в 0с — public→private cross-repo не работает для user account | `26043241272` (failure) |
| 2026-05-20 | seo-tracker флипнут в public; manual rerun firmalo — успех; Telegram smoke-test на golatam | `26152761423` (success) |
| 2026-05-25 | Phase 2 commit в golatam-website; manual rerun + автоматический cron на обоих consumer'ах | `26391024482`, `26400711150`, `26406454931` (все success) |
| 2026-05-26 | Миграция уведомлений в новую Telegram-группу `-1003789842509`. Firmalo переключён со Slack на Telegram. Per-consumer треды: GoLatam=58, Firmalo=508 | `26454599987`, `26454611946` (оба success, доставку подтвердил пользователь) |

## Текущее состояние

**Phase 1 (firmalo)** — канарейка закрыта 2026-05-25 (первый автоматический cron `26406454931`). Notifier переключён на Telegram 2026-05-26.

**Phase 2 (golatam-website)** — миграция закоммичена sha `4ecc474`, первый автоматический cron прошёл 2026-05-25. Уведомления переехали в новую Telegram-группу 2026-05-26. Следующий автоматический cron — понедельник 2026-06-01 09:00 UTC.

## Что осталось до Phase 3 (релиз v1.0.0)

1. **Дождаться 1-2 успешных автоматических cron-прогонов** на обоих consumer'ах:
   - firmalo: 2026-06-01, 2026-06-08
   - golatam: 2026-06-01, 2026-06-08
2. **Удалить rollback safety nets**:
   - `golatam/firmalo/seo-tracking/scripts/` + `config.mjs`
   - `golatam/golatam-website/seo-tracking/scripts/` + `config.mjs` + `types.ts` (но НЕ `import-keywords.mjs`, `import-positions.mjs`, `templates/`, `uslugi-traffic-baseline.json` — они вне weekly pipeline)
3. **Тэг `v1.0.0`** в `seo-tracker`, обновить оба caller-yaml: `@main` → `@v1`, `package_ref: main` → `package_ref: v1`

## Первые команды при возвращении

```bash
# Прогоны прошли?
gh run list -R golatam/firmalo --workflow seo-weekly.yml --limit 3
gh run list -R golatam/golatam-website --workflow seo-weekly.yml --limit 3

# Свежие snapshot'ы появились?
git -C /Volumes/Kirill_HDD/_CLAUDE/firmar pull && ls /Volumes/Kirill_HDD/_CLAUDE/firmar/seo-tracking/snapshots/ | tail -3
git -C /Volumes/Kirill_HDD/_CLAUDE/golatam pull && ls /Volumes/Kirill_HDD/_CLAUDE/golatam/seo-tracking/snapshots/ | tail -3
```

## Источники правды

- **Этот файл** — чек-лист до v1.0.0. Удалить или переписать после Phase 3.
- **`CLAUDE.md`** — долгоживущий плейбук: архитектурные решения, описание модулей.
- **`MEMORY.md`** (auto-loaded) — кросс-сессионные решения.
