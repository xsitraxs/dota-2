#!/usr/bin/env node
/**
 * test_ui.mjs — прогон интерфейса в jsdom (эмуляция браузера) на живом сервере.
 *
 * Запуск:
 *   1) в одном терминале:  python3 -m http.server 8000
 *   2) в другом:           node tools/test_ui.mjs            (по умолчанию http://127.0.0.1:8000/)
 *      или с другим адресом: node tools/test_ui.mjs http://localhost:5173
 *
 * Требуется jsdom: npm install
 *
 * Сценарий: загрузка данных, выбор драфта (QoP против Huskar/Riki/Tidehunter/Oracle),
 * вердикт по лейну, угрозы, закуп, чеклист, все вкладки, таймер, сохранение в localStorage;
 * затем устойчивость: испорченное хранилище, скриншот с пустыми и неузнаваемыми ячейками,
 * ошибки загрузки шаблонов и изображения, уникальность героев в драфте.
 * Любая ошибка скрипта страницы или console.error в jsdom — провал теста.
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, readImage } from './imagemagick.mjs';

const BASE = process.argv[2] || process.env.SITE_URL || 'http://127.0.0.1:8000/';

const base = BASE.endsWith('/') ? BASE : BASE + '/';
const get = async (p) => (await fetch(base + p)).text();
const problems = [];

// Ожидаемые количества и версии берём из самих данных — тесты не должны падать от новых героев,
// предметов или следующего патча.
const heroesData = JSON.parse(await get('data/heroes.json'));
const heroesCount = Object.keys(heroesData).length;
const meta = JSON.parse(await get('data/meta.json'));
const series = meta.patchSeries || meta.latestPatch;
const patchKeys = Object.keys(JSON.parse(await get('data/patchnotes.json')));
const latestVersion = patchKeys.filter((k) => k === series || (k.startsWith(series) && /^[a-z]+$/.test(k.slice(series.length))))
  .sort((a, b) => a.length - b.length || a.localeCompare(b)).pop();
const itemsCount = Object.values(JSON.parse(await get('data/items.json'))).filter((i) => !i.recipe).length;
let midCount = 0;
for (const f of JSON.parse(await get('data/kb_index.json')).files) {
  if (!f.startsWith('plans')) continue;
  midCount += Object.values(JSON.parse(await get('data/kb/' + f))).filter((p) => p && p.mid).length;
}

let html = await get('index.html');
const analysis = (await get('assets/analysis.js')).replace(/^export\s+/gm, '');
const recognize = (await get('assets/recognize.js')).replace(/^export\s+/gm, '');
const app = (await get('assets/app.js'))
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/analysis\.js';\s*/m, '')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/recognize\.js';\s*/m, '');
html = html.replace('<script type="module" src="assets/app.js"></script>', `<script>\n${analysis}\n${recognize}\n${app}\n</script>`);

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push('jsdomError: ' + e.message));
vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));

/**
 * Новый экземпляр приложения: свои virtualConsole-обработчики уже навешены на problems.
 * withObserver — заглушка IntersectionObserver (в jsdom его нет), колбэк доступен как window.__io.
 * rawDraft — строка в localStorage как есть (испорченный JSON и т. п.).
 * fetchOverride(url, realFetch) — подмена ответов сервера (ошибки, изменённые файлы).
 * fakeMedia — заглушки Image, URL.createObjectURL и 2D-контекста canvas для загрузки файла.
 */
function bootApp(seedDraft, { withObserver = false, rawDraft = null, fetchOverride = null, fakeMedia = null } = {}) {
  const d = new JSDOM(html, {
    url: base, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      const realFetch = (u, o) => globalThis.fetch(new URL(u, base).href, o);
      window.fetch = fetchOverride ? (u, o) => fetchOverride(String(u), realFetch, o) : realFetch;
      window.Response = globalThis.Response;
      window.Headers = globalThis.Headers;
      window.Element.prototype.scrollIntoView = function () {};
      window.prompt = () => null;
      try { Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } }); } catch { /* старый jsdom — не страшно */ }
      window.confirm = () => true;
      // В jsdom нет canvas: приложение просто не рисует предпросмотр, а распознавание
      // получает пиксели через window.__dpShot (см. раздел «Скриншот»).
      window.HTMLCanvasElement.prototype.getContext = () => null;
      if (withObserver) window.IntersectionObserver = class { constructor(cb) { window.__io = cb; } observe() {} disconnect() {} };
      if (fakeMedia) installFakeMedia(window, fakeMedia);
    },
  });
  // Скрипт приложения стартует синхронно, но читает localStorage только после загрузки данных,
  // поэтому подсеять состояние можно сразу после создания окна.
  if (seedDraft) d.window.localStorage.setItem('dp.draft', JSON.stringify(seedDraft));
  if (rawDraft !== null) d.window.localStorage.setItem('dp.draft', rawDraft);
  return d;
}

/**
 * Заглушки браузерных API для пути «файл → пиксели»: Image декодирует «картинку» заданного размера
 * (или падает с onerror), canvas отдаёт 2D-контекст, getImageData — нули нужного размера.
 * Счётчики вызовов — в media.calls.
 */
function installFakeMedia(window, media) {
  media.calls = { create: 0, revoke: 0, canvas: [] };
  window.URL.createObjectURL = () => { media.calls.create++; return `blob:fake/${media.calls.create}`; };
  window.URL.revokeObjectURL = () => { media.calls.revoke++; };
  window.Image = class {
    set src(v) {
      this._src = v;
      setTimeout(() => {
        if (media.decode === 'fail') { if (this.onerror) this.onerror(new window.Event('error')); return; }
        this.naturalWidth = media.width;
        this.naturalHeight = media.height;
        if (this.onload) this.onload(new window.Event('load'));
      }, 5);
    }
    get src() { return this._src; }
  };
  const ctx = (canvas) => ({
    canvas, imageSmoothingQuality: 'low', lineWidth: 1, strokeStyle: '', fillStyle: '',
    drawImage() {}, putImageData() {}, fillRect() {}, strokeRect() {},
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new window.Uint8ClampedArray(w * h * 4) }),
  });
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    media.calls.canvas.push([this.width, this.height]);
    return ctx(this);
  };
  window.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
}

/** Ждать, пока приложение загрузит данные (бейдж серии патча из meta.json). */
async function waitLoaded(win, ms = 30000) {
  const until = Date.now() + ms;
  const ready = () => (win.document.querySelector('#patchBadge')?.textContent || '').includes(`патч ${series}`);
  while (Date.now() < until && !ready()) await t(150);
  return ready();
}
/** Ждать условия (опрос), вернуть, выполнилось ли оно. */
async function waitFor(cond, ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until && !cond()) await t(100);
  return cond();
}

