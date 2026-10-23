#!/usr/bin/env node
/**
 * test_browser.mjs — прогон основных сценариев в настоящем браузере (Chromium).
 *
 * jsdom и тест на локальном HTTP-сервере (test:ui) проверяют логику, но не реальные API
 * браузера и настоящую вёрстку. Здесь те же пути проходятся в Chromium из
 * @sparticuz/chromium (бинарник лежит в npm-пакете, сеть для него не нужна):
 *   1) загрузка реального скриншота файлом и распознавание до списка героев;
 *   2) вставка изображения событием ClipboardEvent;
 *   3) выбор героя через пикер и удаление его из слота;
 *   4) ссылка-шаринг: hash ставится, копируется и открывается заново как новый драфт;
 *   5) галочка чеклиста переживает перезагрузку страницы (localStorage);
 *   6) узкий экран (390×844): нет горизонтального переполнения, вкладки рабочие.
 *
 * Локально и в CI поднимается свой python http.server; браузеру сеть наружу не нужна.
 * Запуск: node tools/test_browser.mjs
 */
/* global document, window, location, DataTransfer, ClipboardEvent */
// Глобалы браузера выше используются только внутри page.evaluate(...) — в Node-части они не нужны.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BROWSER_TEST_PORT) || 8417;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE_SHOT = path.join(ROOT, 'tools', 'rec_fixtures', 'draft-strip.jpg');
const FIXTURE_PASTE = path.join(ROOT, 'tools', 'rec_fixtures', 'heroes-tab.png');

let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** boot() асинхронно грузит данные и только потом вешает обработчики — ждём первый рендер. */
const waitAppReady = (page) => page.waitForSelector('[data-action="random"]', { state: 'visible', timeout: 20000 });

/* ------------------------------ chromium + системные библиотеки ------------------------------ */

async function launchBrowser() {
  const { chromium: pw } = await import('playwright-core');
  const sparticuz = (await import('@sparticuz/chromium')).default;
  const exe = await sparticuz.executablePath(); // распаковывает бинарник во временный каталог
  // @sparticuz/chromium тянет с собой системные библиотеки (libnss3 и др.) в al2023.tar.br:
  // в обычном дистрибутиве их нет, и браузер не стартует с «libnspr4.so: cannot open».
  const libDir = path.join(os.tmpdir(), 'al2023', 'lib');
  const libnss = path.join(libDir, 'libnss3.so');
  if (!fs.existsSync(libnss)) {
    const br = path.join(ROOT, 'node_modules', '@sparticuz', 'chromium', 'bin', 'al2023.tar.br');
    if (fs.existsSync(br)) {
      const tarFile = path.join(os.tmpdir(), 'al2023.tar');
      fs.writeFileSync(tarFile, zlib.brotliDecompressSync(fs.readFileSync(br)));
      fs.mkdirSync(path.join(os.tmpdir(), 'al2023'), { recursive: true });
      execFileSync('tar', ['-xf', tarFile, '-C', path.join(os.tmpdir(), 'al2023')]);
      fs.rmSync(tarFile, { force: true });
    }
  }
  return pw.launch({
    executablePath: exe,
    // --single-process/--no-zygote из набора sparticuz нужны на AWS Lambda, но в обычной
    // песочнице они ломают работу с несколькими browser-контекстами (закрытие контекста
    // роняет весь браузер). Дублирующий headless-флаг тоже убираем — его ставит Playwright.
    args: sparticuz.args.filter((a) => !['--single-process', '--no-zygote', "--headless='shell'"].includes(a)),
    env: { ...process.env, LD_LIBRARY_PATH: libDir },
  });
}

/* ------------------------------ локальный HTTP-сервер ------------------------------ */

