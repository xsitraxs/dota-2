#!/usr/bin/env node
/**
 * build_templates.mjs — подписи героев для распознавания скриншотов.
 *
 * Берёт локальные иконки data/icons/*.webp (256×144) и для каждого героя считает
 * подписи нескольких кадрирований — в игре карточка героя обрезана по-разному
 * (квадратный портрет в экране пика, 16:9 в драфт-экране).
 *
 * Из инструментов нужен ImageMagick (`convert`): он декодирует webp в сырые байты.
 * Запуск: node tools/build_templates.mjs   →   data/templates.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSignature, signatureToHex, SIG_SIZE } from '../assets/recognize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'data', 'icons');
const OUT = path.join(ROOT, 'data', 'templates.json');

/** Кадрирования исходной иконки 256×144: полный кадр, три квадрата и приближенный центр. */
const VARIANTS = [
  { name: 'full', crop: '256x144+0+0' },
  { name: 'sq_left', crop: '144x144+0+0' },
  { name: 'sq_center', crop: '144x144+56+0' },
  { name: 'sq_right', crop: '144x144+112+0' },
  { name: 'zoom', crop: '108x108+74+18' },
];

function raw(file, crop, colorspace) {
  return execFileSync('convert', [
    file, '-crop', crop, '+repage', '-resize', `${SIG_SIZE}x${SIG_SIZE}!`,
    '-depth', '8', '-alpha', 'off', `${colorspace}:-`,
  ], { maxBuffer: 1024 * 1024 });
}

const files = fs.readdirSync(ICONS).filter((f) => f.endsWith('.webp')).sort();
if (!files.length) {
  console.error('Нет иконок в data/icons — сначала запусти node tools/build_data.mjs');
  process.exit(1);
}

const heroes = {};
let total = 0;
const t0 = Date.now();
for (const file of files) {
  const slug = file.replace(/\.webp$/, '');
  const src = path.join(ICONS, file);
  const sigs = [];
  for (const v of VARIANTS) {
    const gray = new Uint8Array(raw(src, v.crop, 'gray'));
    const rgb = new Uint8Array(raw(src, v.crop, 'rgb'));
    sigs.push(signatureToHex(buildSignature({ gray, rgb })));
  }
  heroes[slug] = sigs;
  total += sigs.length;
}

const meta = {
  sigSize: SIG_SIZE,
  variants: VARIANTS.map((v) => v.name),
  algo: 'dhash17x16(256b) + color4x4(48B)',
  source: 'data/icons/*.webp',
  note: 'сгенерировано tools/build_templates.mjs (нужен ImageMagick)',
  heroes: Object.keys(heroes).length,
  signatures: total,
};

fs.writeFileSync(OUT, JSON.stringify({ meta, heroes }, null, 0) + '\n');
const size = fs.statSync(OUT).size;
console.log(`подписей: ${total} (${Object.keys(heroes).length} героев × ${VARIANTS.length} кадров)`);
console.log(`data/templates.json — ${(size / 1024).toFixed(0)} КБ, ${Date.now() - t0} мс`);
