# STATUS — Phase 2 канарейка активна

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
