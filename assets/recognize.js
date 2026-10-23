/**
 * recognize.js — распознавание героев на скриншотах драфта.
 *
 * Работает офлайн и без зависимостей: сравнивает карточки на скриншоте с подписями
 * локальных иконок (data/templates.json). Подпись карточки — два инварианта:
 *   • dHash 17×16 (256 бит): сравнение соседних пикселей по строке — устойчиво к яркости;
 *   • цветовая сигнатура 4×4 блока (48 байт): средний RGB блока после нормировки яркости.
 * Близость = 0.7·dHash + 0.3·цвет. Пустые (плоские) ячейки помечаются и в сравнении не участвуют.
 *
 * Итог по ячейке — статус: «empty» (пустой слот), «ok» (уверенное совпадение: близость лучшего
 * героя не выше MATCH_MAX_SCORE, отрыв от второго не меньше MATCH_MIN_MARGIN и отношение
 * лучшей близости ко второй не больше MATCH_MAX_RATIO) или «weak» (слабое совпадение: кандидаты
 * есть, но героя нельзя выдавать за распознанного). Пороги откалиброваны на синтетических кадрах:
 * настоящие совпадения против «чужих» героев — когда героя на карточке нет среди шаблонов
 * (leave-one-out) — и проверены на посторонних картинках (надписи, узоры, градиенты).
 *
 * Автопоиск сетки: по профилям яркости и градиента находится область содержимого, затем шаг
 * решётки (перебор шагов с фазировкой по профилю плюс «попадание в границы») и полосы карточек
 * (например, два ряда команд на экране пика). Из нескольких кандидатов сетка выбирается по
 * узнаваемости ячеек (медиана близости + покрытие области + соответствие размеров), после чего
 * подбирается общий сдвиг — фаза — всей сетки. Ячейка сравнивается в нескольких окнах
 * кадрирования и масштабах, плоские края (фон, полоса подписи PICK/BAN) обрезаются.
 *
 * Модуль не зависит от DOM (кроме ImageData-подобных объектов) и тестируется в Node.
 */

export const SIG_SIZE = 32; // сторона нормализованной карточки (32×32)
const DHASH_W = 17;
const DHASH_H = 16;
const COLOR_BLOCKS = 4;
/** Длина подписи в hex: 32 байта dHash + 48 байт цвета. */
const SIG_HEX_LEN = ((DHASH_W - 1) * DHASH_H / 8 + COLOR_BLOCKS * COLOR_BLOCKS * 3) * 2;

/** Разброс яркости (2–98 перцентили) всей ячейки, ниже которого она плоская — сравнивать нечего. */
const FLAT_RANGE = 12;
/**
 * То же для центральных 60% ячейки: пустой слот с рамкой или с захваченным фоном по краям
 * не плоский целиком, но его середина однородна. У настоящих портретов (все 124 иконки × 4 кадра,
 * в том числе затемнённые и размытые) разброс центра не ниже ~27, у пустых слотов — 0–11.
 */
const CENTER_FLAT_RANGE = 14;

/**
 * Пороги уверенного совпадения. Откалиброваны заново после того, как подписи шаблонов стали
 * считаться тем же путём, что и распознавание (sampleRect с автоуровнями, см. build_templates.mjs):
 * на 241 верной карточке (124 героя × разные обработки: размытие, яркость, контраст, JPEG, шум,
 * масштаб 55%) отрыв от второго кандидата не ниже 0.064 (5-й процентиль 0.11), а отношение
 * близостей не выше 0.72; у посторонних картинок (встроенные картинки ImageMagick, узоры, шум,
 * надписи «BAN»/«Radiant», градиент) отрыв не выше 0.061, а отношение — не ниже 0.76.
 * Поэтому: близость не хуже порога, отрыв не меньше 0.065 и отношение не больше 0.73.
 * Одного отрыва мало: надписи и узоры дают «Sven» или «Luna» с маленьким отрывом при отношении ~0.9.
 */
export const MATCH_MAX_SCORE = 0.25;
/** …он заметно лучше второго кандидата (у «чужих» героев отрыв почти всегда < 0.05)… */
export const MATCH_MIN_MARGIN = 0.065;
/** …и лучше в разы, а не на фиксированную величину. */
export const MATCH_MAX_RATIO = 0.73;

/** Предел колонок/строк ручной нарезки (интерфейс и тесты используют одно значение). */
export const MAX_GRID = 24;
/** Меньше этого (после уменьшения для профилей) сетку искать не по чему. */
const MIN_GRID_SIDE = 16;

/** Яркость из RGBA-буфера (ImageData.data). */
export function grayFromRGBA(data, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return out;
}

/** Нижний и верхний перцентили по гистограмме 0..255 (сортировать значения на каждую подпись дорого). */
function histRange(hist, count, frac = 0.02) {
  const target = count * frac;
  let lo = 0;
  let hi = 255;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= target) { hi = v; break; } }
  return { lo, hi };
}

/**
 * Приводит произвольный прямоугольник изображения к 32×32 (усреднение по площади).
 * Прямоугольник, целиком лежащий вне кадра (или с нечисловыми координатами), даёт пустую
 * плоскую выборку с пометкой outside: раньше индекс в таком случае уходил за конец строки
 * и читались пиксели соседних строк.
 * @returns {{gray: Uint8Array, rgb: Uint8Array, flat: boolean, centerFlat: boolean, outside?: boolean}}
 */
export function sampleRect(img, rect) {
  const { width, height, data } = img;
  const gray = new Uint8Array(SIG_SIZE * SIG_SIZE);
  const rgb = new Uint8Array(SIG_SIZE * SIG_SIZE * 3);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  if (!(x1 > x0 && y1 > y0)) return { gray, rgb, flat: true, centerFlat: true, outside: true };
  const bw = x1 - x0;
  const bh = y1 - y0;
  for (let y = 0; y < SIG_SIZE; y++) {
    const sy0 = y0 + Math.floor((bh * y) / SIG_SIZE);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor((bh * (y + 1)) / SIG_SIZE));
    for (let x = 0; x < SIG_SIZE; x++) {
      const sx0 = x0 + Math.floor((bw * x) / SIG_SIZE);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor((bw * (x + 1)) / SIG_SIZE));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let p = (sy * width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, p += 4) { r += data[p]; g += data[p + 1]; b += data[p + 2]; n++; }
      }
      const i = y * SIG_SIZE + x;
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
      gray[i] = (r * 299 + g * 587 + b * 114) / 1000;
    }
  }
  // Автоуровни: скриншоты бывают темнее/светлее исходных иконок. Растягиваем диапазон по
  // процентилям (крайние значения отбрасываем — там шум), одинаково для всех каналов.
  const hist = new Uint16Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const { lo, hi } = histRange(hist, gray.length);
  // Середина ячейки (до растяжения): у пустого слота она однородна, даже если по краям
  // в ячейку попали рамка слота или фон между карточками.
  const c0 = Math.round(SIG_SIZE * 0.2);
  const c1 = SIG_SIZE - c0;
  const centerHist = new Uint16Array(256);
  for (let y = c0; y < c1; y++) for (let x = c0; x < c1; x++) centerHist[gray[y * SIG_SIZE + x]]++;
  const center = histRange(centerHist, (c1 - c0) * (c1 - c0));
  const centerFlat = center.hi - center.lo < CENTER_FLAT_RANGE;
  // Плоский патч (фон, пустой слот): сравнивать нечего — иначе серый прямоугольник
  // «похож» на случайного героя по цвету и портит и выбор сетки, и результат.
  const flat = hi - lo < FLAT_RANGE;
  if (!flat) {
    const scale = 255 / (hi - lo);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, (gray[i] - lo) * scale));
      for (let c = 0; c < 3; c++) {
        const p = i * 3 + c;
        rgb[p] = Math.max(0, Math.min(255, (rgb[p] - lo) * scale));
      }
    }
  }
  return { gray, rgb, flat, centerFlat };
}

