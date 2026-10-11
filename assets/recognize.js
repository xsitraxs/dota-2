/**
 * recognize.js — распознавание героев на скриншотах драфта.
 *
 * Работает офлайн и без зависимостей: сравнивает карточки на скриншоте с подписями
 * локальных иконок (data/templates.json). Подпись карточки — два инварианта:
 *   • dHash 17×16 (256 бит): сравнение соседних пикселей по строке — устойчиво к яркости;
 *   • цветовая сигнатура 4×4 блока (48 байт): средний RGB блока после нормировки яркости.
 *
 * Модуль не зависит от DOM (кроме ImageData-подобных объектов) и тестируется в Node.
 */

export const SIG_SIZE = 32; // сторона нормализованной карточки (32×32)
const DHASH_W = 17;
const DHASH_H = 16;
const COLOR_BLOCKS = 4;

/** Яркость из RGBA-буфера (ImageData.data). */
export function grayFromRGBA(data, width, height) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return out;
}

/**
 * Приводит произвольный прямоугольник изображения к 32×32 (усреднение по площади).
 * @returns {{gray: Uint8Array, rgb: Uint8Array}}
 */
export function sampleRect(img, rect) {
  const { width, height, data } = img;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  const gray = new Uint8Array(SIG_SIZE * SIG_SIZE);
  const rgb = new Uint8Array(SIG_SIZE * SIG_SIZE * 3);
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
  const sorted = Array.from(gray).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  if (hi - lo >= 12) {
    const scale = 255 / (hi - lo);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.max(0, Math.min(255, (gray[i] - lo) * scale));
      for (let c = 0; c < 3; c++) {
        const p = i * 3 + c;
        rgb[p] = Math.max(0, Math.min(255, (rgb[p] - lo) * scale));
      }
    }
  }
  return { gray, rgb };
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
  for (const scale of [0.78, 0.9]) {
    const side = Math.min(rect.w, rect.h) * scale;
    out.push({ x: rect.x + (rect.w - side) / 2, y: rect.y + (rect.h - side) / 2, w: side, h: side });
  }
  return out;
}

/**
 * Распознаёт героев в ячейках скриншота. Двумя проходами: сначала грубо (центральное окно)
 * отбираем пул похожих героев, затем уточняем для них кадрирование и масштаб. Так полный
 * перебор окон по всем 124 героям не нужен и распознавание укладывается в сотни миллисекунд.
 */
