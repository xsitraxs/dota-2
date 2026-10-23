#!/usr/bin/env node
/**
 * test_recognize_fixtures.mjs — проверка распознавания на РЕАЛЬНЫХ скриншотах экранов драфта.
 *
 * test_recognize.mjs собирает кадры из тех же иконок, что и шаблоны, и доказывает
 * устойчивость алгоритма; здесь другой вопрос: как алгоритм ведёт себя на настоящих
 * игровых кадрах с чужой компрессией, масштабом и раскладкой. Метрики считаются
 * раздельно, как в аудите:
 *   1) обнаружение сетки — найдена ли обязательная сетка и с нужным числом колонок;
 *   2) точность героев — по подписанным карточкам: покрытие сеткой, доля уверенных
 *      ответов и точность среди них (уверенный ответ обязан совпасть с истиной);
 *   3) ложные срабатывания — confident-ответы на пустых слотах, подписях и фоне.
 *
 * Промах автопоиска на кадре с разрозненными блоками (grid.required=false) фиксируется
 * в метрике, но не роняет тест: приложение для таких кадров опирается на ручную нарезку.
 * Отсутствие уверенно неверных ответов обязательно на всех кадрах.
 *
 * Запуск: node tools/test_recognize_fixtures.mjs   (нужен ImageMagick)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeScreenshot } from '../assets/recognize.js';
import { readImage, imageMagickAvailable } from './imagemagick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tools', 'rec_fixtures');
const templates = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'templates.json'), 'utf8')).heroes;

if (!imageMagickAvailable) {
  console.error('Нужен ImageMagick (convert или magick) — тест читает фикстуры им.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));
let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};

const centerIn = (rect, cell) => {
  const r = cell.rect || cell;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
};

console.log('\nРеальные скриншоты (tools/rec_fixtures)');
const totals = { fixtures: 0, gridRequired: 0, gridOk: 0, gridMisses: [], labeled: 0, covered: 0, answered: 0, correct: 0, wrong: [], emptyChecks: 0, fp: [], outsideOk: 0 };

for (const fx of manifest.fixtures) {
  totals.fixtures++;
  const file = path.join(FIXTURES, fx.file);
  if (!fs.existsSync(file)) {
    check(false, `${fx.file}: файл фикстуры есть`);
    continue;
  }
  const unknown = fx.heroes.filter((h) => !templates[h.slug]);
  check(unknown.length === 0, `${fx.file}: все слаги есть в шаблонах`, unknown.map((h) => h.slug).join(', '));

  const img = readImage(file);
  const res = recognizeScreenshot(img, templates, { topK: 5 });
  const gridInfo = res.grid ? `${res.grid.cols}×${res.grid.rows} (${res.grid.meta.colMode}/${res.grid.meta.rowMode})` : 'не найдена';

  // 1. Обнаружение сетки.
  const required = fx.grid?.required === true;
  if (required) {
    totals.gridRequired++;
    const found = res.grid !== null;
    const colsOk = found && (!fx.grid.cols || res.grid.cols === fx.grid.cols);
    check(found && colsOk, `${fx.file}: обязательная сетка найдена — ${gridInfo}`,
      fx.grid.cols && found ? `ожидалось колонок: ${fx.grid.cols}` : '');
    if (found && colsOk) totals.gridOk++;
    else totals.gridMisses.push(fx.file);
  } else if (res.grid) {
    totals.gridMisses.push(`${fx.file} (авто: ${gridInfo}, необязательная)`);
  }

  const cells = res.cells;
  let covered = 0;
  let answered = 0;
  let correct = 0;
  for (const hero of fx.heroes) {
    totals.labeled++;
    const cell = cells.find((c) => centerIn(hero, c));
    if (!cell) continue;
    covered++;
    totals.covered++;
    if (cell.status !== 'ok') continue;
    answered++;
    totals.answered++;
    if (cell.slug === hero.slug) { correct++; totals.correct++; }
    else { totals.wrong.push(`${fx.file} @${hero.x},${hero.y}: ${cell.slug} вместо ${hero.slug}`); }
  }
  // 2. Точность героев по этому кадру (сверяется ниже сводно и по обязательным кадрам).
  check(!required || covered === fx.heroes.length, `${fx.file}: сетка покрывает все подписи (${covered}/${fx.heroes.length})`);
  check(!required || answered >= (fx.minAnswered || 0),
    `${fx.file}: уверенно распознано не меньше ${fx.minAnswered || 0} из ${fx.heroes.length} подписей`,
    `покрыто сеткой ${covered}, ответили уверенно ${answered}, верно ${correct}`);

  // 3. Ложные срабатывания на пустых областях + счётчики вне разметки.
  let fp = 0;
  for (const empty of fx.empty) {
    for (const c of cells) {
      if (centerIn(empty, c)) {
        totals.emptyChecks++;
        if (c.status === 'ok') { fp++; totals.fp.push(`${fx.file} @${empty.x},${empty.y}: ${c.slug}`); }
      }
    }
  }
  for (const c of cells) {
    if (c.status !== 'ok') continue;
    const onHero = fx.heroes.some((h) => centerIn(h, c));
    const onEmpty = fx.empty.some((e) => centerIn(e, c));
    if (!onHero && !onEmpty) totals.outsideOk++;
  }
  check(fp === 0, `${fx.file}: ложных срабатываний на пустых областях нет`, `${fp}`);
  console.log(`    → ${fx.file} (${img.width}×${img.height}): сетка ${gridInfo}; подписей ${fx.heroes.length}, покрыто ${covered}, уверенно ${answered}; проверок пустых областей ${fx.empty.length}`);
}

console.log('\nСводные метрики на реальных кадрах');
const acc = totals.answered ? `${totals.correct}/${totals.answered} (${Math.round(100 * totals.correct / totals.answered)}%)` : '—';
check(totals.gridOk === totals.gridRequired, `сетка: найдена ${totals.gridOk} из ${totals.gridRequired} обязательных`,
  totals.gridMisses.length ? `не найдены/вне ожидания: ${totals.gridMisses.join('; ')}` : '');
check(totals.wrong.length === 0, `герои: подписанных карточек ${totals.labeled}, покрыто сеткой ${totals.covered}, уверенных ответов ${totals.answered}, из них верных ${totals.correct} — точность ${acc}`,
  totals.wrong.slice(0, 5).join('; '));
check(totals.fp.length === 0, `ложные срабатывания на пустых ячейках: ${totals.fp.length} (проверок пустых областей: ${totals.emptyChecks})`,
  totals.fp.slice(0, 5).join('; '));
console.log(`    (уверенных ответов вне разметки — ${totals.outsideOk}: на неподписанных карточках; в зачёт идут только подписанные)`);

console.log(failed === 0 ? '\nРаспознавание на реальных кадрах работает.\n' : `\nПровалено проверок: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
