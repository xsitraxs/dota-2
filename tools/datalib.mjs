/**
 * datalib.mjs — чистые функции сборщика данных (tools/build_data.mjs): распаковка tar.gz,
 * сопоставление иконок, версии патча и проверка файлов знаний.
 *
 * Вынесены из сборщика, чтобы их можно было проверить тестами без сети (tools/test_data.mjs),
 * и чтобы та же проверка базы знаний работала и при сборке, и в CI на уже собранных данных.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isPlanSkill } from '../assets/analysis.js';

/* ------------------------------ tar ------------------------------ */

/** PAX-заголовок: записи «<длина> ключ=значение\n». */
function parsePax(buf) {
  const out = {};
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp < 0) break;
    const len = parseInt(buf.subarray(off, sp).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= sp - off) break;
    const rec = buf.subarray(sp + 1, off + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}

/**
 * Минимальный распаковщик tar (без внешних зависимостей).
 *
 * Пишутся только обычные файлы: символьные и жёсткие ссылки, устройства и прочее не создаются
 * (через них распаковка могла бы писать за пределы каталога), а путь каждого файла проверяется —
 * запись с «../» или абсолютным путём вне destDir пропускается (tar-slip). Корневая папка архива
 * (как у тарболов GitHub «repo-ref/») срезается. Длинные имена берутся из PAX-заголовка («x»),
 * GNU-записи «L» или поля prefix (ustar).
 *
 * @returns {{written: string[], skipped: string[]}} записанные пути (относительно destDir)
 *   и пропущенные записи архива (имя как в архиве)
 */
export function extractTar(tar, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const destRoot = path.resolve(destDir);
  const written = [];
  const skipped = [];
  let off = 0;
  let nextName = null; // имя следующей записи из PAX/GNU-заголовка
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 136).trim(), 8) || 0;
    const type = String.fromCharCode(header[156]);
    const prefix = field(257, 263).startsWith('ustar') ? field(345, 500) : '';
    const dataStart = off + 512;
    const body = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') { nextName = parsePax(body).path || nextName; continue; }
    if (type === 'L') { nextName = body.toString('utf8').replace(/\0[\s\S]*$/, ''); continue; }
    if (type === 'g' || type === 'K') continue; // глобальный PAX-заголовок, длинное имя ссылки
    const name = nextName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    nextName = null;
    if (type !== '0' && type !== '\0') {
      if (type !== '5') skipped.push(name); // каталоги создаются сами, остальное — сознательно нет
      continue;
    }
    const rel = name.split('/').slice(1).join('/');
    if (!rel) continue;
    const out = path.resolve(destRoot, rel);
    if (!out.startsWith(destRoot + path.sep)) { skipped.push(name); continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    written.push(path.relative(destRoot, out).split(path.sep).join('/'));
  }
  return { written, skipped };
}

/** Распаковка .tar.gz-файла (см. extractTar). */
export function extractTarGz(archive, destDir) {
  return extractTar(zlib.gunzipSync(fs.readFileSync(archive)), destDir);
}

/* ------------------------------ иконки ------------------------------ */

/**
 * Иконки героев по localized_name: сначала точное совпадение имени файла, затем без учёта регистра
 * (если без учёта регистра имя неоднозначно — не используется). Одна иконка не достаётся двум
 * героям, «похожих» героев не подставляем: у героя без своей иконки её просто нет (в интерфейсе —
 * буквенный аватар), и он попадает в missing — сборщик сообщает о нём.
 *
 * @param {Object<string, {localized_name: string}>} heroes slug → герой
 * @param {string[]} iconFiles имена файлов в источнике (например «Anti-Mage.webp»)
 * @returns {{manifest: Object<string, string>, missing: string[]}} manifest: slug → файл источника
 */
export function matchIcons(heroes, iconFiles) {
  const exact = new Map();
  const lower = new Map();
  for (const file of iconFiles) {
    if (!/\.webp$/i.test(file)) continue;
    const base = file.replace(/\.webp$/i, '');
    exact.set(base, file);
    const key = base.toLowerCase();
    lower.set(key, lower.has(key) ? null : file);
  }
  const used = new Set();
  const manifest = {};
  const missing = [];
  for (const [slug, hero] of Object.entries(heroes)) {
    const name = String((hero && hero.localized_name) || '');
    const src = (name && (exact.get(name) || lower.get(name.toLowerCase()))) || null;
    if (!src || used.has(src)) { missing.push(slug); continue; }
    used.add(src);
    manifest[slug] = src;
  }
  return { manifest, missing };
}

/* ------------------------------ версии патча ------------------------------ */

/**
 * «7.41» / «7_41f» → { series: '7.41', major: 7, minor: 41, letter: 'f' }. Серия — основной номер
 * патча, буква — его буквенная версия; их не смешиваем.
 */
