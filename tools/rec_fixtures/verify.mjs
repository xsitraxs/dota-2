#!/usr/bin/env node
/** Временный инструмент разметки: распознаёт фикстуры и собирает монтажи «ячейка | кандидаты»
 *  для ручной проверки подписей. Не часть тестов. Запуск: node tools/rec_fixtures/verify.mjs */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeScreenshot } from '../../assets/recognize.js';
import { readImage, convert } from '../imagemagick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const templates = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'templates.json'), 'utf8')).heroes;
const icons = path.join(ROOT, 'data', 'icons');
const out = '/tmp/verify';
fs.mkdirSync(out, { recursive: true });

const which = process.argv[2] || 'draft-strip';
const file = ['jpg', 'png'].map((e) => path.join(ROOT, 'tools', 'rec_fixtures', `${which}.${e}`)).find((f) => fs.existsSync(f));
const img = readImage(file);
const r = recognizeScreenshot(img, templates, { topK: 5 });
console.log(which, img.width, 'x', img.height, 'grid:', r.grid ? `${r.grid.cols}x${r.grid.rows} conf ${r.confidence.toFixed(2)}` : 'НЕТ');
if (!r.grid) process.exit(2);
console.log('cells:', r.cells.length);

r.cells.forEach((c, i) => {
  const cand = c.candidates.map((k) => `${k.slug}:${k.score.toFixed(3)}`).join(' ');
  console.log(`#${i} [${c.rect.x},${c.rect.y} ${c.rect.w}x${c.rect.h}] ${c.status} ${c.slug ?? '-'} | ${cand}`);
  const parts = [];
  const crop = `/tmp/verify/cell-${i}.png`;
  convert([file, '-crop', `${c.rect.w}x${c.rect.h}+${Math.round(c.rect.x)}+${Math.round(c.rect.y)}`, '+repage',
    '-resize', '120x120!', crop]);
  parts.push(crop);
  for (const k of c.candidates) {
    const ic = `/tmp/verify/cell-${i}-${k.slug}.png`;
    convert([path.join(icons, `${k.slug}.webp`), '-crop', '144x144+56+0', '+repage', '-resize', '120x120!', ic]);
    parts.push(ic);
  }
  if (parts.length > 1) {
    convert([...parts.map((p) => ['(', p, ')']).flat(), '+append', '-background', '#111', `/tmp/verify/row-${i}.png`]);
  }
});
