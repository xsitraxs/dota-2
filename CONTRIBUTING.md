# Как контрибьютить

Спасибо что хочешь улучшить драфт-помощника. Проект — чистая статика (`index.html + assets/ + data/`), без сборщика фронта.

## Быстрый старт

```bash
git clone https://github.com/xsitraxs/dota-2 && cd dota-2
npm ci --ignore-scripts
npm run lint
npm test              # движок + данные + теги + CI
npm run test:ui       # нужен python3 -m http.server
npm run test:recognize # нужен ImageMagick (convert или magick)
python3 -m http.server 8000 # открыть http://localhost:8000
```

## Где что лежит

- `assets/app.js` — интерфейс (вкладки, пикер, таймер, скриншот)
- `assets/analysis.js` — движок (чистые функции, без DOM) — тестируется в Node
- `assets/recognize.js` — dHash + цвет, автопоиск сетки
- `assets/style.css` — тема
- `data/` — собранные игровые константы (не править руками)
- `data/kb/` — ручная база знаний (планы мидов, теги, правила, тайминги) — вот это правишь
- `tools/` — сборщик и тесты
- `tools/rec_fixtures/` — реальные скриншоты драфта и `manifest.json` с правильными ответами (фикстуры теста распознавания; карточки подписывай визуально по монтажам с иконками)
- `tools/expert_scenarios.json` — экспертные сценарии для движка: драфт → ждемая угроза → предмет/контр-пик-ответ → почему это верно

## Обновить данные под новый патч

```bash
node tools/build_data.mjs          # свежие dotaconstants + иконки → data/
node tools/build_data.mjs --cached # из tools/.cache без сети
node tools/build_templates.mjs     # если менялись иконки — подписи для распознавания
npm run lint && npm test && npm run test:recognize && npm run test:ui && npm run test:browser
                                      # все проверки обязаны быть зелёными до PR
```

Свежесть данных в любой момент проверяет `node tools/check_data_updates.mjs` — сверяет `constantsVersion` с источником odota/dotaconstants и лишь сообщает (коды: 0 актуально / 3 есть обновление / 1 ошибка). В CI то же делает workflow `data-watch.yml`: открывает issue с уведомлением, но **никогда не публикует данные автоматически** — обновление только вручную, с прогоном всех тестов. Сборщик валидирует `data/kb/*.json`: каждый герой/способность/предмет/тег должен существовать, в текстах планов не должно быть старых названий (`Force of Nature → Nature's Call`).

## Правила

- Не добавляй винрейты/телеметрию — инструмент офлайн
- `data/*.json` не редактируй вручную — только через сборщик
- `README` цифры (127 героев, 36 планов, 400 КБ бюджет) сверяются тестом `test_data` — если меняешь данные, поправь и их
- `innerHTML` только через `esc()` — проект защищён от XSS и `__proto__` в `localStorage`
- Коммит — `git commit`, пуш — только в свою ветку, PR из неё

## CI

`npm run lint && npm test && npm run test:recognize && npm run test:ui && npm run test:browser` должны быть зелёными до PR. В job `build` workflow `pages.yml` идут npm audit, все суиты (включая настоящий Chromium) — и только зелёный `build` достаточен для слияния. Workflow `pages.yml` сам подстроится под `Settings → Pages → Source` и задеплоит только с `main`.

Вопросы — открывай issue с шагами воспроизведения.
