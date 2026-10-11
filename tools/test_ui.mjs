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
 * Сценарий: загрузка данных 7.41, выбор драфта (QoP против Huskar/Riki/Tidehunter/Oracle),
 * вердикт по лейну, угрозы, закуп, чеклист, все вкладки, таймер, сохранение в localStorage.
 */

import { JSDOM, VirtualConsole } from 'jsdom';

const BASE = process.argv[2] || process.env.SITE_URL || 'http://127.0.0.1:8000/';

const base = BASE.endsWith('/') ? BASE : BASE + '/';
const get = async (p) => (await fetch(base + p)).text();
const problems = [];

// Ожидаемые количества берём из самих данных — тесты не должны падать от новых героев/предметов.
const heroesCount = Object.keys(JSON.parse(await get('data/heroes.json'))).length;
const itemsCount = Object.values(JSON.parse(await get('data/items.json'))).filter((i) => !i.recipe).length;
let midCount = 0;
for (const f of JSON.parse(await get('data/kb_index.json')).files) {
  if (!f.startsWith('plans')) continue;
  midCount += Object.values(JSON.parse(await get('data/kb/' + f))).filter((p) => p && p.mid).length;
}

let html = await get('index.html');
const analysis = (await get('assets/analysis.js')).replace(/^export\s+/gm, '');
const app = (await get('assets/app.js')).replace(/^import\s*\{[\s\S]*?\}\s*from\s*'\.\/analysis\.js';/m, '');
html = html.replace('<script type="module" src="assets/app.js"></script>', `<script>\n${analysis}\n${app}\n</script>`);

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push('jsdomError: ' + e.message));
vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, {
  url: base, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(window) {
    window.fetch = (u, o) => globalThis.fetch(new URL(u, base).href, o);
    window.Response = globalThis.Response;
    window.Headers = globalThis.Headers;
    window.Element.prototype.scrollIntoView = function () {};
    window.prompt = () => null;
    try { Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} } }); } catch {}
    window.confirm = () => true;
  },
});
const { window } = dom;
const doc = window.document;
const t = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];
const click = (el) => { if (!el) throw new Error('нет элемента для клика'); el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); };
const type = (el, v) => { if (!el) throw new Error('нет поля ввода'); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const change = (el) => el.dispatchEvent(new window.Event('change', { bubbles: true }));
const check = (cond, label) => { console.log(`${cond ? '  ✓' : '  ✗'} ${label}`); if (!cond) problems.push('проверка: ' + label); };

const deadline = Date.now() + 30000;
while (Date.now() < deadline && !/патч 7\.41/.test($('#patchBadge')?.textContent || '')) await t(150);

console.log('\n1. Загрузка');
check(/патч 7\.41/.test($('#patchBadge')?.textContent || ''), `бейдж: ${$('#patchBadge')?.textContent?.trim()}`);
check(/данные от/.test($('#metaLine')?.textContent || ''), `строка данных: ${$('#metaLine')?.textContent?.trim()}`);
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
check(/Тяжёлый лейн/.test($('.verdict')?.textContent || ''), `вердикт: ${$('.verdict')?.textContent?.trim().slice(0, 60)}`);
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
const draftText = $('#view').textContent;
click($('[data-tab="heroes"]')); await t(300);
check($$('.pick[data-hero]').length === heroesCount, `героев в справочнике: ${$$('.pick[data-hero]').length}`);
type($('#heroSearch'), 'invoker'); await t(250);
check($$('.pick[data-hero]').length === 1, 'поиск героя работает');
click($('.pick[data-hero]')); await t(400);
check($$('.ability').length >= 13 && /Cold Snap/.test($('#view').textContent), `карточка Invoker: способностей ${$$('.ability').length}, есть вызываемые заклинания`);
click($('[data-tab="items"]')); await t(400);
const allItems = $$('.item-card').length;
check(allItems === itemsCount, `предметов в списке: ${allItems} (без рецептов в данных: ${itemsCount})`);
type($('#itemSearch'), 'blink'); await t(250);
check($$('.item-card').length >= 1 && $$('.item-card').length <= 4, `поиск «blink» → ${$$('.item-card').length} (Blink/Swift/Overwhelming)`);
click($('[data-tab="patch"]')); await t(400);
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

console.log(problems.length ? `\nПРОБЛЕМЫ (${problems.length}):\n - ` + problems.join('\n - ') : '\nПроблем не найдено.');
process.exit(problems.length ? 1 : 0);