/** Уменьшение 32×32 → 17×16 усреднением (тот же алгоритм в сборщике шаблонов и в браузере). */
function boxDownsample(gray, w, h, nw, nh) {
  const out = new Uint16Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor((h * y) / nh);
    const sy1 = Math.max(sy0 + 1, Math.floor((h * (y + 1)) / nh));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor((w * x) / nw);
      const sx1 = Math.max(sx0 + 1, Math.floor((w * (x + 1)) / nw));
      let sum = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) { sum += gray[sy * w + sx]; n++; }
      out[y * nw + x] = Math.round(sum / n);
    }
  }
  return out;
}

/**
 * Подпись карточки: dHash (32 байта) + цветовая сигнатура (48 байт).
 * @returns {{dhash: Uint8Array, color: Uint8Array}}
 */
export function buildSignature({ gray, rgb }) {
  const small = boxDownsample(gray, SIG_SIZE, SIG_SIZE, DHASH_W, DHASH_H);
  const dhash = new Uint8Array((DHASH_W - 1) * DHASH_H / 8);
  let bit = 0;
  for (let y = 0; y < DHASH_H; y++) {
    for (let x = 0; x < DHASH_W - 1; x++) {
      if (small[y * DHASH_W + x] > small[y * DHASH_W + x + 1]) dhash[bit >> 3] |= 1 << (7 - (bit & 7));
      bit++;
    }
  }
  // Цвет: 4×4 блока средним RGB с общей нормировкой по яркости кадра — подпись не зависит
  // от яркости скриншота, но и не усиливает шум в тёмных участках (как попиксельная нормировка).
  let luma = 0;
  for (let i = 0; i < gray.length; i++) luma += gray[i];
  luma /= gray.length;
  const k = luma > 1 ? 140 / luma : 1;
  const color = new Uint8Array(COLOR_BLOCKS * COLOR_BLOCKS * 3);
  const bs = SIG_SIZE / COLOR_BLOCKS;
  for (let by = 0; by < COLOR_BLOCKS; by++) {
    for (let bx = 0; bx < COLOR_BLOCKS; bx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = by * bs; y < (by + 1) * bs; y++) {
        for (let x = bx * bs; x < (bx + 1) * bs; x++, n++) {
          const p = (y * SIG_SIZE + x) * 3;
          r += rgb[p]; g += rgb[p + 1]; b += rgb[p + 2];
        }
      }
      const o = (by * COLOR_BLOCKS + bx) * 3;
      color[o] = Math.min(255, Math.round((r / n) * k));
      color[o + 1] = Math.min(255, Math.round((g / n) * k));
      color[o + 2] = Math.min(255, Math.round((b / n) * k));
    }
  }
  return { dhash, color };
}

