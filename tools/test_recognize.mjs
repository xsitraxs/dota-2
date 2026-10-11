#!/usr/bin/env node
/**
 * test_recognize.mjs — проверка распознавания на синтетических «скриншотах».
 *
 * Склеивает реальные иконки героев в полосу карточек (ImageMagick), затем прогоняет
 * recognizeScreenshot и сверяет ответы. Проверяет устойчивость к изменению яркости, размытию,
 * сжатию и вставке полосы в большой кадр — то, что бывает на настоящих скриншотах экрана пика, —
 * и то, чего распознавание делать не должно: выдавать пустой слот, постороннюю картинку или героя
 * без шаблона (как Ring Master, Kez, Largo) за уверенно распознанного.
 *
 * Сквозной инвариант всех разделов: ячейка со статусом «ok» всегда содержит верного героя.
 * Ограничение: это синтетика из тех же иконок, что и шаблоны; настоящих скриншотов экрана пика
 * в репозитории нет, поэтому качество на реальных кадрах этим тестом не измеряется.
 *
 * Запуск: node tools/test_recognize.mjs   (нужен ImageMagick: convert из IM6 или magick из IM7)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  recognizeScreenshot, recognizeCells, splitRect, sampleRect, manualCells, clampRegion, clampGridSize, classifyMatch,
  MAX_GRID, MATCH_MAX_SCORE, MATCH_MIN_MARGIN, MATCH_MAX_RATIO,
} from '../assets/recognize.js';
import { convert, readImage, imageMagickAvailable } from './imagemagick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'data', 'icons');
const templates = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'templates.json'), 'utf8')).heroes;

const HEROES = ['axe', 'crystal_maiden', 'invoker', 'pudge', 'sniper', 'queenofpain'];
const CARD = 88; // сторона карточки в «скриншоте»
const GAP = 6;
const PAD = 10;

if (!imageMagickAvailable) {
  console.error('Нужен ImageMagick (convert или magick) — тест распознавания собирает кадры им.');
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));

let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};

/** Сквозной учёт: сколько ячеек было принято уверенно и сколько из них — неверно. */
const safety = { accepted: 0, wrong: [] };
/** expected[i] — герой ячейки или null (пусто/не герой/нет шаблона): «ok» допустим только на своём герое. */
function audit(label, cells, expected) {
  cells.forEach((c, i) => {
    if (c.status !== 'ok') return;
    safety.accepted++;
    if (c.slug !== expected[i]) safety.wrong.push(`${label}#${i + 1}: ${c.slug} вместо ${expected[i] ?? 'пусто'}`);
  });
}

/* ------------------------------ сборка кадров ------------------------------ */

let seq = 0;
const file = (ext = 'png') => path.join(tmp, `img-${++seq}.${ext}`);

/** Источник карточки: слаг героя, null — пустой слот, 'framed' — пустой слот с рамкой,
 *  'noisy' — пустой слот с шумом, 'rose:'/'logo:' — встроенные картинки ImageMagick (не герои). */
function cardSource(slot, size, filters = []) {
  if (slot === null) return ['-size', `${size}x${size}`, 'xc:#2a3140'];
  if (slot === 'framed') {
    return ['-size', `${size}x${size}`, 'xc:#20262f', '-fill', 'none', '-stroke', '#6a7280', '-strokewidth', '2',
      '-draw', `rectangle 1,1 ${size - 2},${size - 2}`];
  }
  if (slot === 'noisy') return ['-size', `${size}x${size}`, 'xc:#2a3140', '-attenuate', '0.5', '+noise', 'Gaussian'];
  if (slot.endsWith(':')) return [slot, '-resize', `${size}x${size}!`];
  return [path.join(ICONS, `${slot}.webp`), '-crop', '144x144+56+0', '+repage', '-resize', `${size}x${size}!`, ...filters];
}

/**
 * Полоса карточек на тёмном фоне. filters — операции ImageMagick по каждой карточке,
 * post — по всему кадру. rows > 1 раскладывает героев в несколько строк, frame — вставка
 * готовой полосы в кадр заданного размера (как занимает место экран пика в реальном скриншоте).
 */