const dom = bootApp();
const { window } = dom;
const doc = window.document;
const t = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];
const click = (el) => { if (!el) throw new Error('нет элемента для клика'); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); };
const type = (el, v) => { if (!el) throw new Error('нет поля ввода'); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const check = (cond, label) => { console.log(`${cond ? '  ✓' : '  ✗'} ${label}`); if (!cond) problems.push('проверка: ' + label); };

await waitLoaded(window);

console.log('\n1. Загрузка');
check(($('#patchBadge')?.textContent || '').trim() === `патч ${series}`, `бейдж — серия патча: ${$('#patchBadge')?.textContent?.trim()}`);
const metaLine = $('#metaLine')?.textContent || '';
check(metaLine.includes(`серия ${series}`) && metaLine.includes(`патчноуты до ${latestVersion}`)
  && metaLine.includes(`${heroesCount} героев`) && metaLine.includes(`${meta.items} предметов`),
  `строка данных: серия и буквенная версия раздельно — ${metaLine.trim()}`);
check(/Как пользоваться/.test($('#view')?.textContent || ''), 'стартовый экран драфта');

console.log('\n2. Драфт: QoP против Huskar/Riki/Tidehunter/Oracle');
click($('[data-pick="me:0"]')); await t(150);
check($('#pickerGrid') !== null, 'пикер открылся');
check($$('#pickerGrid .pick').length === midCount, `мидовых в пикере: ${$$('#pickerGrid .pick').length} (в данных: ${midCount})`);
type($('#pickerSearch'), 'queen'); await t(150);
check($$('#pickerGrid .pick').length === 1, 'поиск сузил список до 1');
click($('[data-choose="queenofpain"]')); await t(250);
check(/Queen of Pain/.test($('#view').textContent), 'мой герой выбран');

const enemies = ['huskar', 'riki', 'tidehunter', 'oracle'];
for (let i = 0; i < enemies.length; i++) {
  click($(`[data-pick="enemies:${i}"]`)); await t(120);
  check($$('#pickerGrid .pick').length > 100, `для врага ${i + 1} показаны все герои (${$$('#pickerGrid .pick').length})`);
  type($('#pickerSearch'), enemies[i]); await t(120);
  click($(`[data-choose="${enemies[i]}"]`)); await t(200);
}
check(/Huskar/.test($('#view').textContent) && /Riki/.test($('#view').textContent), 'враги в слотах');
click($('[data-pick="enemies:4"]')); await t(120);
type($('#pickerSearch'), 'huskar'); await t(120);
check($$('#pickerGrid .pick').length === 0, 'занятый герой не предлагается в другом слоте');
click($('[data-close]')); await t(60);
const sel = $('[data-enemy-mid]');
check(sel?.value === 'huskar', `их мид: ${sel?.value}`);
{
  // Вердикт — один из четырёх шаблонов движка; конкретный зависит от тегов тегов драфта, поэтому
  // проверяем не название, а согласованность: тон шаблона должен совпадать со знаком оценки.
  const v = $('.verdict');
  const score = Number(($('.verdict .score')?.textContent || '').trim());
  const tone = [...(v?.classList || [])].find((c) => ['good', 'even', 'bad'].includes(c));
  const expected = score >= 1.5 ? 'good' : score > -1.5 ? 'even' : 'bad';
  check(/Комфортный лейн|Лёгкий перевес|Ровный лейн|Тяжёлый лейн|Лейн проигран по цифрам/.test(v?.textContent || '')
    && tone === expected && Number.isFinite(score),
    `вердикт «${(v?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70)}», оценка ${score}, тон ${tone}`);
}
check($$('.factors tr').length >= 9, `строк в таблице факторов: ${$$('.factors tr').length}`);
check($$('.threat').length >= 8, `угроз: ${$$('.threat').length}`);
check($$('.item-row').length >= 12, `строк закупа: ${$$('.item-row').length}`);
check(/Sentry Ward/.test($('#view').textContent), 'Sentry Ward против Riki в закупе');
check($$('[data-set-me]').length >= 2, `рекомендаций пиков: ${$$('[data-set-me]').length}`);
check($$('input[data-check]').length >= 4, `пунктов чеклиста: ${$$('input[data-check]').length}`);

console.log('\n3. Интерактив');
const firstCheck = $('input[data-check]');
click(firstCheck); await t(150);
const savedChecks = JSON.parse(window.localStorage.getItem('dp.draft') || '{}').checks || {};
check(savedChecks[firstCheck.dataset.check] === true, 'галочка сохраняется в localStorage');
click(firstCheck); await t(150);
const afterUncheck = JSON.parse(window.localStorage.getItem('dp.draft') || '{}').checks || {};
check(!(firstCheck.dataset.check in afterUncheck), 'снятая галочка удаляет ключ, а не пишет false');
click(firstCheck); await t(150); // возвращаем как было — ниже сверим сохранность вкладки драфта
const draftText = $('#view').textContent;
click($('[data-tab="heroes"]')); await t(300);
check($$('.pick[data-hero]').length === heroesCount, `героев в справочнике: ${$$('.pick[data-hero]').length}`);
type($('#heroSearch'), 'invoker'); await t(250);
check($$('.pick[data-hero]').length === 1, 'поиск героя работает');
click($('.pick[data-hero]')); await t(400);
check($$('.ability').length >= 13 && /Cold Snap/.test($('#view').textContent), `карточка Invoker: способностей ${$$('.ability').length}, есть вызываемые заклинания`);
click($('[data-tab="items"]')); await t(400);
const itemPage = Number((app.match(/const ITEM_PAGE = (\d+)/) || [])[1]) || 60;
check($$('.item-card').length === itemPage, `первый рендер вкладки — ${itemPage} карточек, а не весь список (всего ${itemsCount})`);
check(new RegExp(`показано ${itemPage} из ${itemsCount}`).test($('#itemPager')?.textContent || ''), `счётчик пагинации: ${$('#itemPager')?.textContent?.trim()}`);
check($('#itemsSentinel') === null, 'в jsdom без IntersectionObserver ничего не висит впустую — остаётся кнопка');
// Поиск идёт по полному списку: Tango (90 золота) не попадает в первые страницы (сортировка по цене).
type($('#itemSearch'), 'tango'); await t(250);
check($$('.item-card').length === 2 && /Tango/.test($('#view').textContent), `поиск по всему списку: «tango» → ${$$('.item-card').length}`);
type($('#itemSearch'), ''); await t(250);
let guard = 0;
while ($$('.item-card').length < itemsCount && guard++ < 30) {
  const more = $('[data-items-more]');
  if (!more) break;
  click(more); await t(20);
}
check($$('.item-card').length === itemsCount, `кнопка «Показать ещё» доводит список до всех ${itemsCount} (кликов: ${guard})`);
check(/Показаны все/.test($('#itemPager')?.textContent || ''), `по завершении: ${$('#itemPager')?.textContent?.trim()}`);
click($('[data-tab="draft"]')); await t(150);
click($('[data-tab="items"]')); await t(300);
check($$('.item-card').length === itemPage, `возврат на вкладку снова рисует только ${itemPage} карточек`);
type($('#itemSearch'), 'blink'); await t(250);
check($$('.item-card').length >= 1 && $$('.item-card').length <= 4, `поиск «blink» → ${$$('.item-card').length} (Blink/Swift/Overwhelming)`);
type($('#itemSearch'), ''); await t(250);
click($('[data-tab="patch"]')); await waitFor(() => $('#patchSelect'));
const versions = $$('#patchSelect option').length;
check(versions >= 4 && $('#view').textContent.length > 800, `версий патча: ${versions}, символов: ${$('#view').textContent.length}`);
click($('[data-tab="timers"]')); await t(300);
check($$('.timer-row').length >= 5, `событий: ${$$('.timer-row').length}`);
const clk0 = $('.clock').textContent;
click($('[data-timer="start"]')); await t(2600);
const clk1 = $('.clock').textContent;
click($('[data-timer="stop"]')); await t(60);
const clkStop = $('.clock').textContent;
await t(1300);
const clk2 = $('.clock').textContent;
check(clk0 === '0:00' && clk1 !== clk0 && clkStop === clk2, `таймер: старт ${clk0} → ${clk1} → стоп ${clkStop}, через 1.3 с всё ещё ${clk2}`);
console.log('\n4. Возврат в драфт');
click($('[data-tab="draft"]')); await t(300);
check($('#view').textContent === draftText, 'драфт сохранился при переключении вкладок');
click($('[data-action="copy"]')); await t(300);
check(!problems.some((p) => /copy|prompt/i.test(p)), 'копирование плана не упало');
click($('[data-action="reset"]')); await t(300);
check(/Как пользоваться/.test($('#view').textContent), 'сброс драфта вернул стартовый экран');
const saved = JSON.parse(window.localStorage.getItem('dp.draft') || '{}');
check(saved.me === null, `localStorage после сброса: me=${saved.me}`);

console.log('\n5. Чистка галочек при загрузке');
const waterRune = 'Руна воды 2:00 и 4:00 — рефил бутылки, не отдавай её бесплатно';
const seeded = {
  'Сентри/дасты в инвентаре до 10-й минуты': true, // валидный пункт (нужен на другом драфте)
  'Галочка из старого драфта': true, // такого пункта чеклист не выдаёт никогда
  [waterRune]: false, // снятая галочка не должна храниться
};
const dom2 = bootApp({ me: 'queenofpain', enemies: ['huskar', null, null, null, null], enemyMid: 'huskar', allies: [], checks: seeded });
const w2 = dom2.window;
await waitLoaded(w2);
const cleaned = JSON.parse(w2.localStorage.getItem('dp.draft') || '{}').checks || {};
check(cleaned['Сентри/дасты в инвентаре до 10-й минуты'] === true, 'нужный пункт чеклиста остаётся');
check(!('Галочка из старого драфта' in cleaned), 'несуществующий ключ вычищается из localStorage');
check(!(waterRune in cleaned), 'значение false в хранилище не копится');

console.log('\n6. Подгрузка предметов по скроллу (заглушка IntersectionObserver)');
const dom3 = bootApp(null, { withObserver: true });
const w3 = dom3.window;
const $3 = (s) => w3.document.querySelector(s);
const $$3 = (s) => [...w3.document.querySelectorAll(s)];
const click3 = (el) => el.dispatchEvent(new w3.MouseEvent('click', { bubbles: true }));
await waitLoaded(w3);
click3($3('[data-tab="items"]')); await t(300);
check($$3('.item-card').length === itemPage, `на вкладке снова первая порция (${itemPage})`);
check($3('#itemsSentinel') !== null, 'страж подгрузки стоит после карточек');
w3.__io([{ isIntersecting: true }]); await t(80);
check($$3('.item-card').length === itemPage * 2, `подгрузка по скроллу добавила порцию: ${$$3('.item-card').length}`);

console.log('\n7. Распознавание скриншота во вкладке «Скриншот»');
{
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uishi-'));
  const strip = ['axe', 'crystal_maiden', 'invoker', 'pudge', 'sniper', 'queenofpain'];
  const CARD = 88;
  const GAP = 6;
  const PAD = 10;
  const W = PAD * 2 + strip.length * CARD + (strip.length - 1) * GAP;
  const H = PAD * 2 + CARD;
  const args = ['-size', `${W}x${H}`, 'xc:#0d1016'];
  strip.forEach((slug, i) => {
    args.push('(', path.join(ROOT, 'data', 'icons', `${slug}.webp`), '-crop', '144x144+56+0', '+repage',
      '-resize', `${CARD}x${CARD}!`, ')', '-geometry', `+${PAD + i * (CARD + GAP)}+${PAD}`, '-composite');
  });
  const png = path.join(tmp, 'ui-strip.png');
  convert([...args, png]);
  const { width: stripW, height: stripH, data } = readImage(png);
  const dims = [stripW, stripH];
  fs.rmSync(tmp, { recursive: true, force: true });

  const dom4 = bootApp();
  const w4 = dom4.window;
  const $4 = (s) => w4.document.querySelector(s);
  const $$4 = (s) => [...w4.document.querySelectorAll(s)];
  const click4 = (el) => el.dispatchEvent(new w4.MouseEvent('click', { bubbles: true }));
  await waitLoaded(w4);

  click4($4('[data-tab="shot"]'));
  await t(150);
  check($4('#shotDrop') !== null && /Ctrl\+V/.test($4('#shotDrop').textContent), 'вкладка предлагает вставить скриншот');
  check(w4.__dpShot !== undefined, 'есть вход для передачи кадра (тестовый)');

  w4.__dpShot({ width: dims[0], height: dims[1], data }, 'тестовая полоса');
  const shotDeadline = Date.now() + 30000;
  while (Date.now() < shotDeadline && !$4('#shotList')) await t(200);
  check($4('#shotList') !== null, 'распознавание завершилось и список показан');
  const picks = $$4('[data-shot-pick]').map((el) => el.value);
  check(picks.length === strip.length, `строк по числу карточек: ${picks.length}`);
  check(picks.join(',') === strip.join(','), `распознаны герои: ${picks.join(', ')}`);
  check(/уверенность/.test($4('#view').textContent), 'показана уверенность сетки');

  const selectEl = $4('[data-shot-pick="0"]');
  selectEl.value = 'lion';
  selectEl.dispatchEvent(new w4.Event('change', { bubbles: true }));
  await t(100);
  const altEl = $4('[data-shot-alt^="5:"]') || $4('[data-shot-alt]');
  check(altEl !== null, 'альтернативы показываются кнопками');
  let alt = null;
  if (altEl) {
    const [idx, slug] = altEl.dataset.shotAlt.split(':');
    click4(altEl);
    await t(120);
    alt = { idx: Number(idx), slug };
  }
  const picked = $$4('[data-shot-pick]').map((el) => el.value);
  check(picked[0] === 'lion' && alt && picked[alt.idx] === alt.slug,
    `правки распознавания учтены: ячейка 1 → ${picked[0]}, ячейка ${alt ? alt.idx + 1 : '—'} → ${alt ? alt.slug : '—'}`);

  click4($4('[data-shot="fill-enemies"]'));
  await t(150);
  click4($4('[data-tab="draft"]'));
  await t(150);
  const draftSlugs = $$4('.hero-mini .nm').map((el) => el.textContent.trim()).slice(0, 5);
  check(draftSlugs.length === 5, `драфт заполнен пятью героями: ${draftSlugs.join(', ')}`);
  const savedShot = JSON.parse(w4.localStorage.getItem('dp.draft') || '{}');
  check(Array.isArray(savedShot.enemies) && savedShot.enemies.filter(Boolean).length === 5, 'драфт сохранён в localStorage');

  click4($4('[data-tab="shot"]'));
  await t(150);
  const colsEl = $4('#shotCols');
  check(colsEl !== null, 'есть поля ручной нарезки');
  colsEl.value = '3';
  $4('#shotRows').value = '2';
  click4($4('[data-shot="resplit"]'));
  const manualDeadline = Date.now() + 30000;
  while (Date.now() < manualDeadline && $$4('[data-shot-pick]').length !== 6) await t(200);
  check($$4('[data-shot-pick]').length === 6, `ручная нарезка 3×2 дала ${$$4('[data-shot-pick]').length} ячейки`);
  check(/вручную/.test($4('#view').textContent), 'подписано, что нарезка ручная');

  // Область нарезки: можно указать один ряд карточек (как ряд команды на экране пика).
  const set = (sel, v) => { const el = $4(sel); el.value = v; el.dispatchEvent(new w4.Event('input', { bubbles: true })); };
  set('#shotX', 10);
  set('#shotY', 10);
  set('#shotW', 300);
  set('#shotH', 108);
  set('#shotCols', 3);
  set('#shotRows', 1);
  click4($4('[data-shot="resplit"]'));
  const regionDeadline = Date.now() + 30000;
  while (Date.now() < regionDeadline && $$4('[data-shot-pick]').length !== 3) await t(200);
  check($$4('[data-shot-pick]').length === 3, `нарезка области 300×108 на 3×1 дала ${$$4('[data-shot-pick]').length} ячейки`);
  check($4('#shotX').value === '10' && $4('#shotW').value === '300', 'поля области сохраняют введённые значения');
}

/** Полоса карточек для вкладки «Скриншот»: слаг героя, null — пустой слот, 'rose:' — не герой. */
function makeShot(slots, { card = 88, gap = 6, pad = 10 } = {}) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uishot-'));
  const W = pad * 2 + slots.length * card + (slots.length - 1) * gap;
  const H = pad * 2 + card;
  const args = ['-size', `${W}x${H}`, 'xc:#0d1016'];
  slots.forEach((slot, i) => {
    const src = slot === null ? ['-size', `${card}x${card}`, 'xc:#2a3140']
      : slot.endsWith(':') ? [slot, '-resize', `${card}x${card}!`]
        : [path.join(ROOT, 'data', 'icons', `${slot}.webp`), '-crop', '144x144+56+0', '+repage', '-resize', `${card}x${card}!`];
    args.push('(', ...src, ')', '-geometry', `+${pad + i * (card + gap)}+${pad}`, '-composite');
  });
  const png = path.join(tmpDir, 'shot.png');
  convert([...args, '-alpha', 'off', png]);
  const img = readImage(png);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return img;
}
/** Удобные обёртки над окном jsdom. */
function ui(win) {
  const q = (s) => win.document.querySelector(s);
  const qa = (s) => [...win.document.querySelectorAll(s)];
  return {
    q, qa,
    click: (el) => { if (!el) throw new Error('нет элемента для клика'); el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); },
    choose: (el, v) => { el.value = v; el.dispatchEvent(new win.Event('change', { bubbles: true })); },
    set: (sel, v) => { const el = q(sel); el.value = String(v); el.dispatchEvent(new win.Event('input', { bubbles: true })); },
    saved: () => JSON.parse(win.localStorage.getItem('dp.draft') || '{}'),
    picks: () => qa('[data-shot-pick]').map((el) => el.value),
    statuses: () => qa('[data-shot-status]').map((el) => el.dataset.shotStatus),
    // Индикатор ищем и по тексту: так проверка не зависит от разметки конкретной версии.
    idle: () => !q('#shotBusy') && !/Распознаю карточки/.test(q('#view')?.textContent || ''),
    text: () => q('#view').textContent,
  };
}
const knownSlug = (s) => s === null || Object.prototype.hasOwnProperty.call(heroesData, s);