export function signatureToHex(sig) {
  return [...sig.dhash, ...sig.color].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function signatureFromHex(hex) {
  const n = hex.length / 2;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { dhash: bytes.slice(0, 32), color: bytes.slice(32) };
}

const POPCOUNT = new Uint8Array(256);
for (let i = 1; i < 256; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

/** Расстояние Хэмминга по dHash, 0..1. */
export function dhashDistance(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += POPCOUNT[a[i] ^ b[i]];
  return diff / (a.length * 8);
}

/** Средняя абсолютная разница цветовых подписей, 0..1. */
export function colorDistance(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return diff / (a.length * 255);
}

/** Итоговая близость: 0 — совпадение, 1 — максимум различий. */
export function scoreDistance(cellSig, tplSig, weights = { dhash: 0.7, color: 0.3 }, cutoff = 1) {
  const a = cellSig.dhash;
  const b = tplSig.dhash;
  // Разница по dHash — нижняя оценка полного расстояния: как только она превышает порог,
  // досчитывать цвет и остаток битов незачем (ускоряет перебор шаблонов в разы).
  const limit = weights.dhash > 0 ? (cutoff / weights.dhash) * a.length * 8 : Infinity;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff += POPCOUNT[a[i] ^ b[i]];
    if (diff > limit) return 1;
  }
  return weights.dhash * (diff / (a.length * 8)) + weights.color * colorDistance(cellSig.color, tplSig.color);
}

/**
 * Окна кадрирования ячейки. Рамка автопоиска попадает в карточку с точностью до нескольких
 * процентов, поэтому сравниваем портрет в нескольких масштабах и со сдвигом — как скользящее окно.
 */
export function cellCropRects(rect, opts = {}) {
  const scales = opts.scales || [1, 0.9, 0.78];
  const shifts = opts.shifts || [[0, 0], [-0.03, 0], [0.03, 0], [0, -0.03], [0, 0.03]];
  const out = [];
  for (const scale of scales) {
    const w = rect.w * scale;
    const h = rect.h * scale;
    for (const [dx, dy] of shifts) {
      out.push({ x: rect.x + (rect.w - w) / 2 + rect.w * dx, y: rect.y + (rect.h - h) / 2 + rect.h * dy, w, h });
    }
  }
  // Плюс квадратные окна: в экране пика портреты обрезаны квадратом, а не 16:9.
  for (const scale of opts.squares === false ? [] : [0.78, 0.9]) {
    const side = Math.min(rect.w, rect.h) * scale;
    out.push({ x: rect.x + (rect.w - side) / 2, y: rect.y + (rect.h - side) / 2, w: side, h: side });
  }
  return out;
}

/**
 * Подписи шаблонов, разобранные из hex. Разбор 620 подписей на каждый вызов заметно тормозил
 * перебор кандидатов сетки (recognizeCells вызывается для каждого), поэтому результат кэшируется
 * по объекту шаблонов — объект считается неизменяемым. Записи с неверным форматом пропускаются:
 * испорченный templates.json не должен ронять распознавание.
 */
const PREPARED = new WeakMap();
function prepareTemplates(templates) {
  const cacheable = templates !== null && typeof templates === 'object';
  if (cacheable && PREPARED.has(templates)) return PREPARED.get(templates);
  const out = [];
  for (const [slug, hexes] of Object.entries(cacheable ? templates : {})) {
    if (!Array.isArray(hexes)) continue;
    const sigs = hexes
      .filter((hex) => typeof hex === 'string' && hex.length === SIG_HEX_LEN && /^[0-9a-f]+$/i.test(hex))
      .map(signatureFromHex);
    if (sigs.length) out.push({ slug, sigs });
  }
  if (cacheable) PREPARED.set(templates, out);
  return out;
}

/** Проверка входа: ImageData-подобный объект с буфером нужной длины. */
function assertImage(img) {
  const ok = img && Number.isInteger(img.width) && Number.isInteger(img.height) && img.width > 0 && img.height > 0
    && img.data && img.data.length >= img.width * img.height * 4;
  if (!ok) throw new TypeError('распознавание: нужен кадр {width, height, data} с RGBA-пикселями');
}

/**
 * Решение по ячейке из списка кандидатов. Героя выдаём за распознанного, только если совпадение
 * и близкое, и однозначное; иначе статус «weak» — кандидаты остаются подсказками для ручного выбора.
 * @returns {{status: 'ok'|'weak', slug: string|null, margin: number}}
 */
export function classifyMatch(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return { status: 'weak', slug: null, margin: 0 };
  const best = candidates[0].score;
  const second = candidates.length > 1 ? candidates[1].score : 1;
  const margin = Math.round((second - best) * 1000) / 1000;
  const ok = best <= MATCH_MAX_SCORE && margin >= MATCH_MIN_MARGIN && best <= MATCH_MAX_RATIO * second;
  return { status: ok ? 'ok' : 'weak', slug: ok ? candidates[0].slug : null, margin };
}

/** Лучшая близость ячейки; для пустой ячейки или без кандидатов — 1 (хуже некуда). */
const topScore = (cell) => (cell.candidates && cell.candidates.length ? cell.candidates[0].score : 1);

/**
 * Распознаёт героев в ячейках скриншота. Двумя проходами: сначала грубо (центральное окно)
 * отбираем пул похожих героев, затем уточняем для них кадрирование и масштаб. Так полный
 * перебор окон по всем 124 героям не нужен и распознавание укладывается в сотни миллисекунд.
 *
 * Каждая ячейка получает статус: empty (кандидатов нет), ok (slug — распознанный герой)
 * или weak (slug = null, кандидаты — только подсказки).
 *
 * opts.emptyRule: 'strict' (по умолчанию) — пустой считается и ячейка с однородной серединой;
 * 'flat' — только целиком плоская (прежнее правило). Оценка кандидатов сетки в recognizeScreenshot
 * использует 'flat', чтобы выбор сетки остался прежним: строгое правило там отбраковывало верные
 * сетки экрана драфта, где пустых слотов больше половины.
 */
export function recognizeCells(img, cells, templates, opts = {}) {
  assertImage(img);
  const topK = opts.topK || 3;
  const weights = opts.weights || { dhash: 0.7, color: 0.3 };
  const refinePool = opts.refinePool ?? 16;
  const strict = opts.emptyRule !== 'flat';
  const prepared = prepareTemplates(templates);
  return cells.map((rect) => {
    const sampled = sampleRect(img, rect);
    if (sampled.flat || (strict && sampled.centerFlat)) return { rect, candidates: [], empty: true, status: 'empty', slug: null, margin: 0 };
    // Без шаблонов сравнивать не с чем: ячейка не пустая, но и героя назвать нельзя.
    if (!prepared.length) return { rect, candidates: [], empty: false, status: 'weak', slug: null, margin: 0 };
    // Плоские края ячейки (фон, полоса подписи, пустота между рядами) в сравнение не берём.
    const base = flatFreeRect(sampled.gray, rect);
    // Подпись каждого окна считаем один раз на ячейку, а не заново для каждого героя пула.
    const windowSigs = cellCropRects(base, opts).map((win) => buildSignature(sampleRect(img, win)));
    // Грубый проход по центральному окну отбирает пул похожих героев, затем для каждого героя
    // пула выбирается лучшее окно кадрирования — так компенсируется смещение рамки карточки.
    const coarseSig = buildSignature(sampleRect(img, centerCrop(base, 0.92)));
    const coarse = prepared.map((tpl) => {
      let best = 1;
      for (const t of tpl.sigs) {
        const d = scoreDistance(coarseSig, t, weights, best);
        if (d < best) best = d;
      }
      return { slug: tpl.slug, score: best, sigs: tpl.sigs };
    }).sort((a, b) => a.score - b.score);

    const pool = coarse.slice(0, refinePool);
    const refined = pool.map((cand) => {
      let best = { d: 1, variant: 0 };
      for (const sig of windowSigs) {
        let win = { d: 1, variant: 0 };
        cand.sigs.forEach((t, i) => {
          const d = scoreDistance(sig, t, weights, win.d);
          if (d < win.d) win = { d, variant: i };
        });
        if (win.d < best.d) best = win;
      }
      return { slug: cand.slug, score: Math.round(best.d * 1000) / 1000, variant: best.variant };
    }).sort((a, b) => a.score - b.score);

    const rest = coarse.slice(refinePool).map((c) => ({ slug: c.slug, score: Math.round(c.score * 1000) / 1000, variant: 0 }));
    const candidates = refined.concat(rest).slice(0, Math.max(topK, 5));
    return { rect, candidates, empty: false, ...classifyMatch(candidates) };
  });
}

/**
 * Обрезка плоских краёв ячейки: рамка сетки часто захватывает фон, полосу подписи «PICK/BAN»
 * или пустоту между рядами карточек. Портрет же даёт заметный разброс яркости.
 */
function flatFreeRect(gray, rect) {
  const n = SIG_SIZE;
  const colStd = new Float32Array(n);
  const rowStd = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    let sum = 0;
    let sum2 = 0;
    for (let y = 0; y < n; y++) { const v = gray[y * n + x]; sum += v; sum2 += v * v; }
    const m = sum / n;
    colStd[x] = Math.sqrt(Math.max(0, sum2 / n - m * m));
  }
  for (let y = 0; y < n; y++) {
    let sum = 0;
    let sum2 = 0;
    for (let x = 0; x < n; x++) { const v = gray[y * n + x]; sum += v; sum2 += v * v; }
    const m = sum / n;
    rowStd[y] = Math.sqrt(Math.max(0, sum2 / n - m * m));
  }
  const thrC = Math.max(5, median(colStd) * 0.35);
  const thrR = Math.max(5, median(rowStd) * 0.35);
  let x0 = 0;
  let x1 = n - 1;
  let y0 = 0;
  let y1 = n - 1;
  while (x0 < x1 && colStd[x0] < thrC) x0++;
  while (x1 > x0 && colStd[x1] < thrC) x1--;
  while (y0 < y1 && rowStd[y0] < thrR) y0++;
  while (y1 > y0 && rowStd[y1] < thrR) y1--;
  // Обрезать больше половины ячейки — уже не «край», а сама картинка: не трогаем.
  if (x1 - x0 + 1 < n * 0.45 || y1 - y0 + 1 < n * 0.45) return rect;
  return {
    x: rect.x + (rect.w * x0) / n,
    y: rect.y + (rect.h * y0) / n,
    w: (rect.w * (x1 - x0 + 1)) / n,
    h: (rect.h * (y1 - y0 + 1)) / n,
  };
}

