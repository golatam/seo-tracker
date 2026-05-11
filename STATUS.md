# STATUS — Фаза 1 канарейка активна

**Зафиксировано**: 2026-05-11
**Следующий cron firmar**: 2026-05-18 ~12:00 UTC
**Пользователь вернётся**: 2026-05-20 — к этому моменту первый weekly run каноники уже отстреляется

---

## Что сделано в последней сессии (2026-05-11)

1. **Создан приватный репо** `golatam/seo-tracker` (https://github.com/golatam/seo-tracker), запушен `main`.
2. **`access_level=user`** выставлен на репо (user account, не org — опция «accessible from org repos» в UI недоступна). Команда: `gh api -X PUT /repos/golatam/seo-tracker/actions/permissions/access -f access_level=user`.
3. **`firmar/seo-tracking/semantic-core.json`** получил поле `clusters` (5 ключей: `core/feature/usecase/competitor/unknown` с испанскими лейблами `Firma PDF/Funciones/Casos de uso/Alternativas/Otro`). Smoke-test `loadClusters()` пакета прошёл идентично прежнему хардкоду.
4. **`firmar/.github/workflows/seo-weekly.yml`** заменён на caller-yaml, использующий `golatam/seo-tracker/.github/workflows/weekly-check.yml@main` с `package_ref: main`. Это канареечный ref — после Фазы 2 перейдём на `@v1`.

**Финальные коммиты**:
- `seo-tracker`: `6df22a0` (docs: Phase 1 progress + user-account constraints)
- `golatam/firmalo`: `e315329` (seo: migrate to golatam/seo-tracker reusable workflow), поверх `676192d` (today's snapshot SEO Bot)

---

## Что должно произойти автоматически 2026-05-18

1. **12:00 UTC** — cron в `golatam/firmalo` запустит caller-yaml.
2. Caller дёрнет reusable workflow из `seo-tracker@main`, checkout'ит scripts/ в `.seo-tracker/`, запустит `weekly-check.mjs`.
3. Скрипт читает `seo-tracking/semantic-core.json` (с `clusters`), фетчит GSC, пишет `seo-tracking/snapshots/2026-05-18.json`, шлёт Slack-репорт.
4. SEO Bot коммитит снапшот в `main` firmar.

---

## Первые команды при возвращении 2026-05-20

```bash
# 1. Прошёл ли cron run?
gh run list -R golatam/firmalo --workflow seo-weekly.yml --limit 3

# 2. Снапшот появился?
git -C /Volumes/Kirill_HDD/_CLAUDE/firmar pull
ls -la /Volumes/Kirill_HDD/_CLAUDE/firmar/seo-tracking/snapshots/2026-05-18.json

# 3. Структура snapshot'а не сломана (сравнить top-level ключи)?
diff <(jq 'keys' /Volumes/Kirill_HDD/_CLAUDE/firmar/seo-tracking/snapshots/2026-05-11.json) \
     <(jq 'keys' /Volumes/Kirill_HDD/_CLAUDE/firmar/seo-tracking/snapshots/2026-05-18.json)
```

---

## Критерии успеха канарейки

- `gh run list` показывает `status=completed`, `conclusion=success` для понедельничного run.
- `snapshots/2026-05-18.json` существует, top-level структура совпадает с `2026-05-11.json` (ключи `date/pages/indexStatus/sitemap/...`).
- Slack-репорт получен в обычном канале.
- В Slack секция «By cluster» содержит **испанские лейблы** Firma PDF / Funciones / Casos de uso / Alternativas — это подтверждает, что пакет прочитал `core.clusters` из `semantic-core.json` правильно.

---

## Если канарейка прошла — следующий шаг (Фаза 2)

Решение: запускать Фазу 2 сразу после **одного** успешного run, или подождать второй (2026-05-25)? CLAUDE.md рекомендует «1-2 недели». Менее рискованно — после двух.

**Чек-лист Фазы 2** (миграция golatam):

1. Добавить `clusters` в `/Volumes/Kirill_HDD/_CLAUDE/golatam/seo-tracking/semantic-core.json`. Ключи (из CLAUDE.md): `country/blog/service/audience/brand/main/landing`. Достать прежние лейблы/эмодзи из `golatam/seo-tracking/scripts/notify-telegram.mjs` и `notify-slack.mjs` (если есть).
2. Положить в GitHub Secrets `golatam/golatam-website`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (опционально `TELEGRAM_THREAD_ID`). У вас локально есть, перенести.
3. Создать `golatam/.github/workflows/seo-weekly.yml.disabled` — caller-yaml с `notifier: both`, `enable_yandex: true`, путями к `seo-tracking/...`.
4. Атомарный коммит в golatam: удалить старый workflow, переименовать `.disabled` → `.yml`, push.
5. Если ещё через 1-2 недели всё ОК — Фаза 3: тэг `v1.0.0` в seo-tracker, переключить ref'ы `@main` → `@v1` в обоих caller-yaml.
6. Удалить `seo-tracking/scripts/` и `config.mjs` в обоих репо.

---

## Если канарейка провалилась — rollback

Скрипты в `firmar/seo-tracking/scripts/` и `config.mjs` **не удалены** намеренно — это safety net.

```bash
# Откатить миграцию: вернуться к standalone workflow
git -C /Volumes/Kirill_HDD/_CLAUDE/firmar revert e315329
git -C /Volumes/Kirill_HDD/_CLAUDE/firmar push

# Разобраться в причине
gh run list -R golatam/firmalo --workflow seo-weekly.yml --limit 1
gh run view <RUN_ID> -R golatam/firmalo --log
```

После revert старый workflow снова активен; снапшоты продолжат идти как прежде, пока чините пакет в `seo-tracker`.

---

## Источники правды

- **Этот файл** — конкретный чек-лист для текущей фазы. Удалить, когда Фаза 1 закроется.
- **`CLAUDE.md`** — долгоживущий плейбук: архитектурные решения, что НЕ делать, описание модулей.
- **`MEMORY.md`** (auto-loaded) — кросс-сессионные решения.
- **`git log` в обоих репо** — авторитативная история действий.