function makeStrip(slots, filters = [], { jpeg = false, post = [], rows = 1, frame = null, frameBg = '#151a21', card = CARD } = {}) {
  const cols = Math.ceil(slots.length / rows);
  const rowCount = Math.ceil(slots.length / cols);
  const W = PAD * 2 + cols * card + (cols - 1) * GAP;
  const H = PAD * 2 + rowCount * card + (rowCount - 1) * GAP;
  const args = ['-size', `${W}x${H}`, 'xc:#0d1016'];
  slots.forEach((slot, i) => {
    const x = PAD + (i % cols) * (card + GAP);
    const y = PAD + Math.floor(i / cols) * (card + GAP);
    args.push('(', ...cardSource(slot, card, filters), ')', '-geometry', `+${x}+${y}`, '-composite');
  });
  let out = file();
  convert([...args, '-alpha', 'off', out]);
  if (frame || post.length) {
    const next = file();
    if (frame) convert(['-size', `${frame[0]}x${frame[1]}`, `xc:${frameBg}`, out, '-gravity', 'center', '-composite', ...post, next]);
    else convert([out, ...post, next]);
    out = next;
  }
  if (!jpeg) return out;
  const jpg = file('jpg');
  convert([out, '-quality', '72', jpg]);
  return jpg;
}

/** Прогон распознавания и сводка точности. */
function run(label, { heroes = HEROES, filters = [], post = [], jpeg = false, manual = false, rows = 1, frame = null } = {}) {
  const img = readImage(makeStrip(heroes, filters, { jpeg, post, rows, frame }));
  const result = manual
    ? { grid: null, cells: null, confidence: 1 }
    : recognizeScreenshot(img, templates, { topK: 3 });
  const cells = manual
    ? splitRect({ x: PAD, y: PAD, w: img.width - 2 * PAD, h: img.height - 2 * PAD }, heroes.length, 1)
    : result.grid && result.grid.cells;
  if (!cells || cells.length !== heroes.length) {
    check(false, `${label}: ячеек ${cells ? cells.length : 0}, ожидалось ${heroes.length}`,
      result.grid ? `сетка ${result.grid.cols}×${result.grid.rows} (${result.grid.meta.colMode}/${result.grid.meta.rowMode})` : 'сетка не найдена');
    return;
  }
  const results = manual ? recognizeCells(img, cells, templates, { topK: 3 }) : result.cells;
  audit(label, results, heroes);
  const misses = [];
  let top1 = 0;
  let top3 = 0;
  results.forEach((r, i) => {
    const slugs = r.candidates.map((c) => c.slug);
    if (slugs[0] === heroes[i]) top1++;
    else misses.push(`${heroes[i]} → ${slugs[0]} (${r.candidates[0] ? r.candidates[0].score : '—'})`);
    if (slugs.includes(heroes[i])) top3++;
  });
  const sure = results.filter((r, i) => r.status === 'ok' && r.slug === heroes[i]).length;
  const gridInfo = manual ? 'ячейки заданы вручную'
    : `${result.grid.cols}×${result.grid.rows} ${result.grid.meta.colMode}/${result.grid.meta.rowMode}, уверенность ${result.confidence.toFixed(2)}`;
  check(top1 === heroes.length, `${label} [${gridInfo}]: верхняя догадка ${top1}/${heroes.length}`, misses.slice(0, 3).join('; '));
  check(top3 === heroes.length, `${label} [${gridInfo}]: в топ-3 ${top3}/${heroes.length}`);
  check(sure === heroes.length, `${label}: уверенно распознаны (статус ok) ${sure}/${heroes.length}`,
    results.filter((r) => r.status !== 'ok').map((r) => `${r.status} ${r.candidates[0] ? `${r.candidates[0].slug}:${r.candidates[0].score}/m${r.margin}` : ''}`).join('; '));
}

const statusLine = (cells) => cells.map((c) => (c.status === 'ok' ? c.slug : c.status)).join(' | ');

/**
 * Какой герой на самом деле под центром ячейки (по геометрии полосы makeStrip): так проверка
 * «ok ⇒ верный герой» не зависит от ответа распознавания. dx — сдвиг кадра (если его обрезали),
 * k — масштаб кадра; не-герои (пустые слоты, посторонние картинки) дают null.
 */
function truthAt(cells, slots, { dx = 0, k = 1, card = CARD } = {}) {
  return cells.map((c) => {
    const cx = (c.x + c.w / 2) / k - dx;
    const cy = (c.y + c.h / 2) / k;
    const i = Math.floor((cx - PAD) / (card + GAP));
    const inCard = i >= 0 && i < slots.length && cx - PAD - i * (card + GAP) <= card && cy >= PAD && cy <= PAD + card;
    const slot = inCard ? slots[i] : null;
    return slot && fs.existsSync(path.join(ICONS, `${slot}.webp`)) ? slot : null;
  });
}