console.log('\n8. Испорченное хранилище (общий localStorage у всех сайтов *.github.io)');
{
  const dom8 = bootApp({
    me: 'constructor',
    enemies: ['__proto__', 'toString', 'huskar', 'huskar', 'queenofpain'],
    enemyMid: 'hasOwnProperty',
    allies: ['valueOf', 'queenofpain', 'lion'],
    checks: ['не объект'],
  });
  const u = ui(dom8.window);
  check(await waitLoaded(dom8.window), 'приложение загрузилось');
  await t(200);
  check(!/Ошибка/.test(u.text()) && u.q('[data-pick="me:0"]') !== null, 'унаследованные имена (constructor, __proto__, toString…) не роняют интерфейс: свой герой пуст');
  const names = u.qa('.hero-mini .nm').map((el) => el.textContent.trim());
  check(names.filter((n) => n === 'Huskar').length === 1 && names.filter((n) => n === 'Queen of Pain').length === 1 && names.includes('Lion'),
    `повторы между слотами отброшены: ${names.join(', ')}`);
  check(['huskar', 'queenofpain'].includes(u.q('[data-enemy-mid]')?.value), `мид противника — из списка противников: ${u.q('[data-enemy-mid]')?.value}`);
  for (const raw of ['{не json', '[1,2,3]', 'null', '"строка"']) {
    const d = bootApp(null, { rawDraft: raw });
    const ok8 = await waitLoaded(d.window);
    await t(150);
    check(ok8 && /Как пользоваться/.test(d.window.document.querySelector('#view').textContent), `хранилище «${raw}» → обычный стартовый экран`);
  }
}

