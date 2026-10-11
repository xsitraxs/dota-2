#!/usr/bin/env node
/**
 * build_data.mjs — собирает локальный датасет для драфт-помощника из открытых источников.
 *
 * Источники:
 *   1. odota/dotaconstants  — официальные игровые константы Dota 2 (герои, способности, предметы, патчноуты).
 *      Лицензия MIT. Данные обновляются автоматически из клиента игры.
 *   2. M-Hasan-Ibrahim/Dota2HeroInfoAndIcons — иконки героев (webp), используются как локальные ассеты.
 *
 * Использование:
 *   node tools/build_data.mjs                      # скачает источники в tools/.cache и соберёт data/
 *   node tools/build_data.mjs --offline <dir>      # возьмёт уже распакованный dotaconstants из <dir>
 *
 * Что делает:
 *   - режет тяжёлые JSON-ы dotaconstants до нужных полей (data/heroes.json, abilities.json, items.json, patchnotes.json);
 *   - копирует иконки в data/icons/ и строит манифест;
 *   - агрегирует изменения текущего патча (7.41*) по героям и предметам;
 *   - ВАЛИДИРУЕТ файлы знаний data/kb/*.json: все ссылки на героев, способности и предметы
 *     должны существовать в игровых данных. Это защищает от устаревших названий предметов.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
const DATA = path.join(ROOT, 'data');
const KB = path.join(DATA, 'kb');

const DOTA_CONSTANTS_REPO = 'odota/dotaconstants';
const DOTA_CONSTANTS_REF = 'master';
const ICONS_REPO = 'M-Hasan-Ibrahim/Dota2HeroInfoAndIcons';
const ICONS_REF = 'main';

// ---------- утилиты ----------

function log(...a) { console.log(...a); }

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return dest;
}

/** Минимальный распаковщик tar.gz (без внешних зависимостей). */
function extractTarGz(archive, destDir) {
  const tar = zlib.gunzipSync(fs.readFileSync(archive));
  fs.mkdirSync(destDir, { recursive: true });
  const destRoot = path.resolve(destDir);
  let off = 0;
  const written = [];
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const dataStart = off + 512;
    const rel = name.split('/').slice(1).join('/'); // срезаем корневую папку архива
    // Пишем только обычные файлы: PAX/GNU-заголовки ('x', 'g', 'L') пропускаем,
    // а путь проверяем, чтобы запись не вышла за пределы каталога (защита от tar-slip).
    if (rel && (type === '0' || type === '\0')) {
      const out = path.resolve(destDir, rel);
      if (out.startsWith(destRoot + path.sep)) {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, tar.subarray(dataStart, dataStart + size));
        written.push(rel);
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return written;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const trim = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : s);
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
  log(`  → ${path.relative(ROOT, p)} (${(fs.statSync(p).size / 1024).toFixed(0)} КБ)`);
};

// ---------- источник dotaconstants ----------