export function parsePatchVersion(v) {
  const m = /^(\d+)[._](\d+)([a-z]*)$/.exec(String(v));
  return m ? { series: `${Number(m[1])}.${m[2]}`, major: Number(m[1]), minor: Number(m[2]), letter: m[3] } : null;
}

/** Порядок версий: 7.40 < 7.40b < 7.41 < 7.41a < … < 7.41f < 7.42; серии — как числа. */
export function comparePatchVersions(a, b) {
  const pa = parsePatchVersion(a);
  const pb = parsePatchVersion(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  return pa.major - pb.major || pa.minor - pb.minor || pa.letter.length - pb.letter.length || pa.letter.localeCompare(pb.letter);
}

/**
 * Что взять из patch.json и patchnotes.json dotaconstants.
 * @param {Array<{name:string,date:string,id:number}>} rawPatches патчи (серии) с датами выхода
 * @param {string[]} noteKeys ключи патчноутов («7_41f»)
 * @returns {{series: string, latest: object, prevSeries: string, keepKeys: string[], latestVersion: string}}
 *   series — текущая серия (7.41), latest — запись patch.json о ней (дата выхода серии),
 *   keepKeys — патчноуты текущей и предыдущей серии, latestVersion — последняя версия текущей серии
 *   в патчноутах (7.41f)
 */
export function patchInfo(rawPatches, noteKeys) {
  const patches = (rawPatches || [])
    .filter((p) => p && parsePatchVersion(p.name))
    .sort((a, b) => new Date(a.date) - new Date(b.date) || comparePatchVersions(a.name, b.name));
  const latest = patches[patches.length - 1];
  if (!latest) throw new Error('patch.json: нет ни одной версии патча');
  const series = parsePatchVersion(latest.name).series;
  const allSeries = [...new Set(patches.map((p) => parsePatchVersion(p.name).series))].sort(comparePatchVersions);
  const at = allSeries.indexOf(series);
  const prevSeries = at > 0 ? allSeries[at - 1] : series;
  const keepKeys = noteKeys
    .filter((k) => {
      const v = parsePatchVersion(k);
      return v && comparePatchVersions(v.series, prevSeries) >= 0 && comparePatchVersions(v.series, series) <= 0;
    })
    .sort(comparePatchVersions);
  const own = keepKeys.filter((k) => parsePatchVersion(k).series === series);
  const latestVersion = own.length ? own[own.length - 1].replace('_', '.') : series;
  return { series, latest, prevSeries, keepKeys, latestVersion };
}

/* ------------------------------ база знаний ------------------------------ */

const PLAN_ITEM_GROUPS = ['start', 'early', 'core', 'situational'];
const hasOwn = (obj, key) => typeof key === 'string' && obj !== null && typeof obj === 'object'
  && Object.prototype.hasOwnProperty.call(obj, key);

/** Почему способность нельзя качать: для понятного текста ошибки валидатора. */
function whyUnlearnable(a) {
  if (!a) return 'её нет в данных';
  if (a.granted === 'shard' || a.granted === 'scepter') return `её выдаёт ${a.granted === 'shard' ? 'шард' : 'агханим'}, а не очки способностей`;
  if (a.innate === true) return 'она врождённая (innate) — уровней не имеет';
  const behavior = Array.isArray(a.behavior) ? a.behavior : a.behavior ? [a.behavior] : [];
  if (behavior.includes('Hidden')) return 'это под-способность, а не слот прокачки';
  return 'у неё нет уровней в данных 7.41';
}

/**
 * Ссылки файлов знаний: герои, способности, предметы и теги должны существовать в данных.
 * Отдельно проверяется то, что движок принимает на веру:
 *   • порядок прокачки (plan.skills) — только изучаемые способности 7.41 (не врождённые и не
 *     под-способности): раньше в него попадали Necromastery, Static Field, Eureka!, Dragon Blood,
 *     Greevil's Greed и Mana Shield, то есть то, что качать невозможно;
 *   • picks в rules.json — только герои с мидовым планом (остальных counterPicks игнорирует);
 *   • матчапы — без самопротиворечий: нельзя одновременно «стоять хорошо» и «проигрывать» одному
 *     герою, и два героя не могут взаимно считаться друг для друга выигрышными или проигрышными.
 * @param {{heroes: object, items: object, abilities?: object, kb: Object<string, object>}} input
 *   kb: имя файла → содержимое; abilities — собранные способности (без них проверка прокачки
 *   и матчапов по возможностям пропускается, ссылки всё равно проверяются)
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateKb({ heroes, items, abilities, kb }) {
  const errors = [];
  const warnings = [];
  const itemKey = (entry) => (Array.isArray(entry) ? entry[0] : entry);
  const checkItem = (where, entry) => {
    const key = itemKey(entry);
    if (!hasOwn(items, key)) errors.push(`${where}: предмет «${key}» не найден в данных`);
  };
  const checkHero = (where, slug) => {
    if (hasOwn(heroes, slug)) return true;
    errors.push(`${where}: герой «${slug}» не найден`);
    return false;
  };
  const vocabulary = (kb['tags.json'] && kb['tags.json'].vocabulary) || {};
  const checkTag = (where, tag) => {
    if (!hasOwn(vocabulary, tag)) errors.push(`${where}: тег «${tag}» отсутствует в словаре tags.json`);
  };
  // Герои с мидовым планом: только их движок рассматривает как рекомендацию по пику.
  const midHeroes = new Set();
  for (const [file, data] of Object.entries(kb)) {
    if (!file.startsWith('plans')) continue;
    for (const [slug, plan] of Object.entries(data || {})) {
      if (!slug.startsWith('_') && plan && plan.mid) midHeroes.add(slug);
    }
  }
  const checkPick = (where, slug) => {
    if (!checkHero(where, slug)) return;
    if (midHeroes.size && !midHeroes.has(slug)) {
      errors.push(`${where}: у героя «${slug}» нет мидового плана — counterPicks такой пик игнорирует`);
    }
  };
  // Матчапы планов: slug → множества «кто кого стоит». Разбираем после обхода файлов.
  const beats = new Map();
  const loses = new Map();

  for (const [file, data] of Object.entries(kb)) {
    if (file.startsWith('plans')) {
      for (const [slug, plan] of Object.entries(data || {})) {
        if (slug.startsWith('_')) continue;
        const where = `${file}[${slug}]`;
        if (!checkHero(where, slug)) continue;
        const own = new Set([...(heroes[slug].slots || []).map((s) => s.key), ...(heroes[slug].extra || [])]);
        // Предметы плана лежат в plan.items.{start,early,core,situational}. Прежний валидатор смотрел
        // в plan.start / plan.situational, которых нет, — и предметы планов фактически не проверял.
        const groups = (plan && plan.items) || {};
        for (const group of Object.keys(groups)) {
          if (!PLAN_ITEM_GROUPS.includes(group)) errors.push(`${where}.items: неизвестная группа «${group}»`);
        }
        for (const group of PLAN_ITEM_GROUPS) for (const it of groups[group] || []) checkItem(`${where}.items.${group}`, it);
        const seenSkills = new Set();
        for (const [key] of (plan && plan.skills) || []) {
          if (!own.has(key)) {
            errors.push(`${where}.skills: способность «${key}» не принадлежит герою`);
          } else if (abilities && !isPlanSkill(key, heroes[slug], abilities)) {
            errors.push(`${where}.skills: «${key}» нельзя качать в 7.41 — ${whyUnlearnable(abilities[key])}`);
          }
          if (seenSkills.has(key)) errors.push(`${where}.skills: способность «${key}» указана дважды`);
          seenSkills.add(key);
        }
        const addPair = (map, from, to) => {
          if (!map.has(from)) map.set(from, new Set());
          map.get(from).add(to);
        };
        for (const s of (plan && plan.beats) || []) {
          if (checkHero(`${where}.beats`, s)) addPair(beats, slug, s);
        }
        for (const s of (plan && plan.loses_to) || []) {
          if (checkHero(`${where}.loses_to`, s)) addPair(loses, slug, s);
        }
        if ((beats.get(slug) || new Set()).has(slug) || (loses.get(slug) || new Set()).has(slug)) {
          errors.push(`${where}: герой указан в своих же матчапах`);
        }
      }
    }
    if (file === 'tags.json') {
      for (const [slug, list] of Object.entries((data && data.heroes) || {})) {
        if (slug.startsWith('_')) continue;
        checkHero(`tags.json[${slug}]`, slug);
        for (const tag of list || []) checkTag(`tags.json[${slug}]`, tag);
      }
      const untagged = Object.keys(heroes).filter((s) => !hasOwn((data && data.heroes) || {}, s));
      // Не ошибка: для героя без ручной разметки движок разбирает тексты способностей сам.
      if (untagged.length) warnings.push(`tags.json: без ручной разметки тегов — ${untagged.join(', ')}`);
    }
    if (file === 'rules.json') {
      for (const [tag, rule] of Object.entries((data && data.rules) || {})) {
        checkTag(`rules.json[${tag}]`, tag);
        for (const it of rule.items || []) checkItem(`rules.json[${tag}].items`, it);
        for (const group of Object.keys(rule.item_groups || {})) {
          for (const it of rule.item_groups[group]) checkItem(`rules.json[${tag}].${group}`, it);
        }
        for (const s of rule.picks || []) checkPick(`rules.json[${tag}].picks`, s);
      }
      ((data && data.combos) || []).forEach((combo, i) => {
        for (const tag of combo.tags || []) checkTag(`rules.json[combos#${i}]`, tag);
        for (const it of combo.items || []) checkItem(`rules.json[combos#${i}].items`, it);
        for (const s of combo.picks || []) checkPick(`rules.json[combos#${i}].picks`, s);
      });
    }
    if (file === 'timings.json') {
      for (const ev of (data && data.events) || []) for (const it of ev.items || []) checkItem('timings.json', it);
    }
  }

  // Матчапы: одно утверждение на пару. Противоречия видно в интерфейсе сразу — в разборе лейна
  // подряд появлялись «ты хорошо стоишь против него» и «он давит на тебя».
  const pairs = new Set();
  for (const [from, tos] of beats) for (const to of tos) pairs.add(`${from}\t${to}`);
  for (const [from, tos] of loses) for (const to of tos) pairs.add(`${from}\t${to}`);
  for (const pair of pairs) {
    const [a, b] = pair.split('\t');
    if (a >= b) continue;
    const aBeats = beats.get(a)?.has(b);
    const bBeats = beats.get(b)?.has(a);
    const aLoses = loses.get(a)?.has(b);
    const bLoses = loses.get(b)?.has(a);
    if (aBeats && aLoses) errors.push(`матчапы: «${a}» одновременно стоит против «${b}» и проигрывает ему`);
    if (bBeats && bLoses) errors.push(`матчапы: «${b}» одновременно стоит против «${a}» и проигрывает ему`);
    if (aBeats && bBeats) errors.push(`матчапы: «${a}» и «${b}» взаимно считаются выигрышными`);
    if (aLoses && bLoses) errors.push(`матчапы: «${a}» и «${b}» взаимно считаются проигрышными`);
  }
  return { errors, warnings };
}

/** Все строки объекта (рекурсивно). */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

/** Расстояние Левенштейна с ранним выходом (нам интересны только 1–2 правки). */
function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const normName = (s) => String(s).toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Названия способностей в текстах планов героев:
 *  • устаревшее название — в тексте стоит имя из ключа способности (furion_force_of_nature →
 *    «Force of Nature»), а в данных у неё уже другое имя («Nature's Call»);
 *  • вероятная опечатка — фраза отличается от имени способности героя на 1–2 буквы
 *    («Wyrn's Wrath» вместо «Wyrm's Wrath»); множественное число опечаткой не считается.
 * @returns {string[]} найденные проблемы
 */
export function kbTextIssues({ heroes, abilities, items, plans }) {
  const issues = [];
  const known = new Set();
  for (const a of Object.values(abilities)) if (a && a.dname) known.add(normName(a.dname));
  for (const it of Object.values(items || {})) if (it && it.dname) known.add(normName(it.dname));
  for (const h of Object.values(heroes)) if (h && h.localized_name) known.add(normName(h.localized_name));
  for (const [slug, plan] of Object.entries(plans)) {
    if (slug.startsWith('_') || !hasOwn(heroes, slug)) continue;
    const text = collectStrings(plan).join('\n');
    const lower = normName(text);
    const own = [...(heroes[slug].slots || []).map((s) => s.key), ...(heroes[slug].extra || [])];
    const ownNames = own.map((k) => abilities[k] && abilities[k].dname).filter(Boolean);
    for (const key of own) {
      const dname = abilities[key] && abilities[key].dname;
      if (!dname || !key.startsWith(`${slug}_`)) continue;
      const fromKey = key.slice(slug.length + 1).replace(/_/g, ' ');
      if (fromKey.split(' ').length < 2 || fromKey.replace(/'/g, '') === normName(dname).replace(/'/g, '')) continue;
      const re = new RegExp(`(^|[^a-z])${escapeRe(fromKey)}($|[^a-z])`);
      if (re.test(lower) && !lower.includes(normName(dname))) {
        issues.push(`${slug}: устаревшее название «${fromKey}» — в данных «${dname}»`);
      }
    }
    const phraseRe = /\b([A-Z][A-Za-z'’]+(?:[ -](?:of|the|[A-Z][A-Za-z'’]+)){1,4})/g;
    let m;
    while ((m = phraseRe.exec(text))) {
      const phrase = normName(m[1]);
      if (phrase.length < 8 || known.has(phrase)) continue;
      for (const name of ownNames) {
        const dn = normName(name);
        if (phrase === `${dn}s` || `${phrase}s` === dn) continue;
        const d = editDistance(phrase, dn);
        if (d > 0 && d <= 2) issues.push(`${slug}: вероятная опечатка «${m[1]}» — способность называется «${name}»`);
      }
    }
  }
  return [...new Set(issues)];
}
