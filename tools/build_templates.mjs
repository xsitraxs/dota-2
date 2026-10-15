#!/usr/bin/env node
/**
 * build_templates.mjs — подписи героев для распознавания скриншотов.
 *
 * Берёт локальные иконки data/icons/*.webp (256×144) и для каждого героя считает
 * подписи нескольких кадрирований — в игре карточка героя обрезана по-разному
 * (квадратный портрет в экране пика, 16:9 в драфт-экране).
 *
 * Кадрирование и приведение к 32×32 идут через тот же код, что и распознавание
 * (recognize.js → sampleRect: усреднение по площади + автоуровни 2–98 перцентилей).
 * Раньше подпись считалась отдельной веткой на `convert -resize 32x32!`: без автоуровней
 * собственная иконка героя отличалась от своего же шаблона почти на 0.09 близости, и пороги
 * уверенного совпадения приходилось мерить с этой поправкой.
 *
 * Из инструментов нужен ImageMagick (`convert` из IM6 или `magick` из IM7): он декодирует webp в сырые байты.
 * Запуск: node tools/build_templates.mjs   →   data/templates.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSignature, signatureToHex, sampleRect, SIG_SIZE } from '../assets/recognize.js';
import { readImage, imageMagickAvailable } from './imagemagick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'data', 'icons');
const OUT = path.join(ROOT, 'data', 'templates.json');

/**
 * Кадрирования иконки: полный кадр, три квадрата по высоте (в экране пика портрет обрезан
 * квадратом: слева/по центру/справа) и приближенный центр. Доли, а не пиксели: так скрипт
 * переживёт иконку другого размера.
 *   side = h; zoomSide = 0.75·h — для иконки 256×144 это те же 144×144 и 108×108, что и раньше.
 */
const VARIANTS = [
  { name: 'full', rect: ({ w, h }) => ({ x: 0, y: 0, w, h }) },
  { name: 'sq_left', rect: ({ h }) => ({ x: 0, y: 0, w: h, h }) },
  { name: 'sq_center', rect: ({ w, h }) => ({ x: (w - h) / 2, y: 0, w: h, h }) },
  { name: 'sq_right', rect: ({ w, h }) => ({ x: w - h, y: 0, w: h, h }) },
  { name: 'zoom', rect: ({ w, h }) => { const side = 0.75 * h; return { x: (w - side) / 2, y: (h - side) / 2, w: side, h: side }; } },
];

if (!imageMagickAvailable) {
  console.error('Нужен ImageMagick (convert или magick) — установите его и повторите.');
  process.exit(1);
}

// Подписи строим только для героев из данных и только по иконкам из манифеста icons.json:
// посторонний файл в data/icons (например, оставшийся от переименованного героя) не должен
// превратиться в «героя», которого распознавание сможет вернуть.
const heroesData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'heroes.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'icons.json'), 'utf8'));
const entries = Object.entries(manifest)
  .filter(([slug, file]) => Object.prototype.hasOwnProperty.call(heroesData, slug) && fs.existsSync(path.join(ICONS, file)))
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
if (!entries.length) {
  console.error('Нет иконок в data/icons — сначала запусти node tools/build_data.mjs');
  process.exit(1);
}
const listed = new Set(entries.map(([, file]) => file));
const strays = fs.readdirSync(ICONS).filter((f) => f.endsWith('.webp') && !listed.has(f));
if (strays.length) console.warn(`⚠ файлы вне манифеста icons.json пропущены: ${strays.join(', ')}`);
const withoutIcon = Object.keys(heroesData).filter((slug) => !entries.some(([s]) => s === slug));
if (withoutIcon.length) {
  console.warn(`⚠ без иконки — на скриншоте не распознаются: ${withoutIcon.map((s) => heroesData[s].localized_name).join(', ')}`);
}

const heroes = {};
let total = 0;
const t0 = Date.now();
for (const [slug, file] of entries) {
  const src = path.join(ICONS, file);
  const icon = readImage(src); // {width, height, data: RGBA} — тот же вход, что у распознавания
  // Кадрирования задаются долями от размера иконки: readImage отдаёт width/height, а не w/h.
  const size = { w: icon.width, h: icon.height };
  const sigs = [];
  for (const v of VARIANTS) {
    const sample = sampleRect(icon, v.rect(size));
    // Пустая (вне кадра или однородная) выборка дала бы вырожденную подпись, по которой
    // герой не распознается ни на одном скриншоте: говорим об этом прямо.
    if (sample.flat) console.warn(`⚠ ${slug}: кадр «${v.name}» вышел пустым — проверьте иконку ${file}`);
    sigs.push(signatureToHex(buildSignature(sample)));
  }
  heroes[slug] = sigs;
  total += sigs.length;
}

const meta = {
  sigSize: SIG_SIZE,
  variants: VARIANTS.map((v) => v.name),
  algo: 'dhash17x16(256b) + color4x4(48B)',
  source: 'data/icons/*.webp',
  note: 'сгенерировано tools/build_templates.mjs: sampleRect (усреднение + автоуровни) + buildSignature — тот же путь, что и при распознавании',
  heroes: Object.keys(heroes).length,
  signatures: total,
};

fs.writeFileSync(OUT, JSON.stringify({ meta, heroes }, null, 0) + '\n');
const size = fs.statSync(OUT).size;
console.log(`подписей: ${total} (${Object.keys(heroes).length} героев × ${VARIANTS.length} кадров)`);
console.log(`data/templates.json — ${(size / 1024).toFixed(0)} КБ, ${Date.now() - t0} мс`);
