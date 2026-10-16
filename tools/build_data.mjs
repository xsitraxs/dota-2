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
/**
 * Скалярное поле: пустой массив источника — это «данных нет», а не пустой список. У 19 способностей
 * `dmg_type`, `bkbpierce` и `behavior` приходили как `[]`, и из-за этого карточка Huskar и Dark Seer
 * печатала «тип урона: » без значения (пустой массив в JS истинен). Списки (attrib, abilities,
 * patchNotes, extra) не трогаем: пустой список — законное значение, его и ждут потребители.
 */
const scalar = (v) => (Array.isArray(v) && v.length === 0 ? null : v ?? null);

const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Перевод строки в конце — как у остальных файлов репозитория (и как пишет build_templates.mjs):
  // без него git помечает каждый сгенерированный файл «No newline at end of file», а kb_index.json
  // после каждой сборки показывал диф из-за одного отсутствующего байта.
  fs.writeFileSync(p, JSON.stringify(obj, null, 1) + '\n');
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
// aghs_desc.json в источнике — список записей по героям (а не словарь по способностям).
const rawAghs = readJson(path.join(build, 'aghs_desc.json'));
const rawPatches = readJson(path.join(build, 'patch.json'));

/**
 * Патчноуты источника приходят с разметкой клиента: <br>, <span class="Subtitle">…</span>,
 * <font color="#F05039">…</font>. Интерфейс печатал их как обычный текст («&lt;br&gt;» в списке
 * изменений), поэтому теги и HTML-сущности вычищаются ещё при сборке — и во вкладке «Патч»,
 * и в карточках героев/предметов. Записи, от которых после чистки ничего не осталось
 * (одиночный <br>), выбрасываются: пустых строк в списках изменений быть не должно.
 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function cleanNote(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => (Object.prototype.hasOwnProperty.call(ENTITIES, e)
      ? ENTITIES[e]
      : e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : m))
    .replace(/\s+/g, ' ')
    .trim();
}
const cleanNotesTree = (value) => {
  if (typeof value === 'string') return cleanNote(value);
  if (Array.isArray(value)) return value.map(cleanNotesTree).filter((v) => v !== '');
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanNotesTree(v)]));
  return value;
};
const rawPatchnotes = cleanNotesTree(readJson(path.join(build, 'patchnotes.json')));

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

/**
 * Сколько уровней у способности: самая длинная шкала среди attrib/mc/cd. У изучаемых способностей
 * уровни есть (4 у базовых, 3 у ультов), у врождённых и под-способностей шкалы нет (0) — по этому
 * признаку движок и валидатор базы знаний отличают то, что можно качать.
 */
const abilityLevels = (a) => {
  let n = 0;
  for (const at of a.attrib || []) if (Array.isArray(at.value)) n = Math.max(n, at.value.length);
  for (const f of ['mc', 'cd']) if (Array.isArray(a[f])) n = Math.max(n, a[f].length);
  return n;
};

/**
 * Способность, которая «разблокируется» на уровне героя (Invoke у Invoker: качается сам на 6/12/18
 * и выдаёт дополнительное очко). В источнике это первый способ узнать, что врождённую запись всё
 * же можно считать ультимейтом, а не пассивкой.
 */
const abilityFirstLevel = (a) => {
  for (const at of a.attrib || []) {
    if (at.key !== 'first_ability_level') continue;
    return Number(at.value);
  }
  return null;
};

/**
 * Способности, которые герой получает не очками, а предметом: шард/агханим даёт «новую способность»
 * (Warp Flare у Tinker, Nimbus и Lightning Hands у Zeus, Fireball у Dragon Knight, Cold Blooded у
 * Medusa). В aghs_desc.json они помечены флагом *_new_skill, но названием — ключ ищем только среди
 * способностей этого героя, иначе одноимённая Fireball чёрного дракона попала бы в тот же список.
 */
