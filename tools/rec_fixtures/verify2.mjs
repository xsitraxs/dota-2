#!/usr/bin/env node
/** Разметка вручную заданных ячеек: кандидаты + монтажи для визуальной проверки.
 *  Запуск: node tools/rec_fixtures/verify2.mjs <имя> '<rects json>'  */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recognizeCells } from '../../assets/recognize.js';
import { readImage, convert } from '../imagemagick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const templates = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'templates.json'), 'utf8')).heroes;
const icons = path.join(ROOT, 'data', 'icons');
fs.mkdirSync('/tmp/verify', { recursive: true });

const which = process.argv[2];
const rects = JSON.parse(process.argv[3]);
const file = ['jpg', 'png'].map((e) => path.join(ROOT, 'tools', 'rec_fixtures', `${which}.${e}`)).find((f) => fs.existsSync(f));
const img = readImage(file);
const cells = recognizeCells(img, rects, templates, { topK: 5 });
cells.forEach((c, i) => {
  console.log(`#${i} [${Math.round(rects[i].x)},${Math.round(rects[i].y)} ${rects[i].w}x${rects[i].h}] ${c.status} ${c.slug ?? '-'} | ${c.candidates.map((k) => `${k.slug}:${k.score.toFixed(3)}`).join(' ')}`);
  const parts = [];
  const crop = `/tmp/verify/s${i}.png`;
  convert([file, '-crop', `${Math.round(rects[i].w)}x${Math.round(rects[i].h)}+${Math.round(rects[i].x)}+${Math.round(rects[i].y)}`, '+repage', '-resize', '130x130!', crop]);
  parts.push(crop);
  for (const k of c.candidates) {
    const ic = `/tmp/verify/s${i}-${k.slug}.png`;
    convert([path.join(icons, `${k.slug}.webp`), '-crop', '144x144+56+0', '+repage', '-resize', '130x130!', ic]);
    parts.push(ic);
  }
  if (parts.length > 1) convert([...parts.map((p) => ['(', p, ')']).flat(), '+append', '-background', '#111', `/tmp/verify/srow-${i}.png`]);
});