console.log('\n1. Автопоиск сетки на полосе карточек');
run('полоса 6 карточек', {});

console.log('\n2. Устойчивость к обработке скриншота');
run('пониженная яркость', { filters: ['-brightness-contrast', '-18x0'] });
run('повышенный контраст', { filters: ['-brightness-contrast', '8x22'] });
run('лёгкое размытие', { filters: ['-blur', '0x1.2'] });
run('JPEG q=72', { jpeg: true });
run('масштаб 55%', { post: ['-resize', '55%'] });
run('лёгкий шум', { post: ['+noise', 'Gaussian', '-attenuate', '0.6'] });

console.log('\n3. Другая выборка героев (полоса 5)');
run('незнакомый набор', { heroes: ['antimage', 'lion', 'storm_spirit', 'oracle', 'tidehunter'] });

console.log('\n4. Кадр как на настоящем экране пика');
run('полоса в большом кадре', { frame: [960, 540] });
run('две строки карточек', { rows: 2 });
run('яркость + JPEG', { filters: ['-brightness-contrast', '-14x0'], jpeg: true });
run('пять карточек в большом кадре', { heroes: ['antimage', 'lion', 'storm_spirit', 'oracle', 'tidehunter'], frame: [1280, 720] });

console.log('\n5. Ручная нарезка (когда автопоиск не применим)');
run('то же полоса, но ячейки заданы руками', { manual: true });

console.log('\n6. Пустые слоты и частично заполненный драфт');
{
  // Начало драфта: две карточки и восемь пустых слотов. Раньше каждый пустой слот (с краешком
  // фона в ячейке) «уверенно» узнавался как Sven с близостью ~0.15.
  const slots = ['axe', 'invoker', null, null, null, null, null, null, null, null];
  const img = readImage(makeStrip(slots));
  const r = recognizeScreenshot(img, templates, { topK: 5 });
  const cells = r.cells;
  audit('начало драфта', cells, truthAt(cells.map((c) => c.rect), slots));
  check(r.grid !== null && cells.length >= 9, `сетка найдена: ${r.grid ? `${r.grid.cols}×${r.grid.rows}` : 'нет'}`, statusLine(cells));
  check(cells[0].status === 'ok' && cells[0].slug === 'axe' && cells[1].status === 'ok' && cells[1].slug === 'invoker', 'оба героя распознаны уверенно');
  check(cells.slice(2).every((c) => c.status === 'empty' && c.candidates.length === 0), 'пустые слоты — «empty», без кандидатов (не Sven)');

  const mixed = ['axe', null, 'invoker', 'framed', 'noisy', 'sniper'];
  const mImg = readImage(makeStrip(mixed));
  const manualRes = recognizeCells(mImg, splitRect({ x: PAD, y: PAD, w: mImg.width - 2 * PAD, h: CARD }, mixed.length, 1), templates, { topK: 5 });
  audit('ручная нарезка с пустыми', manualRes, mixed.map((s) => (s && !['framed', 'noisy'].includes(s) ? s : null)));
  check(statusLine(manualRes) === 'axe | empty | invoker | empty | empty | sniper',
    'ручная нарезка: пустой, с рамкой и с шумом слоты — пустые, герои — уверенно', statusLine(manualRes));
  const autoRes = recognizeScreenshot(mImg, templates, { topK: 5 });
  audit('автопоиск с пустыми', autoRes.cells, truthAt(autoRes.cells.map((c) => c.rect), mixed));
  const found = autoRes.cells.filter((c) => c.status === 'ok').map((c) => c.slug);
  check(['axe', 'invoker', 'sniper'].every((s) => found.includes(s)) && found.every((s) => ['axe', 'invoker', 'sniper'].includes(s)),
    `автопоиск: найдены ровно настоящие герои (${found.join(', ')})`, statusLine(autoRes.cells));

  const two = readImage(makeStrip(['lion', 'oracle'], [], { frame: [1280, 720] }));
  const twoRes = recognizeScreenshot(two, templates, { topK: 5 });
  audit('две карточки в кадре', twoRes.cells, ['lion', 'oracle']);
  check(statusLine(twoRes.cells) === 'lion | oracle', 'частичная сетка: две карточки в большом кадре', statusLine(twoRes.cells));
}