/** Центральное окно ячейки: уменьшенная копия без сдвигов (грубый проход). */
function centerCrop(rect, scale = 0.9) {
  const w = rect.w * scale;
  const h = rect.h * scale;
  return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h };
}

/** Градиентная энергия по оси X: где проходят вертикальные границы карточек. */
function edgeProfileX(gray, w, h, y0 = 0, y1 = h) {
  const out = new Float32Array(w);
  for (let x = 0; x + 1 < w; x++) {
    let sum = 0;
    for (let y = y0; y < y1; y++) sum += Math.abs(gray[y * w + x + 1] - gray[y * w + x]);
    out[x] = sum / Math.max(1, y1 - y0);
  }
  return out;
}

/** Градиентная энергия по оси Y: где проходят горизонтальные границы карточек. */
function edgeProfileY(gray, w, h, x0 = 0, x1 = w) {
  const out = new Float32Array(h);
  for (let y = 0; y + 1 < h; y++) {
    let sum = 0;
    for (let x = x0; x < x1; x++) sum += Math.abs(gray[(y + 1) * w + x] - gray[y * w + x]);
    out[y] = sum / Math.max(1, x1 - x0);
  }
  return out;
}

/* ------------------------------ сетка карточек ------------------------------ */

/** Кандидаты границ карточек по профилю: пики градиента или провалы яркости (щели между карточками). */
function boundaryCandidates(profile, { minLag, maxLag, minPoints = 3, mode = 'edges', limit = 4 }) {
  const n = profile.length;
  const sorted = [...profile].sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.05)];
  const hi = sorted[Math.floor(n * 0.95)];
  const span = Math.max(1, hi - lo);
  const hitFloor = mode === 'edges' ? lo + 0.5 * span : lo + 0.35 * span;
  // «Точка решётки попала в границу»: для градиента — это сильный пик, для яркости — провал.
  const isHit = (x) => {
    const v = profile[x];
    return mode === 'edges' ? v >= hitFloor : v <= hitFloor;
  };
  const anchors = [];
  for (let i = 1; i + 1 < n; i++) {
    const v = profile[i];
    const isExtremum = mode === 'edges'
      ? (v >= profile[i - 1] && v >= profile[i + 1])
      : (v <= profile[i - 1] && v <= profile[i + 1]);
    if (isExtremum && isHit(i)) anchors.push(i);
  }
  if (anchors.length < 2) return [];
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const out = [];
  const maxL = Math.min(maxLag, last - first);
  for (let lag = minLag; lag <= maxL; lag++) {
    const count = Math.floor((last - first) / lag) + 1;
    if (count < minPoints) break;
    let hits = 0;
    for (let k = 0; k < count; k++) {
      const x = first + k * lag;
      let ok = false;
      for (let d = -2; d <= 2 && !ok; d++) {
        const xi = x + d;
        if (xi >= 0 && xi < n && isHit(xi)) ok = true;
      }
      if (ok) hits++;
    }
    // Одна-две «промахнувшиеся» точки на коротком ряду — норма: последняя карточка может
    // не лечь в решётку, если ряд обрезан краем кадра.
    const slack = Math.max(1, Math.round(count * 0.15));
    const coverage = hits / count;
    if (coverage < 0.85 && hits < count - slack) continue;
    const boundaries = [];
    for (let k = 0; k < count; k++) {
      const x = Math.max(0, Math.min(n - 1, first + k * lag));
      let bx = x;
      for (let d = -2; d <= 2; d++) {
        const xi = Math.min(n - 1, Math.max(0, x + d));
        const better = mode === 'edges' ? profile[xi] > profile[bx] : profile[xi] < profile[bx];
        if (better) bx = xi;
      }
      boundaries.push(bx);
    }
    out.push({ boundaries, lag, coverage, mode });
  }
  // Подходящих шагов обычно несколько (собственный, кратные и «половинные» решётки):
  // окончательный выбор делает распознавание, поэтому берём несколько лучших по покрытию.
  out.sort((a, b) => b.coverage - a.coverage || a.lag - b.lag);
  const kept = [];
  for (const cand of out) {
    if (kept.length >= limit) break;
    const dup = kept.some((k) => Math.abs(k.lag - cand.lag) <= 1 || Math.abs(k.boundaries[0] - cand.boundaries[0]) <= 1);
    if (!dup) kept.push(cand);
  }
  kept.sort((a, b) => a.lag - b.lag);
  return kept;
}

/** Сглаживание профиля окном ±1: убирает шум пикселей, положение границ сохраняет. */
function smoothProfile(profile) {
  const out = new Float32Array(profile.length);
  for (let i = 0; i < profile.length; i++) {
    const a = profile[Math.max(0, i - 1)];
    const b = profile[Math.min(profile.length - 1, i + 1)];
    out[i] = (a + profile[i] + b) / 3;
  }
  return out;
}

/**
 * Решётки с разными шагами: для каждого шага фаза подбирается так, чтобы точки решётки попадали
 * на провалы яркости (щели между карточками) или на пики градиента (границы карточек). Качество
 * показывает, насколько уверенно решётка объясняет профиль, — по нему отбираются кандидаты.
 * Так шаг находится и на коротком ряду, где «попадание в границы» проверять почти не на чем.
 */
