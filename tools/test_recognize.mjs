#!/usr/bin/env node
/**
 * test_recognize.mjs — проверка распознавания на синтетических «скриншотах».
 *
 * Склеивает реальные иконки героев в полосу карточек (ImageMagick), затем прогоняет
 * recognizeScreenshot и сверяет ответы. Отдельно проверяет устойчивость к изменению
 * яркости, размытию, сжатию и вставке полосы в большой кадр — то, что бывает
 * на настоящих скриншотах экрана пика.
 *
 * Запуск: node tools/test_recognize.mjs   (нужен ImageMagick)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recognizeScreenshot, recognizeCells, splitRect } from '../assets/recognize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'data', 'icons');
const templates = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'templates.json'), 'utf8')).heroes;

const HEROES = ['axe', 'crystal_maiden', 'invoker', 'pudge', 'sniper', 'queenofpain'];
const CARD = 88; // сторона карточки в «скриншоте»
const GAP = 6;
const PAD = 10;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));

let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};

/**
 * Полоса карточек на тёмном фоне. filters — операции ImageMagick по каждой карточке,
 * post — по всему кадру. rows > 1 раскладывает героев в несколько строк, frame — вставка
 * готовой полосы в кадр заданного размера (как занимает место экран пика в реальном скриншоте).
 */
function makeStrip(heroes, filters = [], { jpeg = false, post = [], rows = 1, frame = null, frameBg = '#151a21' } = {}) {
  const cols = Math.ceil(heroes.length / rows);
  const rowCount = Math.ceil(heroes.length / cols);
  const W = PAD * 2 + cols * CARD + (cols - 1) * GAP;
  const H = PAD * 2 + rowCount * CARD + (rowCount - 1) * GAP;
  const args = ['-size', `${W}x${H}`, 'xc:#0d1016'];
  heroes.forEach((slug, i) => {
    const x = PAD + (i % cols) * (CARD + GAP);
    const y = PAD + Math.floor(i / cols) * (CARD + GAP);
    args.push(
      '(', path.join(ICONS, `${slug}.webp`), '-crop', '144x144+56+0', '+repage',
      '-resize', `${CARD}x${CARD}!`, ...filters, ')',
      '-geometry', `+${x}+${y}`, '-composite',
    );
  });
  const tag = Math.random().toString(36).slice(2);
  const base = path.join(tmp, `strip-${tag}.png`);
  execFileSync('convert', [...args, base], { maxBuffer: 64 * 1024 * 1024 });
  let out = base;
  if (frame || post.length) {
    const next = path.join(tmp, `frame-${tag}.png`);
    if (frame) {
      execFileSync('convert', ['-size', `${frame[0]}x${frame[1]}`, `xc:${frameBg}`, out, '-gravity', 'center', '-composite', ...post, next],
        { maxBuffer: 64 * 1024 * 1024 });
    } else {
      execFileSync('convert', [out, ...post, next], { maxBuffer: 64 * 1024 * 1024 });
    }
    out = next;
  }
  if (!jpeg) return out;
  const jpg = out.replace(/\.png$/, '.jpg');
  execFileSync('convert', [out, '-quality', '72', jpg]);
  return jpg;
}

/** Чтение изображения в ImageData-подобный объект. */
function readImage(file) {
  const dims = execFileSync('identify', ['-format', '%w %h', file]).toString().trim().split(' ').map(Number);
  const data = new Uint8Array(execFileSync('convert', [file, '-depth', '8', 'rgba:-'], { maxBuffer: 256 * 1024 * 1024 }));
  return { width: dims[0], height: dims[1], data };
}

/** Прогон распознавания и сводка точности. */
function run(label, { heroes = HEROES, filters = [], post = [], jpeg = false, manual = false, rows = 1, frame = null } = {}) {
  const file = makeStrip(heroes, filters, { jpeg, post, rows, frame });
  const img = readImage(file);
  const result = manual
    ? { grid: null, cells: null, confidence: 1 }
    : recognizeScreenshot(img, templates, { topK: 3 });
  const cells = manual
    ? splitRect({ x: PAD, y: PAD, w: img.width - 2 * PAD, h: img.height - 2 * PAD }, heroes.length, 1)
    : result.grid.cells;
  if (!cells || cells.length !== heroes.length) {
    check(false, `${label}: ячеек ${cells ? cells.length : 0}, ожидалось ${heroes.length}`,
      result.grid ? `сетка ${result.grid.cols}×${result.grid.rows} (${result.grid.meta.colMode}/${result.grid.meta.rowMode})` : 'сетка не найдена');
    return;
  }
  const results = manual ? recognizeCells(img, cells, templates, { topK: 3 }) : result.cells;
  const misses = [];
  let top1 = 0;
  let top3 = 0;
  results.forEach((r, i) => {
    const slugs = r.candidates.map((c) => c.slug);
    if (slugs[0] === heroes[i]) top1++;
    else misses.push(`${heroes[i]} → ${slugs[0]} (${r.candidates[0].score})`);
    if (slugs.includes(heroes[i])) top3++;
  });
  const gridInfo = manual ? 'ячейки заданы вручную'
    : `${result.grid.cols}×${result.grid.rows} ${result.grid.meta.colMode}/${result.grid.meta.rowMode}, уверенность ${result.confidence.toFixed(2)}`;
  check(top1 === heroes.length, `${label} [${gridInfo}]: верхняя догадка ${top1}/${heroes.length}`, misses.slice(0, 3).join('; '));
  check(top3 === heroes.length, `${label} [${gridInfo}]: в топ-3 ${top3}/${heroes.length}`);
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nРаспознавание работает.\n' : `\nПровалено проверок: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
