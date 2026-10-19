# Security Policy

## Поддерживаемые версии

Актуальна только ветка `main` (патч 7.41). Старые коммиты не патчатся.

## Сообщить об уязвимости

Нашёл XSS, CSP bypass, prototype pollution, tar-slip или утечку данных через скриншот?

1. **Не открывай публичный issue** если это может навредить пользователям.
2. Напиши на `cozabretto988@gmail.com` с темой `[dota-2 security]` или открой приватный `Security Advisory` на GitHub.
3. Опиши шаги воспроизведения, версию (`data/meta.json → constantsVersion`), скрин/PoC.

Отвечу в течение 48 часов. Фикс — в `main` + отчёт в релизе, без раскрытия деталей до патча.

## Что уже защищено

- Весь `innerHTML` через `esc()`, `hasOwnProperty` для героев, `localStorage` в `try/catch`
- `extractTar` — защита от tar-slip (абсолютные пути, `../`, symlink)
- `permissions: {}` в workflow, SHA-пиннинг действий, `persist-credentials: false`
- CSP `default-src 'self'` в `index.html`
- `npm audit --audit-level=moderate` в CI + Dependabot weekly

Спасибо что помогаешь держать инструмент безопасным.
