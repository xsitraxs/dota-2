#!/usr/bin/env node
/** Разметочный инструмент: находит точные прямоугольники карточек по полосам яркости. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readImage } from '../imagemagick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const name = process.argv[2] || 'draft-strip';
const file = ['jpg', 'png'].map((e) => path.join(ROOT, 'tools', 'rec_fixtures', `${name}.${e}`)).find((f) => fs.existsSync(f));
const img = readImage(file);
const { width: W, height: H, data } = img;
const px = (x, y) => {
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};
/** Девиация строки (полоса y..y+h) от фона: среднее расстояние до самого частого тёмного цвета. */
function colProfile(y0, y1) {
  const p = [];
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = y0; y < y1; y++) { const [r, g, b] = px(x, y); s += Math.abs(r - 16) + Math.abs(g - 20) + Math.abs(b - 28); }
    p.push(s / (y1 - y0));
  }
  return p;
}
function segments(profile, thr) {
  const segs = [];
  let start = -1;
  profile.forEach((v, x) => {
    if (v > thr && start < 0) start = x;
    if ((v <= thr || x === profile.length - 1) && start >= 0) { segs.push([start, x]); start = -1; }
  });
  return segs.filter(([a, b]) => b - a > 12);
}
const bands = process.argv[3] ? JSON.parse(process.argv[3]) : [[170, 400]];
for (const [y0, y1] of bands) {
  const prof = colProfile(y0, y1);
  const thr = Math.max(...prof) * 0.25;
  console.log(`band y${y0}-${y1} thr=${thr.toFixed(1)}`);
  console.log(JSON.stringify(segments(prof, thr)));
}
/** Строки: профиль по горизонтали в заданных колонках. */
function rowProfile(x0, x1) {
  const p = [];
  for (let y = 0; y < H; y++) {
    let s = 0;
    for (let x = x0; x < x1; x++) { const [r, g, b] = px(x, y); s += Math.abs(r - 16) + Math.abs(g - 20) + Math.abs(b - 28); }
    p.push(s / (x1 - x0));
  }
  return p;
}
const cols = process.argv[4];
if (cols) {
  const [x0, x1] = JSON.parse(cols);
  const prof = rowProfile(x0, x1);
  const thr = Math.max(...prof) * 0.25;
  console.log(`rows for x${x0}-${x1} thr=${thr.toFixed(1)}`);
  console.log(JSON.stringify(segments(prof, thr)));
}