function lagLattices(profile, range, { minLag, maxLag, mode = 'gaps', limit = 6 } = {}) {
  const a = range.a;
  const b = range.b;
  const sm = smoothProfile(profile);
  const sorted = [...sm.slice(a, b + 1)].sort((x, y) => x - y);
  const n = sorted.length;
  if (n < 8) return [];
  const lo = sorted[Math.floor(n * 0.05)];
  const median = sorted[Math.floor(n * 0.5)];
  const hi = sorted[Math.floor(n * 0.95)];
  const denom = mode === 'gaps' ? Math.max(1, median - lo) : Math.max(1, hi - median);
  const out = [];
  for (let lag = minLag; lag <= Math.min(maxLag, b - a); lag++) {
    const count = Math.floor((b - a) / lag) + 1;
    if (count < 2) break;
    let bestPhase = 0;
    let bestVal = mode === 'gaps' ? Infinity : -Infinity;
    for (let phase = 0; phase < lag && a + phase <= b; phase++) {
      let sum = 0;
      let hits = 0;
      for (let k = 0; a + phase + k * lag <= b; k++) {
        const i = a + phase + k * lag;
        let v = sm[i];
        for (let d = -1; d <= 1; d++) {
          const w = sm[Math.max(0, Math.min(sm.length - 1, i + d))];
          if (mode === 'gaps' ? w < v : w > v) v = w;
        }
        sum += v;
        hits++;
      }
      const val = sum / hits;
      if (mode === 'gaps' ? val < bestVal : val > bestVal) { bestVal = val; bestPhase = phase; }
    }
    const quality = mode === 'gaps' ? (median - bestVal) / denom : (bestVal - median) / denom;
    if (quality < 0.3) continue;
    const boundaries = [];
    for (let k = 0; ; k++) {
      const x = a + bestPhase + k * lag;
      if (x > b) break;
      let bx = Math.max(0, Math.min(sm.length - 1, x));
      for (let d = -2; d <= 2; d++) {
        const xi = Math.max(0, Math.min(sm.length - 1, x + d));
        if (mode === 'gaps' ? profile[xi] < profile[bx] : profile[xi] > profile[bx]) bx = xi;
      }
      if (!boundaries.length || bx - boundaries[boundaries.length - 1] > 1) boundaries.push(bx);
    }
    if (boundaries.length < 2) continue;
    // Края области содержимого — сами по себе границы карточек: если решётка подходит к ним
    // вплотную, дополняем её, иначе крайняя карточка выпадет из нарезки.
    if (boundaries[0] - a > lag * 0.4) boundaries.unshift(a);
    if (b - boundaries[boundaries.length - 1] > lag * 0.4) boundaries.push(b);
    if (boundaries.length > 40) continue;
    out.push({ boundaries, lag, mode, quality, coverage: 1 });
  }
  // Кратный шаг объясняет профиль не хуже собственного, поэтому при равном качестве
  // предпочитаем мелкий, а всё, что кратно уже отобранному, отбрасываем.
  out.sort((x, y) => y.quality - x.quality || x.lag - y.lag);
  const kept = [];
  for (const cand of out) {
    if (kept.length >= limit) break;
    const dup = kept.some((k) => {
      const r = Math.round(cand.lag / k.lag);
      return r >= 1 && Math.abs(cand.lag - r * k.lag) <= Math.max(1, 0.08 * k.lag);
    });
    if (!dup) kept.push(cand);
  }
  return kept.sort((x, y) => x.lag - y.lag);
}

/** Собирает прямоугольники ячеек из найденных линий. */
function cellsFromLines(colLines, rowLines) {
  const cols = [];
  for (let i = 0; i + 1 < colLines.length; i++) {
    const a = colLines[i];
    const b = colLines[i + 1];
    if (b - a > 1) cols.push([a, b]);
  }
  const rows = [];
  for (let i = 0; i + 1 < rowLines.length; i++) {
    const a = rowLines[i];
    const b = rowLines[i + 1];
    if (b - a > 1) rows.push([a, b]);
  }
  const cells = [];
  for (const [ry0, ry1] of rows) {
    for (const [rx0, rx1] of cols) cells.push({ x: rx0, y: ry0, w: rx1 - rx0, h: ry1 - ry0 });
  }
  return cells;
}

/**
 * Кандидаты сетки карточек: комбинации найдённых вертикальных и горизонтальных границ.
 * Окончательный выбор делает recognizeScreenshot, сверяя кандидатов по узнаваемости карточек.
 * @returns {Array<{x:number,y:number,w:number,h:number,cols:number,rows:number,cells:Array,meta:object}>}
 */