console.log('\n9. Скриншот с пустыми и неузнаваемыми ячейками → «Не определён» и верное заполнение драфта');
{
  const slots = ['axe', null, 'invoker', 'rose:', 'sniper'];
  const shotImg = makeShot(slots);
  const dom9 = bootApp();
  const w9 = dom9.window;
  const u = ui(w9);
  await waitLoaded(w9);
  u.click(u.q('[data-tab="shot"]'));
  await t(100);
  w9.__dpShot(shotImg, 'частично заполненный драфт');
  const done = await waitFor(() => u.idle() && u.q('#shotList'));
  check(done, 'распознавание завершилось: нет «Распознаю карточки…», список показан (раньше UI зависал на пустой ячейке)');
  check(!u.q('#shotError') && !/Ошибка интерфейса/.test(u.text()), 'без ошибок рендера и распознавания');
  check(u.picks().join(',') === 'axe,,invoker,,sniper', `ячейки: ${u.picks().map((p) => p || '«не определён»').join(', ')}`);
  check(u.statuses().join(',') === 'ok,empty,ok,weak,ok', `статусы: ${u.statuses().join(', ')}`);
  check(/Распознано героев: 3 из 5/.test(u.text()), 'заголовок считает только распознанных героев (3 из 5)');
  const weakRow = u.qa('[data-shot-status="weak"]')[0];
  check(weakRow && /не определён/.test(weakRow.textContent) && weakRow.querySelectorAll('[data-shot-alt]').length > 0,
    'неузнаваемая карточка: «не определён» и подсказки-кандидаты вместо фиктивного героя');
  const emptyRow = u.qa('[data-shot-status="empty"]')[0];
  check(emptyRow && /пустая ячейка/.test(emptyRow.textContent) && emptyRow.querySelectorAll('[data-shot-alt]').length === 0,
    'пустая ячейка: без близости и без кандидатов');

  u.click(u.q('[data-shot="fill-enemies"]'));
  await t(120);
  check(JSON.stringify(u.saved().enemies) === JSON.stringify(['axe', 'invoker', 'sniper', null, null]),
    `в противники — только распознанные герои по порядку: ${JSON.stringify(u.saved().enemies)}`);
  check(/Добавлено в противники: 3/.test(u.q('#shotNotice')?.textContent || ''), `итог: ${u.q('#shotNotice')?.textContent}`);
  u.click(u.q('[data-shot="fill-enemies"]'));
  await t(120);
  check(JSON.stringify(u.saved().enemies) === JSON.stringify(['axe', 'invoker', 'sniper', null, null]) && /уже в драфте или повтор: 3/.test(u.q('#shotNotice')?.textContent || ''),
    'повторное заполнение не дублирует героев');

  u.choose(u.q('[data-shot-pick="3"]'), 'lion');
  await t(80);
  check(u.statuses()[3] === 'manual' && u.picks()[3] === 'lion', 'неузнаваемой ячейке героя можно выбрать вручную');
  u.click(u.q('[data-shot="fill-allies"]'));
  await t(120);
  check(JSON.stringify(u.saved().allies) === JSON.stringify(['lion', null, null, null]) && /Добавлено в союзники: 1 · уже в драфте или повтор: 3/.test(u.q('#shotNotice')?.textContent || ''),
    `в союзники — только ручной выбор, занятые герои пропущены: ${JSON.stringify(u.saved().allies)}`);

  u.choose(u.q('[data-shot-pick="0"]'), '');
  await t(80);
  check(u.picks()[0] === '' && u.statuses()[0] === 'cleared', '«— не определён —» остаётся выбранным (раньше ячейка возвращалась к автоматическому герою)');
  u.choose(u.q('[data-shot-pick="1"]'), 'oracle');
  u.choose(u.q('[data-shot-pick="3"]'), 'oracle');
  await t(80);
  u.click(u.q('[data-tab="draft"]'));
  await t(80);
  u.click(u.q('[data-action="reset"]'));
  await t(80);
  u.click(u.q('[data-tab="shot"]'));
  await t(80);
  u.click(u.q('[data-shot="fill-enemies"]'));
  await t(120);
  check(JSON.stringify(u.saved().enemies) === JSON.stringify(['oracle', 'invoker', 'sniper', null, null]),
    `один герой в двух ячейках попадает в драфт один раз, «не определён» пропускается: ${JSON.stringify(u.saved().enemies)}`);

  // Ручная нарезка ровно по карточкам: те же статусы.
  u.set('#shotX', 10); u.set('#shotY', 10); u.set('#shotW', shotImg.width - 20); u.set('#shotH', 88);
  u.set('#shotCols', 5); u.set('#shotRows', 1);
  u.click(u.q('[data-shot="resplit"]'));
  await waitFor(() => u.idle() && /вручную/.test(u.text()));
  check(u.statuses().join(',') === 'ok,empty,ok,weak,ok' && u.picks().join(',') === 'axe,,invoker,,sniper', `ручная нарезка 5×1: ${u.statuses().join(', ')}`);
  // Область за краем кадра и колонки сверх предела обрезаются, интерфейс показывает реальные значения.
  u.set('#shotX', 300); u.set('#shotY', 10); u.set('#shotW', 5000); u.set('#shotH', 5000); u.set('#shotCols', 1000); u.set('#shotRows', 0);
  u.click(u.q('[data-shot="resplit"]'));
  await waitFor(() => u.idle() && u.qa('[data-shot-pick]').length === 24);
  check(u.q('#shotCols').value === '24' && u.q('#shotRows').value === '1' && u.qa('[data-shot-pick]').length === 24,
    `колонки 1000 → ${u.q('#shotCols').value}, строки 0 → ${u.q('#shotRows').value}, ячеек ${u.qa('[data-shot-pick]').length}`);
  check(Number(u.q('#shotX').value) + Number(u.q('#shotW').value) <= shotImg.width && Number(u.q('#shotY').value) + Number(u.q('#shotH').value) <= shotImg.height,
    `область урезана по кадру: x=${u.q('#shotX').value} ш=${u.q('#shotW').value} y=${u.q('#shotY').value} в=${u.q('#shotH').value}`);
  check(!u.q('#shotError') && !/Ошибка интерфейса/.test(u.text()), 'узкие ячейки за краем кадра не вызывают ошибок');

  // Однотонный кадр: сетки нет — понятное сообщение вместо «нарезка задана вручную».
  u.click(u.q('[data-shot="reset"]'));
  await t(60);
  w9.__dpShot({ width: 400, height: 225, data: new Uint8Array(400 * 225 * 4).fill(30) }, 'пустой кадр');
  await waitFor(() => u.idle() && u.q('#shotGridInfo'));
  check(/автоматически не найдена/.test(u.q('#shotGridInfo')?.textContent || '') && /Карточки героев не найдены/.test(u.text()),
    'кадр без карточек: «сетка не найдена» и подсказка про ручную нарезку');
  check(!u.q('[data-shot="fill-enemies"]'), 'без распознанных героев кнопок заполнения нет');
  const saved9 = u.saved();
  check([saved9.me, ...(saved9.enemies || []), ...(saved9.allies || [])].every(knownSlug), 'в хранилище только известные герои');
}