console.log('\n7. Неузнаваемые карточки: слабое совпадение не выдаётся за распознанного героя');
{
  // Герой без шаблона (как Ring Master, Kez, Largo): убираем шаблоны двух героев полосы.
  const partial = { ...templates };
  delete partial.invoker;
  delete partial.sniper;
  const img = readImage(makeStrip(HEROES));
  const r = recognizeScreenshot(img, partial, { topK: 5 });
  audit('нет шаблона', r.cells, HEROES.map((s) => (partial[s] ? s : null)));
  check(r.cells[2].status === 'weak' && r.cells[2].slug === null && r.cells[4].status === 'weak',
    'карточки героев без шаблона — «weak» (не определён), подсказки остаются', statusLine(r.cells));
  check(['axe', 'crystal_maiden', 'pudge', 'queenofpain'].every((s, k) => r.cells[[0, 1, 3, 5][k]].slug === s), 'остальные распознаны уверенно');

  // Leave-one-out: каждая из 24 карточек сверяется с шаблонами без её героя — «чужой» не принимается.
  const sample = Object.keys(templates).sort().filter((_, i) => i % 5 === 0).slice(0, 24);
  let impostors = 0;
  for (let i = 0; i < sample.length; i += 6) {
    const group = sample.slice(i, i + 6);
    const gImg = readImage(makeStrip(group));
    group.forEach((hero, j) => {
      const without = { ...templates };
      delete without[hero];
      const [cell] = recognizeCells(gImg, [{ x: PAD + j * (CARD + GAP), y: PAD, w: CARD, h: CARD }], without, { topK: 5 });
      if (cell.status === 'ok') { impostors++; safety.accepted++; safety.wrong.push(`без шаблона ${hero} → ${cell.slug}`); }
    });
  }
  check(impostors === 0, `чужой герой не принимается: ${sample.length} карточек без своего шаблона, уверенных ответов ${impostors}`);

  // Посторонние картинки: встроенные изображения ImageMagick и надписи вместо карточек.
  const junk = ['rose:', 'logo:', 'granite:', 'netscape:'];
  const jImg = readImage(makeStrip(junk));
  const jRes = recognizeCells(jImg, junk.map((_, j) => ({ x: PAD + j * (CARD + GAP), y: PAD, w: CARD, h: CARD })), templates, { topK: 5 });
  audit('посторонние картинки', jRes, junk.map(() => null));
  check(jRes.every((c) => c.status !== 'ok'), `картинки-не-герои не принимаются за героев: ${statusLine(jRes)}`);
  const font = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/Library/Fonts/Arial.ttf', 'C:/Windows/Fonts/arial.ttf']
    .find((f) => fs.existsSync(f));
  if (font) {
    const labels = ['BAN', 'PICK', 'Radiant', 'VS'];
    const tImg = labels.map((t) => {
      const f = file();
      convert(['-size', `${CARD}x${CARD}`, 'xc:#1b2230', '-font', font, '-fill', '#d3a84c', '-pointsize', '22', '-gravity', 'center', '-annotate', '+0+0', t, '-alpha', 'off', f]);
      return readImage(f);
    });
    const tRes = tImg.map((im) => recognizeCells(im, [{ x: 0, y: 0, w: im.width, h: im.height }], templates, { topK: 5 })[0]);
    audit('надписи', tRes, labels.map(() => null));
    check(tRes.every((c) => c.status !== 'ok'), `надписи экрана пика («BAN», «Radiant»…) не принимаются за героев: ${statusLine(tRes)}`);
  } else {
    console.log('    (шрифт для надписей не найден — проверка надписей пропущена)');
  }

  // Сильное размытие: уверенность падает, но принятый ответ обязан быть верным.
  const blurred = readImage(makeStrip(HEROES, ['-blur', '0x5']));
  const bRes = recognizeScreenshot(blurred, templates, { topK: 5 });
  audit('сильное размытие', bRes.cells, HEROES);
  check(bRes.cells.length === HEROES.length && bRes.cells.every((c, i) => c.status !== 'ok' || c.slug === HEROES[i]),
    `сильное размытие: принятые ответы верны (${statusLine(bRes.cells)})`);
}