function startServer() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT, stdio: 'ignore',
  });
  return server;
}
async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/index.html`);
      if (r.ok) return true;
    } catch { /* сервер ещё поднимается */ }
    await sleep(250);
  }
  return false;
}

/* ------------------------------ сценарии ------------------------------ */

async function scenarioUpload(browser) {
  console.log('\n1. Загрузка скриншота файлом и распознавание');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitAppReady(page);
    await page.click('#tabs [data-tab="shot"]');
    await page.setInputFiles('#shotFile', FIXTURE_SHOT);
    await page.waitForSelector('#shotList', { timeout: 90000 });
    const selects = await page.$$('[data-shot-pick]');
    const filled = await page.$$eval('[data-shot-pick]', (els) => els.filter((e) => e.value).length);
    check(selects.length > 0, `строк результата: ${selects.length}`);
    check(filled >= 10, `уверенно распознано героев в списках: ${filled}`);
    check(/уверенность/.test(await page.textContent('#view')), 'уверенность сетки показана');
    const fillBtn = await page.$('[data-shot="fill-enemies"]');
    check(fillBtn !== null, 'кнопка «В противники» появилась');
    if (fillBtn) {
      await fillBtn.click();
      const notice = await page.textContent('#shotNotice').catch(() => '');
      check(/Добавлено в противники: [1-5]/.test(notice || ''), 'наполнение врагов по распознанным карточкам', notice);
      await page.click('[data-shot="open-draft"]');
      const draftText = await page.textContent('#view');
      check(/Вражеский драфт\s*5\/5/.test(draftText.replace(/\s+/g, ' ')), 'драфт открыт и враги на местах');
    }
  } finally { await ctx.close(); }
}

async function scenarioPaste(browser) {
  console.log('\n2. Вставка изображения событием ClipboardEvent');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitAppReady(page);
    const b64 = fs.readFileSync(FIXTURE_PASTE).toString('base64');
    await page.evaluate((data) => {
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'heroes-tab.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, b64);
    await page.waitForSelector('#shotPreview', { timeout: 15000 });
    const label = await page.textContent('#view');
    check(/вставленный скриншот · 640×427/.test(label || ''), 'вставка распознана, кадр показан с именем и размером',
      (label.match(/вставленный скриншот[^·]*·\s*\S+/) || [''])[0].trim());
    await page.waitForSelector('#shotList', { timeout: 90000 });
    check(true, 'распознавание вставленного кадра завершилось');
  } finally { await ctx.close(); }
}

async function scenarioHeroSelectRemove(browser) {
  console.log('\n3. Выбор героя через пикер и удаление');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitAppReady(page);
    await page.click('[data-pick="me:0"]');
    await page.waitForSelector('#pickerGrid', { state: 'visible', timeout: 10000 });
    // Пикер «мой героя» открывается с фильтром «мидовые» — Axe его не проходит,
    // как и в живом приложении: переключаемся на «все герои».
    const midFiltered = await page.$$eval('#pickerGrid .pick', (els) => els.length);
    check(midFiltered > 10 && midFiltered < 60, `пикер открыт с фильтром «мидовые»: ${midFiltered} героев`);
    await page.click('#pickerChips [data-mid="0"]');
    await page.waitForSelector('[data-choose="axe"]', { state: 'visible', timeout: 10000 });
    await page.click('[data-choose="axe"]');
    check(await page.$('[data-action="clear-me"]') !== null, 'мой герой выбран (появилось «Очистить»)');
    check(/Axe/.test(await page.textContent('#view')), 'Axe в представлении');

    await page.click('[data-pick="me:0"]'); // «Сменить героя»
    await page.waitForSelector('#pickerGrid', { state: 'visible', timeout: 10000 });
    await page.click('#pickerChips [data-mid="0"]');
    await page.waitForSelector('[data-choose="huskar"]', { state: 'visible', timeout: 10000 });
    await page.click('[data-choose="huskar"]');
    check(/Huskar/.test(await page.textContent('#view')), 'герой заменён на Huskar');

    await page.click('[data-pick="enemies:0"]');
    await page.waitForSelector('#pickerGrid', { state: 'visible', timeout: 10000 });
    await page.fill('#pickerSearch', 'riki');
    await page.waitForSelector('[data-choose="riki"]', { state: 'visible', timeout: 10000 });
    await page.click('[data-choose="riki"]');
    check(await page.$('[data-remove="enemies:0"]') !== null, 'враг добавлен в слот (поиск в пикере)');
    await page.click('[data-remove="enemies:0"]');
    check(await page.$('[data-remove="enemies:0"]') === null && await page.$('[data-pick="enemies:0"]') !== null,
      'враг удалён — слот снова пустой');
    await page.click('[data-action="clear-me"]');
    check(await page.$('[data-pick="me:0"]') !== null, 'мой герой очищен — стартовый слот вернулся');
  } finally { await ctx.close(); }
}

async function scenarioShare(browser) {
  console.log('\n4. Ссылка-шаринг: hash ставится и открывается заново');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-action="random"]');
    await page.waitForSelector('[data-action="share"]');
    await page.click('[data-action="share"]');
    await sleep(200);
    const hash = await page.evaluate(() => location.hash);
    check(hash.length > 1, 'hash со ссылкой установлен', hash.slice(0, 48));
    const url = await page.evaluate(() => location.href);
    // Открываем ссылку в свежем контексте — без localStorage: драфт должен восстановиться из hash.
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page2 = await ctx2.newPage();
      await page2.goto(url, { waitUntil: 'domcontentloaded' });
      await page2.waitForSelector('[data-action="clear-me"]', { timeout: 15000 });
      check(await page2.$('[data-action="clear-me"]') !== null, 'по ссылке драфт открыт заново (герой на месте)');
      const sharedChecks = await page2.$$eval('input[data-check]', (els) => els.length).catch(() => 0);
      check(sharedChecks >= 4, `чеклист по ссылке собран: ${sharedChecks} пунктов`);
    } finally { await ctx2.close(); }
  } finally { await ctx.close(); }
}

async function scenarioChecklistReload(browser) {
  console.log('\n5. Галочка чеклиста после перезагрузки страницы');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('[data-action="random"]');
    await page.waitForSelector('input[data-check]', { timeout: 15000 });
    const before = await page.$$('input[data-check]');
    check(before.length >= 4, `пунктов чеклиста: ${before.length}`);
    const key = await before[0].getAttribute('data-check');
    await before[0].click();
    check(await before[0].isChecked(), 'галочка поставлена');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[data-check]', { timeout: 15000 });
    const match = await page.$(`input[data-check="${key}"]`);
    check(match !== null, 'тот же пункт есть после перезагрузки');
    if (match) check(await match.isChecked(), 'галочка сохранилась после перезагрузки');
  } finally { await ctx.close(); }
}

async function scenarioNarrowViewport(browser) {
  console.log('\n6. Узкий экран 390×844');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await waitAppReady(page);
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    check(overflow.scroll <= overflow.inner + 2,
      `нет горизонтального переполнения (scrollWidth ${overflow.scroll} ≤ ${overflow.inner})`);
    await page.click('#tabs [data-tab="items"]');
    await page.waitForSelector('.item-card', { timeout: 15000 });
    check(true, 'вкладка предметов открывается и рендерится');
    const tabsVisible = await page.$eval('#tabs [data-tab="draft"]', (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0;
    });
    check(tabsVisible, 'вкладка «Драфт» видима и нажимаема на узком экране');
    await page.click('#tabs [data-tab="draft"]');
    check(await page.$('[data-action="share"]') !== null, 'черновик доступен на узком экране');
  } finally { await ctx.close(); }
}

/* ------------------------------ запуск ------------------------------ */

let browser = null;
let server = null;
try {
  server = startServer();
  if (!(await waitServer())) throw new Error('локальный HTTP-сервер не поднялся');
  console.log(`HTTP-сервер: ${BASE}`);
  browser = await launchBrowser();
  const version = await browser.version();
  console.log(`Браузер: ${version}`);

  await scenarioUpload(browser);
  await scenarioPaste(browser);
  await scenarioHeroSelectRemove(browser);
  await scenarioShare(browser);
  await scenarioChecklistReload(browser);
  await scenarioNarrowViewport(browser);
} catch (err) {
  check(false, `сценарии выполнены без исключений — ${err.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill('SIGTERM');
}

console.log(failed === 0 ? '\nБраузерные сценарии прошли.\n' : `\nПровалено проверок: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