export function recognizeCells(img, cells, templates, opts = {}) {
  const topK = opts.topK || 3;
  const weights = opts.weights || { dhash: 0.7, color: 0.3 };
  const refinePool = opts.refinePool ?? 16;
  const prepared = Object.entries(templates).map(([slug, hexes]) => ({
    slug,
    sigs: hexes.map(signatureFromHex),
  }));
  return cells.map((rect) => {
    const windows = cellCropRects(rect, opts);
    const scoreOf = (cand, win) => {
      const sig = buildSignature(sampleRect(img, win));
      let best = { d: 1, variant: 0 };
      cand.sigs.forEach((t, i) => {
        const d = scoreDistance(sig, t, weights, best.d);
        if (d < best.d) best = { d, variant: i };
      });
      return best;
    };
    // Грубый проход по центральному окну отбирает пул похожих героев, затем для каждого героя
    // пула выбирается лучшее окно кадрирования — так компенсируется смещение рамки карточки.
    const coarseSig = buildSignature(sampleRect(img, centerCrop(rect, 0.92)));
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
      for (const win of windows) {
        const r = scoreOf(cand, win);
        if (r.d < best.d) best = r;
      }
      return { slug: cand.slug, score: Math.round(best.d * 1000) / 1000, variant: best.variant };
    }).sort((a, b) => a.score - b.score);

    const rest = coarse.slice(refinePool).map((c) => ({ slug: c.slug, score: Math.round(c.score * 1000) / 1000, variant: 0 }));
    const ranked = refined.concat(rest);
    return { rect, candidates: ranked.slice(0, Math.max(topK, 5)) };
  });
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
  const maxW = opts.maxWidth || 480;
  const scale = Math.min(1, maxW / img.width);
  const w = Math.max(16, Math.round(img.width * scale));
  const h = Math.max(16, Math.round(img.height * scale));
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
  colSets.push(...lagLattices(colLum, colRange, { minLag: colMinLag, maxLag: colMaxLag, mode: 'gaps', limit: 6 }));
  colSets.push(...lagLattices(colEdge, colRange, { minLag: colMinLag, maxLag: colMaxLag, mode: 'edges', limit: 4 }));
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
    const rowRange = { a: x0, b: x1 };
    rowSets.push(...lagLattices(rowLum, rowRange, { minLag: rowMinLag, maxLag: rowMaxLag, mode: 'gaps', limit: 3 }));
    rowSets.push(...lagLattices(rowEdge, rowRange, { minLag: rowMinLag, maxLag: rowMaxLag, mode: 'edges', limit: 2 }));
    // Одна полоса карточек: ряд занимает всю вертикальную область, заполненную деталями.
    const bandRows = contentBand(rowLum);
    if (bandRows) rowSets.push({ boundaries: [bandRows.a, bandRows.b], lag: 0, coverage: 1, mode: 'band' });
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
  const xEdge = activeRange(edgeProfileX(gray, w, h), 0.15, 3);
  const xLum = activeRange(lumProfileX(gray, w, h), 0.15, 3);
  const x0 = Math.min(xEdge ? xEdge.a : 0, xLum ? xLum.a : 0);
  const x1 = Math.max(xEdge ? xEdge.b + 1 : w - 1, xLum ? xLum.b + 1 : w - 1);
  const yEdge = activeRange(edgeProfileY(gray, w, h, x0, x1), 0.15, 3);
  const yLum = activeRange(lumProfileY(gray, w, h, x0, x1), 0.15, 3);
  const y0 = Math.min(yEdge ? yEdge.a : 0, yLum ? yLum.a : 0);
  const y1 = Math.max(yEdge ? yEdge.b + 1 : h - 1, yLum ? yLum.b + 1 : h - 1);
  return { x0, x1, y0, y1 };
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
  for (let i = 0; i < cells.length && sample.length < 6; i += stride) sample.push(cells[i]);
  const offsets = [0, -0.03, 0.03, -0.06, 0.06, -0.09, 0.09, -0.12, 0.12];
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
  const verifyLimit = opts.verifyLimit || 20;
  const candidates = gridCandidates(img, opts);
  if (!candidates.length) return { grid: null, cells: [], confidence: 0, candidates: 0 };

  // Отсеиваем заведомо неверные рамки: карточка героя — почти квадрат и не бывает пустой.
  const scored = [];
  for (const grid of candidates) {
    const aspects = grid.cells.map((c) => c.w / Math.max(1, c.h)).sort((a, b) => a - b);
    const aspect = aspects[Math.floor(aspects.length / 2)];
    const sampleLimit = Math.min(verifyLimit, 8);
    const step = Math.max(1, Math.floor(grid.cells.length / sampleLimit));
    const sample = grid.cells.filter((_, i) => i % step === 0).slice(0, sampleLimit);
    const stats = sample.map((rect) => cellStats(img, rect));
    const emptyFrac = stats.filter((st) => st.std < 12).length / Math.max(1, stats.length);
    const top = recognizeCells(img, sample, templates, { topK: 1, refinePool: 4, scales: [0.9], shifts: [[0, 0]] });
    // Оценка рамки — медиана по ячейкам: верная сетка даёт ровные уверенные совпадения,
    // смещённая — «никакие» почти на всех карточках.
    const med = median(top.map((r) => r.candidates[0].score));
    const cov = coveredFrac(grid.cells, grid.meta.box);
    // Итоговая оценка кандидата: качество совпадений плюс штраф за неполное покрытие кадра.
    scored.push({ grid, med, aspect, emptyFrac, cov, rank: med + 0.15 * (1 - cov) });
  }
  const plausible = scored.filter((c) => c.emptyFrac <= 0.15 && c.aspect >= 0.5 && c.aspect <= 1.4);
  const pool = plausible.length ? plausible : scored;
  // У лучших кандидатов уточняем общую фазу сетки и пересчитываем их оценку.
  const weights = opts.weights || { dhash: 0.7, color: 0.3 };
  const prepared = Object.entries(templates).map(([slug, hexes]) => ({ slug, sigs: hexes.map(signatureFromHex) }));
  for (const cand of [...pool].sort((a, b) => a.rank - b.rank).slice(0, 5)) {
    const phase = gridPhase(img, cand.grid.cells, prepared, weights);
    cand.phase = phase;
    if (phase.dx || phase.dy) {
      const shifted = cand.grid.cells.map((r) => shiftRect(r, phase.dx, phase.dy));
      const top = recognizeCells(img, shifted, templates, { topK: 1, refinePool: 4, scales: [1, 0.9], shifts: [[0, 0]] });
      cand.med = median(top.map((r) => r.candidates[0].score));
      cand.rank = cand.med + 0.15 * (1 - cand.cov);
    }
  }
  // Среди близких по качеству рамок предпочитаем более грубую: если карточка делится
  // пополам, половина ячеек обычно оказывается пустой и отсеивается выше, но иногда
  // «лишние» деления проходят по краю портрета — тогда решает меньшее число карточек.
  const bestScore = Math.min(...pool.map((c) => c.rank));
  const close = pool.filter((c) => c.rank <= bestScore + 0.02)
    .sort((a, b) => a.grid.cells.length - b.grid.cells.length || a.rank - b.rank);
  const best = close[0];

  const phase = best.phase || { dx: 0, dy: 0 };
  const gridCells = best.grid.cells.map((r) => shiftRect(r, phase.dx, phase.dy));
  const cells = recognizeCells(img, gridCells, templates, opts);
  const scores = cells.map((c) => c.candidates[0].score);
  const med = median(scores);
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

/** Статистика ячейки: разброс яркости и «пустоту» (фон/щель) видно по стандартному отклонению. */
function cellStats(img, rect) {
  const { gray } = sampleRect(img, rect);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  let varSum = 0;
  for (let i = 0; i < gray.length; i++) varSum += (gray[i] - mean) ** 2;
  return { mean, std: Math.sqrt(varSum / gray.length) };
}

/** Равномерная нарезка прямоугольника на сетку cols×rows (ручной режим интерфейса). */
export function splitRect(rect, cols, rows) {
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: rect.x + (rect.w * c) / cols,
        y: rect.y + (rect.h * r) / rows,
        w: rect.w / cols,
        h: rect.h / rows,
      });
    }
  }
  return cells;
}