console.log('\n8. Обрезанные карточки и неверная рамка');
{
  const strip = makeStrip(HEROES);
  const full = readImage(strip);
  // Кадр обрезан посередине крайних карточек: от них остались половины.
  const cutFile = file();
  convert([strip, '-crop', `${full.width - 2 * (PAD + CARD / 2)}x${full.height}+${PAD + CARD / 2}+0`, '+repage', cutFile]);
  const cut = recognizeScreenshot(readImage(cutFile), templates, { topK: 5 });
  audit('обрезанные края', cut.cells, truthAt(cut.cells.map((c) => c.rect), HEROES, { dx: -(PAD + CARD / 2) }));
  const cutOk = cut.cells.filter((c) => c.status === 'ok').map((c) => c.slug);
  check(cutOk.length >= 2 && cutOk.every((s) => HEROES.slice(1, 5).includes(s)) && new Set(cutOk).size === cutOk.length,
    `обрезанный кадр: уверенно — только целые карточки (${cutOk.join(', ')})`, statusLine(cut.cells));

  // Рамка сдвинута на полкарточки и на четверть: ячейки режут по две карточки сразу.
  for (const [label, dx] of [['на полкарточки', (CARD + GAP) / 2], ['на четверть карточки', (CARD + GAP) / 4]]) {
    const cells = splitRect({ x: PAD + dx, y: PAD, w: 5 * (CARD + GAP), h: CARD }, 5, 1);
    const res = recognizeCells(full, cells, templates, { topK: 5 });
    audit(`сдвиг ${label}`, res, res.map(() => null));
    check(res.every((c) => c.status !== 'ok'), `рамка сдвинута ${label}: ни одна ячейка не выдана за героя`, statusLine(res));
  }
  // Рамка ровно по карточкам, но в 2 раза мельче (половинки портретов).
  const halves = recognizeCells(full, splitRect({ x: PAD, y: PAD, w: full.width - 2 * PAD, h: CARD }, 12, 1), templates, { topK: 5 });
  audit('половинки', halves, halves.map(() => null));
  check(halves.every((c) => c.status !== 'ok'), 'половинки портретов не выдаются за героев', statusLine(halves));
}

console.log('\n9. Размеры кадра и пустой результат поиска');
{
  for (const card of [40, 160]) {
    const img = readImage(makeStrip(HEROES, [], { card }));
    const r = recognizeScreenshot(img, templates, { topK: 5 });
    audit(`карточки ${card}px`, r.cells, HEROES);
    check(statusLine(r.cells) === HEROES.join(' | '), `карточки ${card}×${card} px (кадр ${img.width}×${img.height})`, statusLine(r.cells));
  }
  const big = readImage(makeStrip(HEROES, [], { frame: [2400, 1350] }));
  const t0 = Date.now();
  const rb = recognizeScreenshot(big, templates, { topK: 5 });
  audit('большой кадр', rb.cells, HEROES);
  check(statusLine(rb.cells) === HEROES.join(' | '), `кадр 2400×1350: полоса найдена за ${Date.now() - t0} мс`, statusLine(rb.cells));

  const blank = { width: 640, height: 360, data: new Uint8Array(640 * 360 * 4).fill(40) };
  const rBlank = recognizeScreenshot(blank, templates);
  check(rBlank.grid === null && rBlank.cells.length === 0, 'однотонный кадр: сетки нет (а не «сетка» из пустых ячеек)');
  const noiseFile = file();
  convert(['-seed', '7', '-size', '640x360', 'xc:gray', '+noise', 'Random', noiseFile]);
  const rNoise = recognizeScreenshot(readImage(noiseFile), templates, { topK: 5 });
  audit('шум', rNoise.cells, rNoise.cells.map(() => null));
  check(rNoise.cells.every((c) => c.status !== 'ok'), `кадр из шума: героев не «найдено» (ячеек ${rNoise.cells.length})`);
  const tiny = { width: 12, height: 12, data: new Uint8Array(12 * 12 * 4).fill(90) };
  const rTiny = recognizeScreenshot(tiny, templates);
  check(rTiny.grid === null && rTiny.cells.length === 0, 'кадр 12×12: сетки нет, без исключений');
  const strip = readImage(makeStrip(HEROES));
  const noTpl = recognizeScreenshot(strip, {});
  const noTplCell = recognizeCells(strip, [{ x: PAD, y: PAD, w: CARD, h: CARD }], {})[0];
  check(noTpl.grid === null && noTplCell.status === 'weak' && noTplCell.candidates.length === 0, 'без шаблонов: сетки нет, ячейка «weak», без исключений');
  const broken = { axe: ['zz'], invoker: 'not-a-list', ...Object.fromEntries(Object.entries(templates).slice(0, 3)) };
  check(recognizeCells(strip, [{ x: PAD, y: PAD, w: CARD, h: CARD }], broken).length === 1, 'испорченные записи шаблонов пропускаются, а не роняют распознавание');
  let threw = '';
  try { recognizeScreenshot({ width: 10, height: 10, data: new Uint8Array(3) }, templates); } catch (err) { threw = err.message; }
  check(/нужен кадр/.test(threw), 'неверный кадр — понятная ошибка, а не сбой в глубине', threw);
}