export function gridCandidates(img, opts = {}) {
  // Профили считаем в заметном разрешении: у карточек на реальном скриншоте разделители
  // всего 2–4 пикселя, и при сильном сжатии решётка по ним уже не находится.
  const maxW = opts.maxWidth || 960;
  const scale = Math.min(1, maxW / img.width);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  // Слишком маленький (или слишком узкий после уменьшения) кадр: профили не из чего строить,
  // а растягивать сетку до 16 px значило бы вернуть ячейки за пределами изображения.
  if (w < MIN_GRID_SIDE || h < MIN_GRID_SIDE) return [];
  const gray = new Float32Array(w * h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = Math.min(img.width - 1, Math.floor(x * sx));
      const py = Math.min(img.height - 1, Math.floor(y * sy));
      const p = (py * img.width + px) * 4;
      gray[y * w + x] = (img.data[p] * 299 + img.data[p + 1] * 587 + img.data[p + 2] * 114) / 1000;
    }
  }
  const box = contentBounds(gray, w, h);
  const colEdge = edgeProfileX(gray, w, h, box.y0, box.y1);
  const colLum = lumProfileX(gray, w, h, box.y0, box.y1);
  const colMinLag = Math.max(8, Math.round(w * 0.03));
  const colMaxLag = Math.max(16, Math.round(w * 0.4));
  const colSets = [
    ...boundaryCandidates(colEdge, { minLag: colMinLag, maxLag: colMaxLag, limit: 4 }),
    ...boundaryCandidates(colLum, { minLag: colMinLag, maxLag: colMaxLag, limit: 4, mode: 'gaps' }),
  ];
  const colRange = { a: box.x0, b: box.x1 - 1 };
  // Диапазон для вертикальных профилей (rowLum/rowEdge) — по оси Y в пределах области
  // содержимого: раньше сюда передавались координаты по X, и lagLattices читал чужой
  // участок профиля (а при x1 > h — и вовсе выходил за длину профиля).
  const rowRange = { a: box.y0, b: Math.max(box.y0, box.y1 - 1) };
  colSets.push(...lagLattices(colLum, colRange, { minLag: colMinLag, maxLag: colMaxLag, mode: 'gaps', limit: 6 }));
  colSets.push(...lagLattices(colEdge, colRange, { minLag: colMinLag, maxLag: colMaxLag, mode: 'edges', limit: 4 }));
  // Экран пика состоит из двух рядов команд с большим промежутком между ними: общий профиль
  // по всем рядам размывается, поэтому колонки отдельно ищем в каждой полосе содержимого.
  const rowLumAll = lumProfileY(gray, w, h, box.x0, box.x1);
  const bands = activeBands(rowLumAll, 0.15, Math.max(6, Math.round(h * 0.05)))
    .filter((b) => b.b - b.a >= Math.max(6, Math.round(h * 0.05)));
  for (const band of bands.slice(0, 3)) {
    const bandLum = lumProfileX(gray, w, h, band.a, band.b + 1);
    const bandEdge = edgeProfileX(gray, w, h, band.a, band.b + 1);
    colSets.push(...lagLattices(bandLum, colRange, { minLag: colMinLag, maxLag: colMaxLag, mode: 'gaps', limit: 3 })
      .map((c) => ({ ...c, source: 'band' })));
    colSets.push(...lagLattices(bandEdge, colRange, { minLag: colMinLag, maxLag: colMaxLag, mode: 'edges', limit: 2 })
      .map((c) => ({ ...c, source: 'band' })));
  }
  const out = [];
  const seen = new Set();
  for (const cols of colSets) {
    const x0 = Math.max(cols.boundaries[0], box.x0);
    const x1 = Math.min(cols.boundaries[cols.boundaries.length - 1], box.x1);
    if (x1 - x0 < 6) continue;
    const rowEdge = edgeProfileY(gray, w, h, x0, x1);
    const rowLum = lumProfileY(gray, w, h, x0, x1);
    const rowMinLag = Math.max(6, Math.round(h * 0.04));
    const rowMaxLag = Math.max(12, h - 3);
    const rowSets = [
      ...boundaryCandidates(rowEdge, { minLag: rowMinLag, maxLag: rowMaxLag, minPoints: 2, limit: 3 }),
      ...boundaryCandidates(rowLum, { minLag: rowMinLag, maxLag: rowMaxLag, minPoints: 2, limit: 3, mode: 'gaps' }),
    ];
    rowSets.push(...lagLattices(rowLum, rowRange, { minLag: rowMinLag, maxLag: rowMaxLag, mode: 'gaps', limit: 3 }));
    rowSets.push(...lagLattices(rowEdge, rowRange, { minLag: rowMinLag, maxLag: rowMaxLag, mode: 'edges', limit: 2 }));
    // Одна полоса карточек: ряд занимает всю вертикальную область, заполненную деталями.
    const bandRows = contentBand(rowLum);
    if (bandRows) rowSets.push({ boundaries: [bandRows.a, bandRows.b], lag: 0, coverage: 1, mode: 'band' });
    // Ряды команд: каждая полоса содержимого — свой ряд карточек (экран пика).
    if (bands.length >= 2 && bands.length <= 3) {
      for (const band of bands) rowSets.push({ boundaries: [band.a, band.b], lag: 0, coverage: 1, mode: 'band' });
      rowSets.push({ boundaries: bands.flatMap((b) => [b.a, b.b]), lag: 0, coverage: 1, mode: 'bands' });
    }
    rowSets.push({ boundaries: [0, h], lag: 0, coverage: 1, mode: 'full' }); // и весь кадр на случай, если и это не помогло
    for (const rows of rowSets) {
      // Ячейки целиком вне области содержимого — заведомо фон, а не карточки;
      // огрызки много меньше соседей — не карточки (например, остаток от края области).
      const inside = (c) => c.x + c.w / 2 >= box.x0 - 2 && c.x + c.w / 2 <= box.x1 + 2
        && c.y + c.h / 2 >= box.y0 - 2 && c.y + c.h / 2 <= box.y1 + 2;
      const all = cellsFromLines(cols.boundaries, rows.boundaries).filter(inside);
      if (!all.length) continue;
      const medW = median(all.map((c) => c.w));
      const medH = median(all.map((c) => c.h));
      const cells = all.filter((c) => c.w >= medW * 0.45 && c.h >= medH * 0.45);
      if (cells.length < 1 || cells.length > 200) continue;
      const key = `${cols.lag}:${cols.mode}:${rows.lag}:${rows.mode}:${cells.length}:${Math.round(cells[0].x)}:${Math.round(cells[0].y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        x: cols.boundaries[0] / scale, y: rows.boundaries[0] / scale,
        w: (cols.boundaries[cols.boundaries.length - 1] - cols.boundaries[0]) / scale,
        h: (rows.boundaries[rows.boundaries.length - 1] - rows.boundaries[0]) / scale,
        cols: Math.max(1, new Set(cells.map((c) => Math.round(c.x))).size),
        rows: Math.max(1, new Set(cells.map((c) => Math.round(c.y))).size),
        cells: cells.map((c) => ({ x: c.x / scale, y: c.y / scale, w: c.w / scale, h: c.h / scale })),
        meta: {
          colMode: cols.mode, rowMode: rows.mode, colLag: cols.lag, rowLag: rows.lag,
          coverage: (cols.coverage + (rows.coverage || 1)) / 2,
          colSource: cols.source || (cols.mode === 'gaps' ? 'lum' : 'edge'),
          box: { x: box.x0 / scale, y: box.y0 / scale, w: (box.x1 - box.x0) / scale, h: (box.y1 - box.y0) / scale },
        },
      });
    }
  }
  return out;
}

/** Область профиля, где есть детали: вне карточек профиль плоский. Порог считается от
 *  максимума профиля: процентили слепнут, когда карточки занимают малую долю кадра. */
function activeRange(profile, rel = 0.15, minLen = 4) {
  const n = profile.length;
  const sorted = [...profile].sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.05)];
  const hi = sorted[Math.floor(n * 0.95)];
  const thr = lo + rel * Math.max(1, hi - lo);
  let a = -1;
  let b = -1;
  for (let i = 0; i < n; i++) {
    if (profile[i] > thr) { if (a < 0) a = i; b = i; }
  }
  if (a < 0 || b - a < minLen) return null;
  return { a, b };
}

/** Все непрерывные участки профиля выше порога: например, два ряда команд на экране пика. */
function activeBands(profile, rel = 0.15, minLen = 4) {
  const n = profile.length;
  const sorted = [...profile].sort((a, b) => a - b);
  const lo = sorted[Math.floor(n * 0.05)];
  const hi = sorted[Math.floor(n * 0.95)];
  const thr = lo + rel * Math.max(1, hi - lo);
  const bands = [];
  let a = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && profile[i] > thr;
    if (on && a < 0) a = i;
    if (!on && a >= 0) {
      if (i - a >= minLen) bands.push({ a, b: i - 1 });
      a = -1;
    }
  }
  return bands;
}

/** Вертикальная область кадра, заполненная деталями (для случая «одна полоса карточек»). */
function contentBand(profile) {
  const r = activeRange(profile);
  if (!r) return null;
  return { a: Math.max(0, r.a - 1), b: Math.min(profile.length, r.b + 2) };
}

/**
 * Прямоугольник кадра, занятый карточками: на настоящем скриншоте они занимают часть экрана,
 * а вокруг фон. Искать границы и распознавать вне этой области нечего.
 */
function contentBounds(gray, w, h) {
  // Границы берём по объединению двух признаков: карточка выделяется и градиентом по краю,
  // и яркостью. По отдельности каждый признак врёт: тёмный край портрета сливается с фоном.
  // Если один из признаков диапазон не нашёл, берём границы второго (а не всего кадра):
  // иначе сброс обоих вариантов к 0..w / 0..h затирал найденный диапазон второго признака.
  const mergeRange = (a, b, fullEnd) => {
    if (a && b) return { start: Math.min(a.a, b.a), end: Math.max(a.b, b.b) + 1 };
    const only = a || b;
    return only ? { start: only.a, end: only.b + 1 } : { start: 0, end: fullEnd };
  };
  const xEdge = activeRange(edgeProfileX(gray, w, h), 0.15, 3);
  const xLum = activeRange(lumProfileX(gray, w, h), 0.15, 3);
  const xr = mergeRange(xEdge, xLum, w);
  const x0 = xr.start;
  const x1 = xr.end;
  const yEdge = activeRange(edgeProfileY(gray, w, h, x0, x1), 0.15, 3);
  const yLum = activeRange(lumProfileY(gray, w, h, x0, x1), 0.15, 3);
  const yr = mergeRange(yEdge, yLum, h);
  return { x0, x1, y0: yr.start, y1: yr.end };
}

/** Средняя яркость колонок. */
function lumProfileX(gray, w, h, y0 = 0, y1 = h) {
  const out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = y0; y < y1; y++) sum += gray[y * w + x];
    out[x] = sum / Math.max(1, y1 - y0);
  }
  return out;
}

/** Средняя яркость строк. */
function lumProfileY(gray, w, h, x0 = 0, x1 = w) {
  const out = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = x0; x < x1; x++) sum += gray[y * w + x];
    out[y] = sum / Math.max(1, x1 - x0);
  }
  return out;
}

const median = (arr) => {
  if (!arr.length) return 1;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Распознаёт драфт на скриншоте: перебирает кандидатов сетки и выбирает ту,
 * где карточки увереннее всего узнаются как герои. Так ошибки автопоиска рамки
 * исправляются самим распознаванием, а не порогами.
 *
 * @returns {{grid:object|null, cells:Array, confidence:number, candidates:number}}
 */
/**
 * Общий сдвиг сетки. Авторамка может стоять со смещением в несколько процентов от карточек,
 * но сдвиг у всех ячеек один и тот же: подбираем его по узнаваемости нескольких карточек,
 * иначе смещённая рамка даёт «никакие» совпадения, хотя шаг сетки найден верно.
 */
function gridPhase(img, cells, prepared, weights) {
  const sample = [];
  const stride = Math.max(1, Math.floor(cells.length / 6));
  for (let i = 0; i < cells.length && sample.length < 4; i += stride) sample.push(cells[i]);
  const offsets = [0, -0.04, 0.04, -0.08, 0.08, -0.12, 0.12];
  const at = (dx, dy) => {
    const vals = sample.map((rect) => {
      const sig = buildSignature(sampleRect(img, centerCrop(shiftRect(rect, dx, dy), 0.9)));
      let best = 1;
      for (const tpl of prepared) {
        for (const t of tpl.sigs) {
          const d = scoreDistance(sig, t, weights, best);
          if (d < best) best = d;
        }
      }
      return best;
    });
    return median(vals);
  };
  let bestVal = at(0, 0);
  let dx = 0;
  let dy = 0;
  for (const o of offsets) {
    if (!o) continue;
    const v = at(o, 0);
    if (v < bestVal - 1e-6) { bestVal = v; dx = o; }
  }
  for (const o of offsets) {
    if (!o) continue;
    const v = at(dx, o);
    if (v < bestVal - 1e-6) { bestVal = v; dy = o; }
  }
  return { dx, dy, score: bestVal };
}

/** Сдвиг прямоугольника на долю его размера (сдвиг фазы сетки). */
function shiftRect(rect, dx, dy) {
  return { x: rect.x + rect.w * dx, y: rect.y + rect.h * dy, w: rect.w, h: rect.h };
}

export function recognizeScreenshot(img, templates, opts = {}) {
  assertImage(img);
  const verifyLimit = opts.verifyLimit || 20;
  const prepared = prepareTemplates(templates);
  // Без шаблонов отличить верную сетку от неверной нечем — честно возвращаем «сетка не найдена».
  const candidates = prepared.length ? gridCandidates(img, opts) : [];
  if (!candidates.length) return { grid: null, cells: [], confidence: 0, candidates: 0 };

  // Отсеиваем заведомо неверные рамки: карточка героя — почти квадрат и не бывает пустой.
  const scored = [];
  // Ячейки почти во весь кадр (например, три колонки на всю высоту экрана) — это нарезка фона,
  // а не карточки: карточка на настоящем скриншоте не бывает шире 420 px (на особых кадрах
  // есть ручная нарезка). Такую рамку
  // отбраковываем до сравнения по узнаваемости, иначе она «побеждает» одним лишь покрытием
  // области содержимия (так было на мультиблочном экране капитанки).
  const sizeCap = 420;
  for (const grid of candidates) {
    const dims = grid.cells.map((c) => Math.max(c.w, c.h)).sort((a, b) => a - b);
    if (dims[Math.floor(dims.length / 2)] > sizeCap) continue;
    const aspects = grid.cells.map((c) => c.w / Math.max(1, c.h)).sort((a, b) => a - b);
    const aspect = aspects[Math.floor(aspects.length / 2)];
    const sampleLimit = Math.min(verifyLimit, 8);
    const step = Math.max(1, Math.floor(grid.cells.length / sampleLimit));
    const sample = grid.cells.filter((_, i) => i % step === 0).slice(0, sampleLimit);
    const top = recognizeCells(img, sample, templates, { topK: 1, refinePool: 4, scales: [1], shifts: [[0, 0]], squares: false, emptyRule: 'flat' });
    const emptyFrac = top.filter((r) => r.empty).length / Math.max(1, top.length);
    // Оценка рамки — медиана по непустым ячейкам: верная сетка даёт ровные уверенные совпадения,
    // смещённая — «никакие» почти на всех карточках.
    const filled = top.filter((r) => !r.empty);
    const med = filled.length ? median(filled.map(topScore)) : 1;
    const cov = coveredFrac(grid.cells, grid.meta.box);
    const fit = fitPenalty(grid.cells, grid.meta.box);
    // Итоговая оценка кандидата: качество совпадений плюс штрафы за неполное покрытие
    // области содержимого и за ячейки, не похожие на карточки по размеру.
    scored.push({ grid, med, aspect, emptyFrac, cov, fit, rank: med + 0.15 * (1 - cov) + 0.08 * fit });
  }
  // Все кандидаты отбракованы (например, по размеру ячеек): сетки нет — как и на кадре без карточек.
  if (!scored.length) return { grid: null, cells: [], confidence: 0, candidates: candidates.length };
  // Карточки героев бывают и квадратными, и 16:9 — окно аспекта поэтому широкое,
  // а пустые ячейки (полоса подписей, промежуток между рядами) не отбраковывают сетку целиком.
  const plausible = scored.filter((c) => c.aspect >= 0.4 && c.aspect <= 2 && c.emptyFrac <= 0.6);
  const pool = plausible.length ? plausible : scored;
  // У лучших кандидатов уточняем общую фазу сетки и пересчитываем их оценку.
  const weights = opts.weights || { dhash: 0.7, color: 0.3 };
  for (const cand of [...pool].sort((a, b) => a.rank - b.rank).slice(0, 5)) {
    const phase = gridPhase(img, cand.grid.cells, prepared, weights);
    cand.phase = phase;
    if (phase.dx || phase.dy) {
      const shifted = cand.grid.cells.map((r) => shiftRect(r, phase.dx, phase.dy));
      const top = recognizeCells(img, shifted, templates, { topK: 1, refinePool: 4, scales: [1, 0.9], shifts: [[0, 0]], squares: false, emptyRule: 'flat' });
      const filled = top.filter((r) => !r.empty);
      cand.med = filled.length ? median(filled.map(topScore)) : 1;
      cand.rank = cand.med + 0.15 * (1 - cand.cov) + 0.08 * cand.fit;
    }
  }
  // Среди близких по качеству рамок предпочитаем более грубую: если карточка делится
  // пополам, половина ячеек обычно оказывается пустой и отсеивается выше, но иногда
  // «лишние» деления проходят по краю портрета — тогда решает меньшее число карточек.
  const bestScore = Math.min(...pool.map((c) => c.rank));
  const close = pool.filter((c) => c.rank <= bestScore + 0.02)
    // Рамка, не покрывающая часть области содержимого, теряет карточку (например, 5 ячеек на
    // 6 карточек, когда одна просто не попадает в разбиение). При близком качестве сначала берём
    // ту рамку, что закрывает область целиком, и лишь среди них — ту, где ячеек меньше.
    .sort((a, b) => Math.round(b.cov * 100) - Math.round(a.cov * 100)
      || a.grid.cells.length - b.grid.cells.length || a.rank - b.rank);
  const best = close[0];

  const phase = best.phase || { dx: 0, dy: 0 };
  const gridCells = best.grid.cells.map((r) => shiftRect(r, phase.dx, phase.dy));
  const cells = recognizeCells(img, gridCells, templates, { ...opts, emptyRule: 'strict' });
  // Все ячейки пустые (однотонный кадр, экран без карточек): сетки «из пустоты» не показываем.
  if (cells.every((c) => c.empty)) return { grid: null, cells: [], confidence: 0, candidates: candidates.length };
  // Уверенность считаем по непустым ячейкам: пустые слоты (баны, свободные места) — это норма,
  // а не признак плохой сетки.
  const scores = cells.filter((c) => !c.empty).map(topScore);
  const med = scores.length ? median(scores) : 1;
  const confidence = Math.max(0, Math.min(1, (0.28 - med) / 0.08));
  return {
    grid: {
      ...best.grid,
      cells: gridCells,
      // Рамку ячеек округляем: так её удобно рисовать в предпросмотре интерфейса.
      bounds: [gridCells[0].x, gridCells[0].y, gridCells[gridCells.length - 1].x + gridCells[gridCells.length - 1].w, gridCells[gridCells.length - 1].y + gridCells[gridCells.length - 1].h],
      meta: {
        ...best.grid.meta,
        aspect: Math.round(best.aspect * 100) / 100,
        emptyFrac: best.emptyFrac,
        phase: `${Math.round(phase.dx * 100)}%/${Math.round(phase.dy * 100)}%`,
      },
    },
    cells,
    confidence,
    candidates: candidates.length,
  };
}

/**
 * Доля площади области содержимого, покрытая ячейками. Сетка, которая «увидела» лишь часть
 * карточек, распознаётся отлично, но драфт заполнит наполовину, — такие кандидаты штрафуем.
 */
function coveredFrac(cells, box) {
  if (!box || !box.w || !box.h) return 1;
  let sum = 0;
  for (const c of cells) {
    const w = Math.min(c.x + c.w, box.x + box.w) - Math.max(c.x, box.x);
    const h = Math.min(c.y + c.h, box.y + box.h) - Math.max(c.y, box.y);
    if (w > 0 && h > 0) sum += w * h;
  }
  return Math.min(1, sum / (box.w * box.h));
}

/**
 * Насколько сетка объясняет площадь содержимого: ячейки должны укладываться в область
 * карточек. Если ячейка одна и она больше области — это не сетка, а «кадр целиком».
 */
function fitPenalty(cells, box) {
  if (!box || !box.w || !box.h || !cells.length) return 0;
  const cellArea = median(cells.map((c) => c.w * c.h));
  if (cellArea <= 0) return 0;
  const expect = (box.w * box.h) / cellArea;
  const ratio = cells.length / Math.max(0.15, expect);
  return Math.min(1, Math.abs(Math.log2(Math.max(0.05, ratio))));
}

/** Равномерная нарезка прямоугольника на сетку cols×rows (ручной режим интерфейса). */
export function splitRect(rect, cols, rows) {
  const nc = clampGridSize(cols, 1);
  const nr = clampGridSize(rows, 1);
  const cells = [];
  for (let r = 0; r < nr; r++) {
    for (let c = 0; c < nc; c++) {
      cells.push({
        x: rect.x + (rect.w * c) / nc,
        y: rect.y + (rect.h * r) / nr,
        w: rect.w / nc,
        h: rect.h / nr,
      });
    }
  }
  return cells;
}

/** Число колонок/строк ручной нарезки: целое от 1 до MAX_GRID; нечисло → fallback. */
export function clampGridSize(value, fallback = 1) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return Math.min(MAX_GRID, Math.max(1, Math.round(Number(fallback)) || 1));
  return Math.min(MAX_GRID, n);
}

/**
 * Ручная рамка, приведённая к кадру: целые пиксели, левый верхний угол внутри изображения,
 * правый нижний — не дальше его края, размер не меньше 1×1. Нечисловой угол считается нулём,
 * а нечисловой или неположительный размер — «до края кадра».
 */
export function clampRegion(region, width, height) {
  const W = Math.max(1, Math.floor(Number(width)) || 1);
  const H = Math.max(1, Math.floor(Number(height)) || 1);
  const num = (v) => {
    const n = v === null || v === undefined || v === '' ? NaN : Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  const r = region && typeof region === 'object' ? region : {};
  const x = Math.min(W - 1, Math.max(0, Math.round(num(r.x)) || 0));
  const y = Math.min(H - 1, Math.max(0, Math.round(num(r.y)) || 0));
  const rw = Math.round(num(r.w));
  const rh = Math.round(num(r.h));
  const w = Math.min(W - x, rw >= 1 ? rw : W - x);
  const h = Math.min(H - y, rh >= 1 ? rh : H - y);
  return { x, y, w, h };
}

/** Ячейки ручной нарезки: рамка обрезается по кадру, колонки и строки — по MAX_GRID. */
export function manualCells(img, region, cols, rows) {
  const r = clampRegion(region, img.width, img.height);
  return splitRect(r, clampGridSize(cols, 1), clampGridSize(rows, 1));
}