const grantedByKey = {};
for (const entry of Array.isArray(rawAghs) ? rawAghs : []) {
  const slug = slugify(entry.hero_name || '');
  const keys = new Set([...(heroSlots[slug]?.slots || []).map((s) => s.key), ...(heroSlots[slug]?.extra || [])]);
  for (const [flag, nameField, kind] of [
    ['shard_new_skill', 'shard_skill_name', 'shard'],
    ['scepter_new_skill', 'scepter_skill_name', 'scepter'],
  ]) {
    if (entry[flag] !== true || !entry[nameField]) continue;
    const key = [...keys].find((k) => rawAbilities[k] && rawAbilities[k].dname === entry[nameField]);
    if (key) grantedByKey[key] = kind;
  }
}

const abilitiesOut = {};
for (const key of neededAbilityKeys) {
  const a = rawAbilities[key];
  if (!a) continue;
  abilitiesOut[key] = {
    dname: a.dname,
    behavior: scalar(a.behavior),
    dmg_type: scalar(a.dmg_type),
    bkbpierce: scalar(a.bkbpierce),
    dispellable: scalar(a.dispellable),
    // null, а не пустая строка: у 34 способностей (новые герои и врождённые пассивки) в источнике
    // описания нет вовсе — в карточке останутся цифры, и это должно быть видно, а не «пусто».
    desc: trim(a.desc || '', 700) || null,
    mc: scalar(a.mc),
    cd: scalar(a.cd),
    // Врождённая способность 7.41 (Necromastery, Static Field, Eureka!): её не качают.
    innate: a.is_innate === true,
    // Сколько уровней у способности и на каком уровне героя её выдают: по этим двум числам
    // движок отличает то, что качают очками, от врождённых пассивок и под-способностей.
    levels: abilityLevels(a),
    firstLevel: abilityFirstLevel(a),
    // 'shard' | 'scepter' — способность выдаётся предметом (Warp Flare, Nimbus, Fireball).
    granted: grantedByKey[key] || undefined,
    // Только подпись и значение: ключ характеристики (percent_damage_per_burn) интерфейсу не нужен,
    // подпись есть у всех 5703 строк, а 95 КБ ключей — десятая часть файла. У предметов наоборот:
    // там подписи нет ни у одной из 1540 строк, и ключ служит ярлыком.
    attrib: (a.attrib || []).filter((r) => r.header).slice(0, 12).map(({ header, value }) => ({ header, value })),
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
  // Снаряд есть только у дальнего боя. В константах у милишников лежит заглушка (900 или 0),
  // из-за которой движок прибавлял им +0.33 с «полёта снаряда», а карточка показывала «Снаряд: 900».
  if (h.attack_type !== 'Ranged') stats.projectile_speed = null;
  heroesOut[slug] = {
    slug,
    id: Number(id),
    name: h.name,
    localized_name: h.localized_name,
    primary_attr: h.primary_attr,
    attack_type: h.attack_type,
    // cm_enabled источника не выводим: он true у всех 127 героев, то есть не несёт информации.
    roles: h.roles,
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
    // Подсказка источника («Activate to redeem a Tier 1 Neutral Item…»): у части предметов
    // это единственное описание, которое вообще есть (жетоны тиров, Leviathan's Fish).
    hint: it.hint && it.hint.length ? it.hint.slice(0, 4) : undefined,
    mc: it.mc ?? null,
    cd: it.cd ?? null,
    components: it.components || null,
    abilities: (it.abilities || []).map((a) => ({
      type: a.type,
      title: a.title,
      description: trim(a.description || '', 420),
    })),
    // display — готовая строка вида «+ {value} Move Speed (Ranged Heroes)»: без неё карточка
    // предмета показывала только имя и цену (87 из 409 карточек были пустыми).
    attrib: (it.attrib || []).slice(0, 10).map(({ key: k, header, display, value }) => ({ key: k, header, display, value })),
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
fs.writeFileSync(path.join(DATA, 'icons.json'), JSON.stringify(manifest, null, 1) + '\n');
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
const kbCheck = validateKb({ heroes: heroesOut, items: itemsOut, abilities: abilitiesOut, kb: kbData });
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
