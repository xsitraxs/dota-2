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
 *   node tools/build_data.mjs                      # скачает свежие источники в tools/.cache и соберёт data/
 *   node tools/build_data.mjs --cached             # соберёт из уже скачанного в tools/.cache (без сети)
 *   node tools/build_data.mjs --offline <dir>      # возьмёт уже распакованный dotaconstants из <dir>
 *
 * После смены иконок пересоберите подписи для распознавания: node tools/build_templates.mjs.
 *
 * Что делает:
 *   - режет тяжёлые JSON-ы dotaconstants до нужных полей (data/heroes.json, abilities.json, items.json, patchnotes.json);
 *   - копирует иконки в data/icons/ и строит манифест;
 *   - агрегирует изменения текущей серии патча (например, 7.41 и 7.41a…f) по героям и предметам;
 *   - ВАЛИДИРУЕТ файлы знаний data/kb/*.json: все ссылки на героев, способности, предметы и теги
 *     должны существовать в игровых данных, а в текстах планов не должно быть устаревших названий
 *     способностей (tools/datalib.mjs). Это защищает от устаревших названий.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractTarGz, matchIcons, patchInfo, parsePatchVersion, validateKb, kbTextIssues,
} from './datalib.mjs';

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

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const trim = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : s);
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 1));
  log(`  → ${path.relative(ROOT, p)} (${(fs.statSync(p).size / 1024).toFixed(0)} КБ)`);
};

// ---------- источники ----------

/** --cached: собрать из уже скачанного; по умолчанию архивы скачиваются заново («свежие» данные). */
const USE_CACHE = process.argv.includes('--cached');

/**
 * Архив репозитория в tools/.cache и его распакованная копия. Без --cached архив скачивается
 * заново и распаковывается в чистый каталог — раньше однажды скачанный кэш использовался вечно,
 * и «обновление базы» молча пересобирало старые данные.
 */
async function fetchRepo(repo, ref, name, marker) {
  const tarPath = path.join(CACHE, `${name}.tar.gz`);
  const dir = path.join(CACHE, name);
  const cached = fs.existsSync(tarPath);
  if (USE_CACHE && !cached) throw new Error(`--cached: нет ${path.relative(ROOT, tarPath)} — запустите сборку без --cached`);
  if (USE_CACHE) {
    log(`Кэш: ${path.relative(ROOT, tarPath)}`);
  } else {
    log(`Скачиваю ${repo}@${ref}…`);
    await download(`https://codeload.github.com/${repo}/tar.gz/refs/heads/${ref}`, tarPath);
  }
  if (!USE_CACHE || !fs.existsSync(path.join(dir, marker))) {
    fs.rmSync(dir, { recursive: true, force: true });
    const { skipped } = extractTarGz(tarPath, dir);
    if (skipped.length) log(`  пропущено записей архива (не обычные файлы или путь вне каталога): ${skipped.length}`);
  }
  return dir;
}

async function getConstants() {
  const argIdx = process.argv.indexOf('--offline');
  if (argIdx !== -1 && process.argv[argIdx + 1]) {
    const dir = process.argv[argIdx + 1];
    log(`Источник dotaconstants: локальная папка ${dir}`);
    return dir;
  }
  const dir = await fetchRepo(DOTA_CONSTANTS_REPO, DOTA_CONSTANTS_REF, 'dotaconstants', path.join('build', 'heroes.json'));
  log(`Версия dotaconstants: ${readJson(path.join(dir, 'package.json')).version}`);
  return dir;
}

async function getIcons() {
  const dir = await fetchRepo(ICONS_REPO, ICONS_REF, 'icons', 'heroIcons');
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

// ---- 1. Патчноуты: текущая и предыдущая серии, изменения текущей серии (7.41 и 7.41a…f) ----
// Серия (7.41) и её буквенные версии (7.41f) — разные вещи: дата из patch.json — дата выхода серии,
// а последняя буквенная версия берётся из патчноутов (meta.latestVersion).
const patches = patchInfo(rawPatches, Object.keys(rawPatchnotes));
const latestPatch = patches.latest;
const major = patches.series; // напр. "7.41"
const patchKeysForNotes = patches.keepKeys;
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
  const isCurrentSeries = parsePatchVersion(pk)?.series === major; // 7.41, 7.41a … 7.41f — но не 7.410
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
  latestVersion: patches.latestVersion,
  heroes: Object.keys(heroesOut).length,
  items: Object.keys(itemsOut).length,
});

// ---- 5. Иконки ----
log('\nКопирую иконки героев …');
const iconsDir = await getIcons();
const iconMatch = matchIcons(heroesOut, fs.readdirSync(iconsDir));
const iconsOut = path.join(DATA, 'icons');
fs.mkdirSync(iconsOut, { recursive: true });
const manifest = {};
for (const [slug, src] of Object.entries(iconMatch.manifest)) {
  fs.copyFileSync(path.join(iconsDir, src), path.join(iconsOut, `${slug}.webp`));
  manifest[slug] = `${slug}.webp`;
}
// Файлы героев, которых больше нет в данных (переименование, удаление), убираем: иначе по ним
// собрались бы подписи распознавания для несуществующих слагов.
const stale = fs.readdirSync(iconsOut).filter((f) => f.endsWith('.webp') && !Object.values(manifest).includes(f));
for (const f of stale) fs.rmSync(path.join(iconsOut, f));
fs.writeFileSync(path.join(DATA, 'icons.json'), JSON.stringify(manifest, null, 1));
log(`  иконок скопировано: ${Object.keys(manifest).length}/${Object.keys(heroesOut).length}${stale.length ? `, удалено устаревших: ${stale.join(', ')}` : ''}`);
if (iconMatch.missing.length) {
  // Чужие картинки вместо недостающих не подставляем: в интерфейсе будет буквенный аватар,
  // а распознавание по скриншоту этих героев не найдёт (их нет среди шаблонов).
  log(`  ⚠ без иконки в источнике (буквенный аватар, не распознаются на скриншоте): ${iconMatch.missing.map((s) => heroesOut[s].localized_name).join(', ')}`);
}

// ---- 6. Валидация файлов знаний ----
log('\nПроверяю data/kb/*.json …');
const kbFiles = fs.existsSync(KB) ? fs.readdirSync(KB).filter((f) => f.endsWith('.json')).sort() : [];
writeJson(path.join(DATA, 'kb_index.json'), { files: kbFiles });
const kbData = Object.fromEntries(kbFiles.map((f) => [f, readJson(path.join(KB, f))]));
const kbCheck = validateKb({ heroes: heroesOut, items: itemsOut, kb: kbData });
const plansAll = Object.assign({}, ...kbFiles.filter((f) => f.startsWith('plans')).map((f) => kbData[f]));
const errors = [...kbCheck.errors, ...kbTextIssues({ heroes: heroesOut, abilities: abilitiesOut, items: itemsOut, plans: plansAll })];
for (const w of kbCheck.warnings) log(`  ⚠ ${w}`);

if (errors.length) {
  log('\n❌ ОШИБКИ ВАЛИДАЦИИ:');
  for (const e of errors) log('   • ' + e);
  process.exitCode = 1;
} else {
  log(`  ✓ всё чисто (файлов знаний: ${kbFiles.length})`);
}

log(`\nГотово. Серия ${major} (вышла ${latestPatch.date.slice(0, 10)}), патчноуты до ${patches.latestVersion}. Героев: ${Object.keys(heroesOut).length}, предметов: ${Object.keys(itemsOut).length}.`);
log('Если менялись иконки, пересоберите подписи распознавания: node tools/build_templates.mjs');