async function getConstants() {
  const argIdx = process.argv.indexOf('--offline');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    const dir = process.argv[argIdx + 1];
    log(`Источник dotaconstants: локальная папка ${dir}`);
    return dir;
  }
  const tarPath = path.join(CACHE, 'dotaconstants.tar.gz');
  if (!fs.existsSync(tarPath)) {
    log(`Скачиваю ${DOTA_CONSTANTS_REPO}@${DOTA_CONSTANTS_REF}…`);
    await download(`https://codeload.github.com/${DOTA_CONSTANTS_REPO}/tar.gz/refs/heads/${DOTA_CONSTANTS_REF}`, tarPath);
  } else {
    log(`Кэш: ${path.relative(ROOT, tarPath)}`);
  }
  const dir = path.join(CACHE, 'dotaconstants');
  if (!fs.existsSync(path.join(dir, 'build', 'heroes.json'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    extractTarGz(tarPath, dir);
  }
  const pkg = readJson(path.join(dir, 'package.json'));
  log(`Версия dotaconstants: ${pkg.version}`);
  return dir;
}

async function getIcons() {
  const tarPath = path.join(CACHE, 'icons.tar.gz');
  if (!fs.existsSync(tarPath)) {
    log(`Скачиваю иконки ${ICONS_REPO}@${ICONS_REF}…`);
    await download(`https://codeload.github.com/${ICONS_REPO}/tar.gz/refs/heads/${ICONS_REF}`, tarPath);
  }
  const dir = path.join(CACHE, 'icons');
  if (!fs.existsSync(path.join(dir, 'heroIcons'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    extractTarGz(tarPath, dir);
  }
  return path.join(dir, 'heroIcons');
}

// ---------- основная сборка ----------

const constDir = await getConstants();
const build = path.join(constDir, 'build');
const rawHeroes = readJson(path.join(build, 'heroes.json'));
const rawHeroAbilities = readJson(path.join(build, 'hero_abilities.json'));
const rawAbilities = readJson(path.join(build, 'abilities.json'));
const rawItems = readJson(path.join(build, 'items.json'));
const rawPatchnotes = readJson(path.join(build, 'patchnotes.json'));
const rawPatches = readJson(path.join(build, 'patch.json'));

const slugify = (npc) => npc.replace(/^npc_dota_hero_/, '');

// ---- 1. Патчноуты: оставляем последние крупные патчи, считаем изменения текущей серии ----
const patchesSorted = rawPatches.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
const latestPatch = patchesSorted[patchesSorted.length - 1];
const major = latestPatch.name.split('.')[0] + '.' + latestPatch.name.split('.')[1]; // напр. "7.41"
const patchKeysForNotes = Object.keys(rawPatchnotes).filter((k) => {
  const v = k.replace(/_/g, '.');
  return parseFloat(v) >= 7.4;
});
const notesByHero = {}; // slug -> [строки изменений]
const notesByItem = {}; // item key -> [строки]
const patchnotesOut = {};

for (const pk of patchKeysForNotes) {
  const note = rawPatchnotes[pk];
  patchnotesOut[pk.replace(/_/g, '.')] = {
    general: note.general || [],
    items: note.items || {},
    heroes: note.heroes || {},
  };
  const isCurrentSeries = pk.replace(/_/g, '.').startsWith(major);
  if (!isCurrentSeries) continue;
  for (const [slug, abilities] of Object.entries(note.heroes || {})) {
    notesByHero[slug] ||= [];
    if (Array.isArray(abilities)) notesByHero[slug].push(...abilities.map((t) => `[${pk.replace(/_/g, '.')}] ${t}`));
    else for (const [ab, changes] of Object.entries(abilities)) notesByHero[slug].push(...changes.map((t) => `[${ab}] ${t}`));
  }
  for (const [item, changes] of Object.entries(note.items || {})) {
    notesByItem[item] ||= [];
    notesByItem[item].push(...changes.map((t) => t));
  }
}

// ---- 2. Способности: только те, что нужны героям ----
const neededAbilityKeys = new Set();
const heroSlots = {}; // slug -> {slots:[{i,key}], extra:[key]}
for (const h of Object.values(rawHeroes)) {
  const slug = slugify(h.name);
  const list = (rawHeroAbilities[h.name] || {}).abilities || [];
  const slots = [];
  const extra = [];
  const seen = new Set();
  list.forEach((key, i) => {
    if (!key || key === 'generic_hidden') return;
    neededAbilityKeys.add(key);
    const dname = rawAbilities[key]?.dname || '';
    if (i <= 5) slots.push({ i, key, dname });
    else if (!seen.has(dname)) extra.push(key);
    seen.add(dname);
  });
  heroSlots[slug] = { slots, extra };
}

const abilitiesOut = {};
for (const key of neededAbilityKeys) {
  const a = rawAbilities[key];
  if (!a) continue;
  abilitiesOut[key] = {
    dname: a.dname,
    behavior: a.behavior || [],
    dmg_type: a.dmg_type || null,
    bkbpierce: a.bkbpierce ?? null,
    dispellable: a.dispellable ?? null,
    desc: trim(a.desc || '', 700),
    lore: undefined,
    mc: a.mc ?? null,
    cd: a.cd ?? null,
    attrib: (a.attrib || []).slice(0, 12).map(({ key: k, header, value }) => ({ key: k, header, value })),
    type: a.type || null,
  };
}

// ---- 3. Герои ----
const STAT_KEYS = [
  'base_health', 'base_health_regen', 'base_mana', 'base_mana_regen', 'base_armor', 'base_mr',
  'base_attack_min', 'base_attack_max', 'base_str', 'base_agi', 'base_int',
  'str_gain', 'agi_gain', 'int_gain', 'attack_range', 'projectile_speed', 'attack_rate',
  'base_attack_time', 'attack_point', 'move_speed', 'turn_rate', 'legs', 'day_vision', 'night_vision',
];
const heroesOut = {};
for (const [id, h] of Object.entries(rawHeroes)) {
  const slug = slugify(h.name);
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = h[k] ?? null;
  heroesOut[slug] = {
    slug,
    id: Number(id),
    name: h.name,
    localized_name: h.localized_name,
    primary_attr: h.primary_attr,
    attack_type: h.attack_type,
    roles: h.roles,
    cm_enabled: h.cm_enabled,
    stats,
    slots: heroSlots[slug]?.slots || [],
    extra: heroSlots[slug]?.extra || [],
    notes: notesByHero[slug] || [],
  };
}

// ---- 4. Предметы ----
const itemsOut = {};
for (const [key, it] of Object.entries(rawItems)) {
  const isRecipe = key.startsWith('recipe_');
  if (!isRecipe && !it.dname) continue;
  itemsOut[key] = {
    dname: it.dname || key,
    cost: it.cost ?? null,
    qual: it.qual || null,
    tier: it.tier ?? null,
    behavior: it.behavior || null,
    notes: trim(it.notes || '', 260),
    mc: it.mc ?? null,
    cd: it.cd ?? null,
    components: it.components || null,
    abilities: (it.abilities || []).map((a) => ({
      type: a.type,
      title: a.title,
      description: trim(a.description || '', 420),
    })),
    attrib: (it.attrib || []).slice(0, 10).map(({ key: k, header, value }) => ({ key: k, header, value })),
    recipe: isRecipe || undefined,
    patchNotes: notesByItem[key] || [],
  };
}

log('\nСобираю data/ …');
writeJson(path.join(DATA, 'heroes.json'), heroesOut);
writeJson(path.join(DATA, 'abilities.json'), abilitiesOut);
writeJson(path.join(DATA, 'items.json'), itemsOut);
writeJson(path.join(DATA, 'patchnotes.json'), patchnotesOut);
writeJson(path.join(DATA, 'meta.json'), {
  generatedAt: new Date().toISOString(),
  constantsVersion: readJson(path.join(constDir, 'package.json')).version,
  constantsSource: `https://github.com/${DOTA_CONSTANTS_REPO}`,
  iconsSource: `https://github.com/${ICONS_REPO}`,
  latestPatch: latestPatch.name,
  latestPatchId: latestPatch.id,
  latestPatchDate: latestPatch.date,
  patchSeries: major,
  heroes: Object.keys(heroesOut).length,
  items: Object.keys(itemsOut).length,
});

// ---- 5. Иконки ----
log('\nКопирую иконки героев …');
const iconsDir = await getIcons();
const iconFiles = fs.readdirSync(iconsDir).filter((f) => f.endsWith('.webp'));
const byLocal = new Map(iconFiles.map((f) => [f.replace(/\.webp$/, ''), f]));
const byLocalLower = new Map(iconFiles.map((f) => [f.replace(/\.webp$/, '').toLowerCase(), f]));
fs.mkdirSync(path.join(DATA, 'icons'), { recursive: true });
const manifest = {};
let copied = 0;
for (const [slug, h] of Object.entries(heroesOut)) {
  // Сопоставление по localized_name; запасной вариант — без учёта регистра.
  const src = byLocal.get(h.localized_name) || byLocalLower.get(String(h.localized_name).toLowerCase());
  if (!src) continue;
  const dst = path.join(DATA, 'icons', `${slug}.webp`);
  fs.copyFileSync(path.join(iconsDir, src), dst);
  manifest[slug] = `${slug}.webp`;
  copied++;
}
fs.writeFileSync(path.join(DATA, 'icons.json'), JSON.stringify(manifest, null, 1));
const missingIcons = Object.keys(heroesOut).filter((s) => !manifest[s]);
log(`  иконок скопировано: ${copied}/${Object.keys(heroesOut).length}`);
if (missingIcons.length) log(`  без иконки (будет буквенный аватар): ${missingIcons.map((s) => heroesOut[s].localized_name).join(', ')}`);

// ---- 6. Валидация файлов знаний ----
log('\nПроверяю data/kb/*.json …');
const kbFiles = fs.existsSync(KB) ? fs.readdirSync(KB).filter((f) => f.endsWith('.json')).sort() : [];
writeJson(path.join(DATA, 'kb_index.json'), { files: kbFiles });
const errors = [];
const itemKeysRaw = new Set(Object.keys(itemsOut));

/** Записи предметов допускаются как строка-ключ, так и пара [ключ, причина]. */
function normKey(entry) {
  return Array.isArray(entry) ? entry[0] : entry;
}
function checkItem(where, entry) {
  const key = normKey(entry);
  if (!itemKeysRaw.has(key)) { errors.push(`${where}: предмет «${key}» не найден среди предметов 7.41`); return false; }
  return true;
}
function checkHero(where, slug) {
  if (!heroesOut[slug]) { errors.push(`${where}: герой «${slug}» не найден`); return false; }
  return true;
}

for (const f of kbFiles) {
  const data = readJson(path.join(KB, f));
  if (f.startsWith('plans')) {
    for (const [slug, plan] of Object.entries(data)) {
      if (slug.startsWith('_')) continue;
      const where = `${f}[${slug}]`;
      if (!checkHero(where, slug)) continue;
      const heroAbilityKeys = new Set([
        ...heroesOut[slug].slots.map((s) => s.key),
        ...heroesOut[slug].extra,
      ]);
      for (const group of ['start', 'early', 'core']) {
        for (const it of plan[group] || []) checkItem(`${where}.${group}`, it);
      }
      for (const it of plan.situational || []) checkItem(`${where}.situational`, it);
      for (const [key] of plan.skills || []) {
        if (!heroAbilityKeys.has(key)) errors.push(`${where}.skills: способность «${key}» не принадлежит герою`);
      }
      for (const s of plan.beats || []) checkHero(`${where}.beats`, s);
      for (const s of plan.loses_to || []) checkHero(`${where}.loses_to`, s);
    }
  }
  if (f === 'tags.json') {
    for (const [slug, tags] of Object.entries(data.heroes || {})) {
      if (slug.startsWith('_')) continue;
      checkHero(`tags.json[${slug}]`, slug);
      for (const tag of tags) if (!(data.vocabulary || {})[tag]) errors.push(`tags.json[${slug}]: неизвестный тег «${tag}»`);
    }
  }
  if (f === 'rules.json') {
    for (const combo of data.combos || []) for (const it of combo.items || []) checkItem('rules.json[combos]', it);
    for (const combo of data.combos || []) for (const s2 of combo.picks || []) checkHero('rules.json[combos]', s2);
    for (const [tag, rule] of Object.entries(data.rules || {})) {
      for (const it of rule.items || []) checkItem(`rules.json[${tag}].items`, it);
      for (const group of Object.keys(rule.item_groups || {})) for (const it of rule.item_groups[group]) checkItem(`rules.json[${tag}].${group}`, it);
      for (const s of rule.picks || []) checkHero(`rules.json[${tag}].picks`, s);
    }
  }
  if (f === 'timings.json') {
    for (const ev of data.events || []) if (ev.items) for (const it of ev.items) checkItem('timings.json', it);
  }
}

if (errors.length) {
  log('\n❌ ОШИБКИ ВАЛИДАЦИИ:');
  for (const e of errors) log('   • ' + e);
  process.exitCode = 1;
} else {
  log(`  ✓ всё чисто (файлов знаний: ${kbFiles.length})`);
}

log(`\nГотово. Патч ${latestPatch.name} от ${latestPatch.date.slice(0, 10)}. Героев: ${Object.keys(heroesOut).length}, предметов: ${Object.keys(itemsOut).length}.`);