console.log('\n10. Ошибки загрузки шаблонов и посторонние слаги в шаблонах');
{
  const shotImg = makeShot(['axe', 'invoker', 'sniper']);
  let failOnce = true;
  const dom10 = bootApp(null, {
    fetchOverride: (u, real, o) => {
      if (u.includes('templates.json') && failOnce) { failOnce = false; return Promise.resolve(new Response('сбой', { status: 500 })); }
      return real(u, o);
    },
  });
  const w10 = dom10.window;
  const u = ui(w10);
  await waitLoaded(w10);
  u.click(u.q('[data-tab="shot"]'));
  await t(60);
  w10.__dpShot(shotImg, 'кадр');
  await waitFor(() => u.idle() && u.q('#shotError'));
  check(/HTTP 500/.test(u.q('#shotError')?.textContent || '') && u.idle(), `ошибка загрузки шаблонов видна, индикатор снят: ${u.q('#shotError')?.textContent}`);
  u.click(u.q('[data-shot="auto"]'));
  await waitFor(() => u.idle() && u.q('#shotList'));
  check(u.picks().join(',') === 'axe,invoker,sniper' && !u.q('#shotError'), 'повторная попытка загружает шаблоны заново и распознаёт кадр');

  // Шаблоны с неизвестным слагом: у Axe подписи «чужого» героя not_a_hero, своего шаблона нет.
  const tplJson = JSON.parse(await get('data/templates.json'));
  const spoof = { ...tplJson, heroes: { ...tplJson.heroes, not_a_hero: tplJson.heroes.axe, constructor: tplJson.heroes.axe } };
  delete spoof.heroes.axe;
  const dom10b = bootApp(null, {
    fetchOverride: (u2, real, o) => (u2.includes('templates.json')
      ? Promise.resolve(new Response(JSON.stringify(spoof), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : real(u2, o)),
  });
  const ub = ui(dom10b.window);
  await waitLoaded(dom10b.window);
  ub.click(ub.q('[data-tab="shot"]'));
  await t(60);
  dom10b.window.__dpShot(shotImg, 'кадр');
  await waitFor(() => ub.idle() && ub.q('#shotList'));
  ub.click(ub.q('[data-shot="fill-enemies"]'));
  await t(120);
  const enemies10 = ub.saved().enemies || [];
  check(enemies10.every(knownSlug) && !enemies10.includes('not_a_hero') && !enemies10.includes('constructor'),
    `слаги не из данных приложения в драфт не попадают: ${JSON.stringify(enemies10)}`);
  check(!ub.qa('[data-shot-alt]').some((el) => /not_a_hero|constructor/.test(el.dataset.shotAlt)), 'и не предлагаются подсказками');
}

console.log('\n11. Загрузка файла скриншота: ошибки и очень большие кадры');
{
  const media = { decode: 'fail', width: 0, height: 0 };
  const dom11 = bootApp(null, { fakeMedia: media });
  const w11 = dom11.window;
  const u = ui(w11);
  await waitLoaded(w11);
  u.click(u.q('[data-tab="shot"]'));
  await t(60);
  const pickFile = (file) => {
    const input = u.q('#shotFile');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new w11.Event('change', { bubbles: true }));
  };
  pickFile(new w11.File(['не картинка'], 'broken.png', { type: 'image/png' }));
  await waitFor(() => u.q('#shotError'));
  check(/Не удалось прочитать изображение: формат изображения не поддержан/.test(u.q('#shotError')?.textContent || ''), `битая картинка: ${u.q('#shotError')?.textContent}`);
  check(media.calls.create === 1 && media.calls.revoke === 1, `object URL освобождён и при ошибке (создано ${media.calls.create}, освобождено ${media.calls.revoke})`);
  pickFile(new w11.File(['%PDF'], 'doc.pdf', { type: 'application/pdf' }));
  await waitFor(() => /это не изображение/.test(u.q('#shotError')?.textContent || ''));
  check(/это не изображение/.test(u.q('#shotError')?.textContent || '') && media.calls.create === 1, 'не-изображение отклоняется сразу, без декодирования');

  media.decode = 'ok';
  media.width = 3000;
  media.height = 600;
  pickFile(new w11.File(['png'], 'huge.png', { type: 'image/png' }));
  await waitFor(() => u.idle() && /уменьшено с 3000×600/.test(u.text()));
  check(/2560×512 \(уменьшено с 3000×600\)/.test(u.text()), 'кадр больше 2560 px уменьшается перед распознаванием, это видно в интерфейсе');
  check(media.calls.canvas.some(([cw, ch]) => cw === 2560 && ch === 512) && !media.calls.canvas.some(([cw]) => cw === 3000),
    'полноразмерный canvas 3000×600 не создаётся');
  check(media.calls.revoke === media.calls.create, `object URL освобождён после загрузки (${media.calls.revoke}/${media.calls.create})`);
  check(/автоматически не найдена/.test(u.text()) && !/Ошибка интерфейса/.test(u.text()), 'предпросмотр с canvas и пустой результат рисуются без ошибок');
}

console.log('\n12. Сброс во время распознавания и стоимость предпросмотра');
{
  const shotImg = makeShot(['axe', 'invoker', 'sniper', 'pudge']);
  const media = { decode: 'ok', width: 1, height: 1 };
  const dom = bootApp(null, { fakeMedia: media });
  const w = dom.window;
  const u = ui(w);
  await waitLoaded(w);
  u.click(u.q('[data-tab="shot"]'));
  await t(60);
  w.__dpShot(shotImg, 'кадр');
  u.click(u.q('[data-shot="reset"]')); // сброс раньше, чем распознавание успело начаться
  await t(1500);
  check(u.idle() && !u.q('#shotList') && u.q('#shotDrop') && /Ctrl\+V/.test(u.q('#shotDrop').textContent),
    'сброс во время распознавания: индикатор снят, устаревший результат не появляется');
  w.__dpShot(shotImg, 'кадр');
  await waitFor(() => u.idle() && u.q('#shotList'));
  const fullSize = () => media.calls.canvas.filter(([cw, ch]) => cw === shotImg.width && ch === shotImg.height).length;
  const before = fullSize();
  u.choose(u.q('[data-shot-pick="0"]'), 'lion');
  u.choose(u.q('[data-shot-pick="1"]'), 'oracle');
  await t(100);
  check(u.picks().join(',') === 'lion,oracle,sniper,pudge', 'после повторной загрузки распознавание и правки работают');
  check(before === 1 && fullSize() === 1, `полноразмерная копия кадра одна на кадр, а не на каждую миниатюру и перерисовку (создано ${fullSize()})`);
}

console.log('\n13. Уникальность героев в драфте, переходы к предметам, герои без иконок');
{
  const enemies = ['huskar', 'riki', 'tidehunter', 'oracle', null];
  const dom12 = bootApp({ me: 'queenofpain', enemies, enemyMid: 'huskar', allies: ['lion', null, null, null] });
  const w12 = dom12.window;
  const u = ui(w12);
  await waitLoaded(w12);
  await t(150);
  const recs = u.qa('[data-set-me]').map((el) => el.dataset.setMe);
  check(recs.length > 0 && !recs.some((s) => enemies.includes(s) || s === 'lion' || s === 'queenofpain'),
    `рекомендации пиков без занятых героев: ${recs.join(', ')}`);
  u.click(u.q('[data-tab="heroes"]'));
  await t(150);
  u.click(u.q('[data-hero="huskar"]'));
  await t(200);
  check(!u.q('#heroCard [data-set-me]') && /Уже в драфте: у противников/.test(u.q('#heroCard')?.textContent || ''),
    'карточка героя противника не предлагает поставить его себе');
  const stale = w12.document.createElement('button');
  stale.dataset.setMe = 'huskar';
  w12.document.body.appendChild(stale);
  u.click(stale);
  await t(100);
  check(u.saved().me === undefined || u.saved().me === 'queenofpain', 'устаревшая кнопка «Поставить себе» для героя противника ничего не меняет');
  check(JSON.parse(w12.localStorage.getItem('dp.draft') || '{}').me !== 'huskar', 'свой герой не совпадает с героем противника');
  u.click(u.q('[data-tab="draft"]'));
  await t(150);
  const chip = u.q('.item-chip[data-item]');
  const itemName = chip ? chip.firstChild.textContent.trim() : '';
  u.click(chip);
  await t(250);
  check(u.q('#itemSearch')?.value === itemName && u.qa('.item-card').some((el) => el.textContent.includes(itemName)),
    `клик по предмету в закупе открывает его в справочнике: «${itemName}»`);

  // Герои без иконки в источнике: буквенный аватар вместо картинки (и никаких чужих портретов).
  const noIcon = JSON.parse(await get('data/icons.json'));
  const missing = Object.values(heroesData).filter((h) => !noIcon[h.slug]);
  u.click(u.q('[data-tab="heroes"]'));
  await t(150);
  for (const h of missing) {
    const card = u.q(`.pick[data-hero="${h.slug}"]`);
    const ph = card && card.querySelector('.avatar .ph');
    check(ph && !card.querySelector('img') && ph.textContent.trim().length > 0 && /нет иконки/.test(ph.title),
      `${h.localized_name}: буквенный аватар «${ph ? ph.textContent.trim() : '—'}», картинки нет`);
  }
  u.click(u.q('[data-tab="about"]'));
  await t(150);
  check(missing.every((h) => u.text().includes(h.localized_name)) && /нет иконки|Без иконки/.test(u.text()),
    `«Как это работает» честно перечисляет героев без иконок: ${missing.map((h) => h.localized_name).join(', ')}`);
}

console.log('\n14. Правки аудита: закуп, карточки, порядок способностей, патчноут, поиск и таймер');
{
  const plansKb = {};
  for (const f of JSON.parse(await get('data/kb_index.json')).files) {
    if (f.startsWith('plans')) Object.assign(plansKb, JSON.parse(await get('data/kb/' + f)));
  }
  const qopSituational = (plansKb.queenofpain.items.situational || []).map(([key]) => key);
  const itemsData = JSON.parse(await get('data/items.json'));
  const abilitiesData = JSON.parse(await get('data/abilities.json'));
  const heroesRaw = heroesData;

  const dom14 = bootApp({ me: 'queenofpain', enemies: ['riki', 'clinkz', 'huskar', null, null], enemyMid: 'huskar' });
  const w14 = dom14.window;
  const u = ui(w14);
  const scrolled = [];
  w14.Element.prototype.scrollIntoView = function () { scrolled.push(this.id || this.className); };
  await waitLoaded(w14);
  await t(200);

  // Ситуативный закуп драфта: курируемые предметы плана героя не теряются в адаптации под теги врага.
  const chips = u.qa('[data-item]').map((el) => el.dataset.item);
  const curatedShown = qopSituational.filter((k) => chips.includes(k));
  check(qopSituational.length > 0 && curatedShown.length === qopSituational.length,
    `ситуативный закуп содержит все ${qopSituational.length} предметов плана героя (найдено ${curatedShown.length})`);
  // Порядок способностей: ультимейт описан один раз, отдельной строки-дубля нет.
  const skillsBlock = (u.text().split('Порядок способностей')[1] || '').split('Стартовый закуп')[0];
  const ultName = abilitiesData[Object.keys(abilitiesData).find((k) => k === 'queenofpain_sonic_wave')]?.dname || 'Sonic Wave';
  check((skillsBlock.match(new RegExp(ultName, 'g')) || []).length === 1,
    `ультимейт «${ultName}» в порядке способностей ровно один раз`);
  const skillKeys = (plansKb.queenofpain.skills || []).map(([k]) => k);
  check(skillKeys.every((k) => !abilitiesData[k] || !abilitiesData[k].granted),
    'в порядке способностей плана нет способностей, выдаваемых шардом/агханимом');

  // Справочник предметов: характеристики и мана/КД видны, карточка не пустая.
  u.click(u.q('[data-tab="items"]'));
  await t(300);
  u.set('#itemSearch', 'blink');
  await t(300);
  const blinkCard = u.qa('.item-card').find((el) => /Blink Dagger/.test(el.textContent));
  const blink = Object.values(itemsData).find((it) => it.dname === 'Blink Dagger');
  check(blinkCard && blink && String(blink.attrib[0]?.value) && blinkCard.textContent.includes(String(blink.attrib[0].value)),
    `карточка Blink Dagger показывает числовую характеристику (${blink ? blink.attrib[0]?.value : '—'})`);
  u.set('#itemSearch', 'black king bar');
  await t(300);
  const bkbCard = u.qa('.item-card').find((el) => /Black King Bar/.test(el.textContent));
  check(bkbCard && /перезарядка/.test(bkbCard.textContent) && /мана/.test(bkbCard.textContent),
    `карточка Black King Bar показывает ману и перезарядку: ${bkbCard ? bkbCard.textContent.replace(/\s+/g, ' ').slice(0, 90) : '—'}`);
  const withHint = Object.values(itemsData).find((it) => it.hint && it.hint.length && !it.abilities.length);
  u.set('#itemSearch', withHint ? withHint.dname : 'tier');
  await t(300);
  check(!withHint || u.qa('.item-card').some((el) => el.textContent.includes(withHint.hint[0].slice(0, 24))),
    `подсказка источника видна в карточке «${withHint ? withHint.dname : '—'}»`);

  // Справочник героев: связанные способности идут карточками с описанием, пустых записей нет.
  u.click(u.q('[data-tab="heroes"]'));
  await t(200);
  u.set('#heroSearch', 'zuus');
  await t(250);
  const scrolledBefore = scrolled.length;
  u.set('#heroSearch', 'zuu'); // выбор уже сделан: ввод следующих букв не должен прокручивать страницу
  await t(250);
  check(scrolled.length === scrolledBefore, 'ввод в поиске героя не прокручивает страницу к карточке');
  u.click(u.q('.pick[data-hero]'));
  await t(300);
  check(scrolled.length > scrolledBefore, 'выбор героя прокручивает к его карточке');
  const zuusCard = u.q('#heroCard');
  const zuusExtra = heroesRaw.zuus.extra.filter((k) => abilitiesData[k] && (abilitiesData[k].dname || abilitiesData[k].desc));
  check(zuusExtra.length === 0 || zuusExtra.every((k) => zuusCard.textContent.includes(abilitiesData[k].dname)),
    `связанные способности Zeus показаны: ${zuusExtra.map((k) => abilitiesData[k].dname).join(', ')}`);
  // Записи без названия и описания (rubick_hidden1, dawnbreaker_land) и служебные слоты
  // (Stolen Spell, Invoked Spell) в карточке героя не показываются вовсе.
  const technical = Object.entries(abilitiesData)
    .filter(([, a]) => !a.dname && !a.desc).map(([k]) => k);
  u.set('#heroSearch', 'rubick');
  await t(250);
  u.click(u.q('.pick[data-hero="rubick"]'));
  await t(300);
  // Служебные слоты (*_empty1/2: Stolen Spell, Invoked Spell) не должны попадать в список
  // способностей героя отдельной карточкой — только как часть описания ульты.
  const serviceNames = ['Stolen Spell', 'Invoked Spell', 'Devoured Ability', 'Souvenir Slot'];
  const cardNames = u.qa('#heroCard .ability .nm').map((el) => el.textContent.trim());
  check(technical.length > 0 && cardNames.length > 0
    && !cardNames.some((n) => serviceNames.some((s) => n.startsWith(s))),
    `в карточке Rubick ${cardNames.length} способностей, служебных слотов среди них нет (${cardNames.join(' / ')})`);
  // Способность, выдаваемая шардом, помечена и не выглядит как слот прокачки.
  u.set('#heroSearch', 'tinker');
  await t(250);
  u.click(u.q('.pick[data-hero="tinker"]'));
  await t(300);
  check(/выдаёт шард|выдаёт агханим/.test(u.text()) && u.text().includes(abilitiesData.tinker_warp_grenade.dname),
    'карточка Tinker: шард-способность помечена («выдаёт шард»), а не показана как качаемая');

  // Патчноут: без сырых HTML-тегов и без падения на записи-массиве (как misc у 7.40).
  const patchnotes = JSON.parse(await get('data/patchnotes.json'));
  const rawTags = Object.values(patchnotes).some((n) => JSON.stringify(n).match(/<br>|<span|<font/));
  check(!rawTags, 'в patchnotes.json не осталось HTML-разметки источника');
  const noteTags = Object.values(patchnotes).flatMap((n) => Object.values(n.heroes || {}))
    .some((v) => Object.entries(Array.isArray(v) ? {} : v).some(([ab]) => !/^[a-z0-9_]+$/.test(ab) && ab.length > 40));
  check(!noteTags, 'в патчноуте записи героев — по способностям, а не абзацы текста');
  u.click(u.q('[data-tab="patch"]'));
  await t(400);
  check(!/<br>|<span|<font/.test(u.text()) && u.text().length > 800, 'вкладка «Патч» печатает текст без HTML-тегов');
  // «Прочее» в патчноутах — массив строк (как misc у 7.40–7.41f): раньше такие записи роняли вкладку.
  // Показывается одна версия патча, поэтому сверяем только её записи «прочее» (они приходят массивами).
  const shownVersion = u.q('#patchSelect')?.value;
  const miscNotes = (patchnotes[shownVersion] && patchnotes[shownVersion].heroes && patchnotes[shownVersion].heroes.misc) || [];
  const compactText = (v) => String(v).replace(/\s+/g, '');
  const shownMisc = miscNotes.filter((line) => compactText(u.text()).includes(compactText(line).slice(0, 40)));
  check(miscNotes.length > 0 && shownMisc.length === miscNotes.length,
    `записи «прочее» патча ${shownVersion} показаны (${shownMisc.length} из ${miscNotes.length})`);

  // Запись героя-массивом (как «misc» в данных 7.40) раньше роняла вкладку с TypeError.
  const arraysInData = Object.values(patchnotes).some((n) => Object.values(n.heroes || {}).some((v) => Array.isArray(v)));
  check(arraysInData, 'в патчноутах есть запись-массив (её и должен переживать интерфейс, а не падать)');
  const domPatch = bootApp({ me: 'queenofpain' }, {
    fetchOverride: async (url, realFetch) => {
      if (!String(url).includes('patchnotes.json')) return realFetch(url);
      const res = await realFetch(url);
      const json = await res.json();
      // Запись героя приходит массивом строк (как «misc»): раньше renderPatch падал на ней с TypeError.
      for (const note of Object.values(json)) if (note.heroes) note.heroes.axe = ['Berserker’s Call: тест записи-массива'];
      return new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json' } });
    },
  });
  const uPatch = ui(domPatch.window);
  await waitLoaded(domPatch.window);
  uPatch.click(uPatch.q('[data-tab="patch"]'));
  await waitFor(() => uPatch.q('#patchSelect'));
  const compact = (v) => String(v).replace(/\s+/g, '');
  check(!/Ошибка интерфейса/.test(uPatch.text()) && uPatch.text().length > 800
    && compact(uPatch.text()).includes(compact('Berserker\u2019s Call: тест записи-массива')),
    'вкладка «Патч» печатает запись героя-массив, а не падает с TypeError');

  // Пикер: поиск по слагу, закрытие по Escape, «мидовые» из планов.
  u.click(u.q('[data-tab="draft"]'));
  await t(200);
  u.click(u.q('[data-pick="enemies:3"]'));
  await t(150);
  const search = u.q('#pickerSearch');
  // queenofpain не берём: он выбран своим героем и в пикере его быть не должно.
  const bySlug = ['antimage', 'furion', 'nevermore', 'zuus', 'slark'];
  const foundBySlug = bySlug.filter((slug) => {
    search.value = slug;
    search.dispatchEvent(new w14.Event('input', { bubbles: true }));
    const grid = u.qa('#pickerGrid .pick').map((el) => el.dataset.choose);
    return grid.length === 1 && grid[0] === slug;
  });
  check(foundBySlug.length === bySlug.length, `поиск в пикере находит героя по слагу: ${foundBySlug.join(', ')}`);
  search.dispatchEvent(new w14.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await t(100);
  check(u.q('#pickerGrid') === null, 'Escape закрывает пикер');
  w14.document.dispatchEvent(new w14.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await t(60);

  // Таймер: повторный «Старт» не сбрасывает идущий отсчёт.
  u.click(u.q('[data-tab="timers"]'));
  await t(200);
  u.click(u.q('[data-timer="start"]'));
  await t(1300);
  const beforeRestart = u.q('.clock').textContent;
  u.click(u.q('[data-timer="start"]'));
  await t(200);
  const afterRestart = u.q('.clock').textContent;
  const secs = (v) => { const [m, sec] = v.split(':').map(Number); return m * 60 + sec; };
  check(secs(afterRestart) >= secs(beforeRestart), `повторный «Старт» не сбрасывает таймер: ${beforeRestart} → ${afterRestart}`);

  // Скриншот: правка координат области не теряется при перерисовке списка ячеек.
  const shotImg = makeShot(['axe', 'invoker', 'sniper', 'pudge']);
  const media14 = { decode: 'ok', width: 1, height: 1 };
  const dom14b = bootApp(null, { fakeMedia: media14 });
  const w14b = dom14b.window;
  const u14b = ui(w14b);
  await waitLoaded(w14b);
  u14b.click(u14b.q('[data-tab="shot"]'));
  await t(60);
  w14b.__dpShot(shotImg, 'кадр');
  await waitFor(() => u14b.idle() && u14b.q('#shotList'));
  u14b.set('#shotX', 12);
  u14b.set('#shotW', 300);
  u14b.choose(u14b.q('[data-shot-pick="0"]'), 'lion'); // перерисовка формы
  await t(200);
  check(u14b.q('#shotX')?.value === '12' && u14b.q('#shotW')?.value === '300',
    `координаты области сохраняются при правке ячейки: x=${u14b.q('#shotX')?.value}, ш=${u14b.q('#shotW')?.value}`);
}

console.log('\n15. Закуп по роли героя, когда курируемого плана нет');
{
  const archetypes = JSON.parse(await get('data/kb/archetypes.json'));
  const support = archetypes.archetypes.support;
  const dom15 = bootApp({ me: 'crystal_maiden', enemies: ['riki', 'clinkz', null, null, null], enemyMid: null });
  const w15 = dom15.window;
  const u15 = ui(w15);
  await waitLoaded(w15);
  await t(250);
  // Панель плана обязана честно сказать, что план собран по роли, а не курирован под патч.
  check(/закуп собран по его роли/.test(u15.text()) && /Поддержка/.test(u15.text()),
    'панель плана объясняет сборку по роли');
  const chips15 = u15.qa('[data-item]').map((el) => el.dataset.item);
  const roleItems = support.start.map(([k]) => k).concat(support.early.map(([k]) => k));
  check(roleItems.every((k) => chips15.includes(k)),
    `предметы роли поддержки видны в закупе: ${roleItems.filter((k) => chips15.includes(k)).length} из ${roleItems.length}`);
  check(support.start.some(([k]) => k === 'ward_observer') && chips15.includes('ward_observer'),
    'поддержке предлагаются обзорные варды');
  const tips15 = u15.text();
  check(support.tips.filter((t) => tips15.includes(t.slice(0, 30))).length >= 1, 'советы по роли показаны в панели плана');
  // Тот же герой в справочнике показывает, по какой роли собран закуп.
  u15.click(u15.q('[data-tab="heroes"]'));
  await t(200);
  u15.set('#heroSearch', 'crystal_maiden');
  await t(250);
  u15.click(u15.q('.pick[data-hero="crystal_maiden"]'));
  await t(300);
  check(/закуп по роли/.test(u15.q('#heroCard')?.textContent || ''), 'в карточке героя видно, по какой роли собран закуп');
  // У героя с курируемым планом вместо роли — отметка о плане.
  u15.set('#heroSearch', 'queenofpain');
  await t(250);
  u15.click(u15.q('.pick[data-hero="queenofpain"]'));
  await t(300);
  const card15 = u15.q('#heroCard')?.textContent || '';
  check(/мидовый план есть/.test(card15) && !/закуп по роли/.test(card15), 'у героя с планом роли не подмешивается');
}

console.log('\n16. Ленивая загрузка патчноутов (365 КБ не должны ехать на старте)');
{
  const asked = [];
  const dom16 = bootApp({ me: 'queenofpain' }, {
    fetchOverride: (url, real, o) => { asked.push(String(url)); return real(url, o); },
  });
  const u16 = ui(dom16.window);
  await waitLoaded(dom16.window);
  await t(200);
  const heavy = asked.filter((u) => /patchnotes\.json|templates\.json/.test(u));
  check(heavy.length === 0 && asked.length > 0,
    `на старте запрошено ${asked.length} файлов, тяжёлых среди них нет${heavy.length ? `: ${heavy.join(', ')}` : ''}`);
  u16.click(u16.q('[data-tab="patch"]'));
  const shown = await waitFor(() => u16.q('#patchSelect') && u16.q('#patchSelect').options.length >= 4);
  const calls = () => asked.filter((u) => u.includes('patchnotes.json')).length;
  check(shown && calls() === 1, `вкладка «Патч» подгружает патчноуты ровно одним запросом (запросов: ${calls()})`);
  u16.click(u16.q('[data-tab="draft"]'));
  await t(200);
  u16.click(u16.q('[data-tab="patch"]'));
  await waitFor(() => u16.q('#patchSelect'));
  check(calls() === 1, 'возврат на вкладку берёт патчноуты из памяти, а не из сети');

  // Сбой загрузки: вкладка объясняет, что случилось, и повторная попытка (файл не кэшируется) работает.
  let failOnce = true;
  const dom16b = bootApp({ me: 'queenofpain' }, {
    fetchOverride: (url, real, o) => {
      if (String(url).includes('patchnotes.json') && failOnce) {
        failOnce = false;
        return Promise.resolve(new Response('сбой', { status: 500 }));
      }
      return real(url, o);
    },
  });
  const u16b = ui(dom16b.window);
  await waitLoaded(dom16b.window);
  u16b.click(u16b.q('[data-tab="patch"]'));
  const failed = await waitFor(() => /Патчноуты не загрузились/.test(u16b.text()));
  check(failed && /HTTP 500/.test(u16b.text()) && !/Ошибка интерфейса/.test(u16b.text()),
    'сбой загрузки объясняется на вкладке, а не молчанием и не ошибкой интерфейса');
  u16b.click(u16b.q('[data-tab="draft"]'));
  await t(150);
  u16b.click(u16b.q('[data-tab="patch"]'));
  check(await waitFor(() => u16b.q('#patchSelect')), 'повторное открытие вкладки пробует загрузить файл снова');
}

console.log('\n17. Данные источника в карточке героя');
{
  // Пустой массив в dmg_type давал в карточке висящее «тип урона: » без значения (Huskar Blood Magic,
  // Dark Seer Aggrandize). Сборщик это чинит, тест смотрит на экран, а не на данные.
  const dom17 = bootApp();
  const u17 = ui(dom17.window);
  await waitLoaded(dom17.window);
  u17.click(u17.q('[data-tab="heroes"]'));
  await t(200);
  const dangling = [];
  for (const slug of ['huskar', 'dark_seer', 'rattletrap']) {
    u17.set('#heroSearch', slug);
    await t(200);
    const pick = u17.q(`.pick[data-hero="${slug}"]`);
    if (!pick) { dangling.push(`${slug}: нет карточки`); continue; }
    u17.click(pick);
    await t(250);
    const card = u17.q('#heroCard')?.textContent || '';
    if (/тип урона:\s*(?:·|$)/.test(card)) dangling.push(slug);
  }
  check(dangling.length === 0, `висящего «тип урона:» без значения нет: ${dangling.join(', ') || 'ни у кого'}`);

  // attrib способностей уехал без ключа характеристики — подписи и числа в карточке должны остаться.
  u17.set('#heroSearch', 'antimage');
  await t(200);
  u17.click(u17.q('.pick[data-hero="antimage"]'));
  await t(300);
  const anti = u17.q('#heroCard')?.textContent || '';
  check(/MANA BURNED AS DAMAGE:/.test(anti) && /MANA BURNED PER HIT:/.test(anti),
    'подписи характеристик способности видны в карточке (ключи attrib не нужны)');
}

console.log(problems.length ? `\nПРОБЛЕМЫ (${problems.length}):\n - ` + problems.join('\n - ') : '\nПроблем не найдено.');
process.exit(problems.length ? 1 : 0);
