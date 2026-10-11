/**
 * imagemagick.mjs — вызов ImageMagick для сборки шаблонов и тестов распознавания.
 *
 * ImageMagick 7 ставит команду `magick` (а `convert` в нём устарел и есть не везде), ImageMagick 6 —
 * только `convert`/`identify`. Берём то, что установлено: так скрипты работают и на текущих раннерах
 * GitHub (Ubuntu 24.04, IM6), и на новых образах или macOS с IM7.
 */
import { execFileSync } from 'node:child_process';

const has = (bin) => {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const IM7 = has('magick');
const IM6 = !IM7 && has('convert') && has('identify');

/** Есть ли ImageMagick вообще. */
export const imageMagickAvailable = IM7 || IM6;

/** `convert …` (IM6) или `magick …` (IM7) с теми же аргументами. */
export function convert(args, opts = {}) {
  return execFileSync(IM7 ? 'magick' : 'convert', args, { maxBuffer: 256 * 1024 * 1024, ...opts });
}

/** `identify …` (IM6) или `magick identify …` (IM7). */
export function identify(args, opts = {}) {
  return IM7 ? execFileSync('magick', ['identify', ...args], opts) : execFileSync('identify', args, opts);
}

/** Кадр как ImageData-подобный объект {width, height, data: RGBA}. */
export function readImage(file) {
  const [width, height] = identify(['-format', '%w %h', file]).toString().trim().split(' ').map(Number);
  const data = new Uint8Array(convert([file, '-depth', '8', 'rgba:-']));
  return { width, height, data };
}