console.log('\n10. Границы ручной области, колонки и строки');
{
  const img = readImage(makeStrip(HEROES));
  const W = img.width;
  const H = img.height;
  const inside = (cells) => cells.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= W + 1e-6 && c.y + c.h <= H + 1e-6 && c.w > 0 && c.h > 0);
  const over = manualCells(img, { x: 300, y: 10, w: 5000, h: 5000 }, 1000, 3);
  check(over.length === MAX_GRID * 3 && inside(over), `область за краем кадра обрезается, колонки ограничены ${MAX_GRID}: ячеек ${over.length}`);
  const r1 = clampRegion({ x: -50, y: 'abc', w: -10, h: 0 }, W, H);
  check(r1.x === 0 && r1.y === 0 && r1.w === W && r1.h === H, `отрицательные и нечисловые поля → весь кадр (${JSON.stringify(r1)})`);
  const r2 = clampRegion({ x: 1e9, y: 1e9, w: 5, h: 5 }, W, H);
  check(r2.x === W - 1 && r2.y === H - 1 && r2.w === 1 && r2.h === 1, `угол за пределами кадра прижимается к краю (${JSON.stringify(r2)})`);
  const r3 = clampRegion({ x: 10, y: 10, w: 300, h: 108 }, W, H);
  check(r3.y + r3.h <= H && r3.x + r3.w <= W && r3.w === 300, `высота, выходящая за кадр, урезается (${JSON.stringify(r3)})`);
  check([0, -3, 'x', NaN, 2.6, 25, 1000].map((v) => clampGridSize(v, 1)).join(',') === `1,1,1,1,3,${MAX_GRID},${MAX_GRID}`, 'колонки/строки — целые от 1 до MAX_GRID');
  const outside = recognizeCells(img, [{ x: W + 50, y: 0, w: CARD, h: CARD }, { x: NaN, y: 0, w: CARD, h: CARD }], templates);
  check(outside.every((c) => c.status === 'empty'), 'ячейка целиком вне кадра — пустая (раньше читались пиксели соседних строк)');
  const s = sampleRect(img, { x: W + 10, y: 5, w: 20, h: 20 });
  check(s.outside === true && s.flat === true, 'выборка вне кадра помечена outside');
  const exact = recognizeCells(img, manualCells(img, { x: PAD, y: PAD, w: W - 2 * PAD, h: CARD }, HEROES.length, 1), templates, { topK: 5 });
  audit('ручная область', exact, HEROES);
  check(statusLine(exact) === HEROES.join(' | '), 'ручная область точно по карточкам распознаётся целиком', statusLine(exact));
}

console.log('\n11. Правило уверенности');
{
  const c = (scores) => scores.map((score, i) => ({ slug: `h${i}`, score }));
  check(classifyMatch(c([0.08, 0.31])).status === 'ok', 'близкое и однозначное совпадение — ok');
  check(classifyMatch(c([MATCH_MAX_SCORE + 0.01, 0.6])).status === 'weak', `близость хуже ${MATCH_MAX_SCORE} — weak`);
  check(classifyMatch(c([0.2, 0.2 + MATCH_MIN_MARGIN - 0.01])).status === 'weak', `отрыв меньше ${MATCH_MIN_MARGIN} — weak`);
  check(classifyMatch(c([0.232, 0.293])).status === 'weak', `отношение близостей выше ${MATCH_MAX_RATIO} (как у надписей и узоров) — weak`);
  check(classifyMatch([]).status === 'weak' && classifyMatch([]).slug === null, 'без кандидатов — weak, героя нет');
}

console.log('\n12. Сквозной инвариант');
check(safety.wrong.length === 0, `уверенных ответов во всех разделах: ${safety.accepted}, из них неверных: ${safety.wrong.length}`, safety.wrong.slice(0, 5).join('; '));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nРаспознавание работает.\n' : `\nПровалено проверок: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
