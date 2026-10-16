#!/usr/bin/env node
/**
 * test_data.mjs — проверки сборщика данных и согласованности того, что уезжает в прод.
 * Запуск: node tools/test_data.mjs (входит в npm test, сеть не нужна)
 *
 *   1. Распаковка tar: обычные файлы пишутся, «../», абсолютные пути и ссылки — нет.
 *   2. Иконки: неполный набор источника → честный список пропусков, без чужих картинок.
 *   3. Версии патча: серия (7.41) и буквенная версия (7.41f) не смешиваются, порядок версий.
 *   4. База знаний: ссылки на героев/способности/предметы/теги и названия способностей в текстах.
 *   5. Собранные данные: meta, иконки, шаблоны распознавания, индекс базы знаний.
 *   6. Документация: числа и версии в README совпадают с данными.
 * Количества не зашиты: ожидания считаются из самих данных, поэтому новые герои/предметы
 * тесты не ломают (кроме README — если его числа устарели, тест укажет, что поправить).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  extractTar, extractTarGz, matchIcons, parsePatchVersion, comparePatchVersions, patchInfo, validateKb, kbTextIssues,
} from './datalib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const J = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ------------------------------ 1. tar ------------------------------ */
console.log('\n1. Распаковка tar.gz');

/** Запись ustar-архива (заголовок 512 байт + данные, выровненные по 512). */
function tarEntry(name, body = '', { type = '0', prefix = '', linkname = '' } = {}) {
  const header = Buffer.alloc(512, 0);
  const data = Buffer.from(body);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(linkname, 157, 100);
  header.write('ustar\0', 257);
  header.write('00', 263);
  if (prefix) header.write(prefix, 345, 155);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
/** PAX-запись «<длина> path=…\n»: длина включает собственные цифры. */
function paxPath(value) {
  const rest = ` path=${value}\n`;
  let len = rest.length + 1;
  while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
  return `${len}${rest}`;
}
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-'));
  const dest = path.join(tmp, 'out');
  const longName = `root/${'a'.repeat(120)}.txt`;
  const archive = Buffer.concat([
    tarEntry('root/', '', { type: '5' }),
    tarEntry('root/ok.txt', 'ok'),
    tarEntry('root/sub/deep.txt', 'deep'),
    tarEntry('root/../../evil.txt', 'evil'),
    tarEntry('root/../evil2.txt', 'evil2'),
    tarEntry('/etc/passwd-copy', 'abs'),
    tarEntry('root/link', '', { type: '2', linkname: '/etc/passwd' }),
    tarEntry('root/hard', '', { type: '1', linkname: 'root/ok.txt' }),
    tarEntry('PaxHeader', paxPath(longName), { type: 'x' }),
    tarEntry(longName.slice(0, 100), 'long'),
    tarEntry('file.txt', 'prefixed', { prefix: 'root/dir' }),
    Buffer.alloc(1024, 0),
  ]);
  const gz = path.join(tmp, 'a.tar.gz');
  fs.writeFileSync(gz, zlib.gzipSync(archive));
  const { written, skipped } = extractTarGz(gz, dest);
  const exists = (p) => fs.existsSync(path.join(dest, p));
  ok(exists('ok.txt') && fs.readFileSync(path.join(dest, 'ok.txt'), 'utf8') === 'ok' && exists('sub/deep.txt'),
    'обычные файлы распакованы, корневая папка архива срезана', written.join(', '));
  ok(!fs.existsSync(path.join(tmp, 'evil.txt')) && !fs.existsSync(path.join(tmp, 'evil2.txt'))
    && !fs.existsSync(path.join(os.tmpdir(), 'evil.txt')), 'записи с «../» за пределы каталога не пишутся (tar-slip)');
  ok(skipped.includes('root/../../evil.txt') && skipped.includes('root/../evil2.txt'), 'выход за каталог попадает в список пропущенного');
  ok(exists('etc/passwd-copy') && !written.some((w) => path.isAbsolute(w)), 'абсолютный путь остаётся внутри каталога распаковки');
  ok(!exists('link') && !exists('hard') && skipped.includes('root/link') && skipped.includes('root/hard'),
    'символьные и жёсткие ссылки не создаются');
  ok(exists(`${'a'.repeat(120)}.txt`), 'длинное имя из PAX-заголовка восстановлено полностью');
  ok(exists('dir/file.txt') && fs.readFileSync(path.join(dest, 'dir/file.txt'), 'utf8') === 'prefixed', 'имя из поля prefix (ustar) учитывается');
  const again = extractTar(archive, path.join(tmp, 'out2'));
  ok(again.written.length === written.length, 'распаковка из буфера даёт тот же результат');
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ------------------------------ 2. иконки ------------------------------ */
console.log('\n2. Сопоставление иконок');
{
  const heroes = {
    axe: { localized_name: 'Axe' },
    furion: { localized_name: "Nature's Prophet" },
    ringmaster: { localized_name: 'Ring Master' },
    kez: { localized_name: 'Kez' },
    marci: { localized_name: 'Marci' },
  };
  const files = ['Axe.webp', "nature's prophet.webp", 'Ringmaster Concept.webp', 'Kez.png', 'MARCI.webp', 'marci.WEBP', 'README.md'];
  const { manifest, missing } = matchIcons(heroes, files);
  ok(manifest.axe === 'Axe.webp' && manifest.furion === "nature's prophet.webp", 'точное и регистронезависимое совпадение имени', JSON.stringify(manifest));
  ok(missing.includes('ringmaster') && missing.includes('kez'), 'героя без своей иконки не подменяем похожим файлом — он в списке пропусков', missing.join(', '));
  ok(missing.includes('marci') && !manifest.marci, 'неоднозначное совпадение без учёта регистра не используется');
  const twins = matchIcons({ a: { localized_name: 'Axe' }, b: { localized_name: 'Axe' } }, ['Axe.webp']);
  ok(Object.keys(twins.manifest).length === 1 && twins.missing.length === 1, 'одна иконка не достаётся двум героям');
}

/* ------------------------------ 3. версии патча ------------------------------ */
console.log('\n3. Версии патча');
{
  const v = parsePatchVersion('7.41f');
  ok(v && v.series === '7.41' && v.letter === 'f' && parsePatchVersion('7_40').series === '7.40', 'серия и буква разбираются отдельно (7.41f → 7.41 + f, 7_40 → 7.40)');
  const sorted = ['7.41f', '7.10', '7.41', '7.9', '7.42', '7.41a', '7.40c'].sort(comparePatchVersions);
  ok(sorted.join(' ') === '7.9 7.10 7.40c 7.41 7.41a 7.41f 7.42', 'порядок версий числовой, буквенные версии после серии', sorted.join(' '));
  const info = patchInfo(
    [{ name: '7.41', date: '2026-03-24T00:00:00Z', id: 60 }, { name: '7.39', date: '2025-05-22T00:00:00Z', id: 58 }, { name: '7.40', date: '2025-12-16T00:00:00Z', id: 59 }],
    ['7_39e', '7_40', '7_40b', '7_41', '7_41a', '7_41f', '7_41b', '7_410', '7_42'],
  );
  ok(info.series === '7.41' && info.latest.id === 60 && info.prevSeries === '7.40', `текущая серия ${info.series}, предыдущая ${info.prevSeries}`);
  ok(info.keepKeys.join(',') === '7_40,7_40b,7_41,7_41a,7_41b,7_41f', 'в патчноуты — текущая и предыдущая серии (без 7.39, 7.410 и 7.42)', info.keepKeys.join(','));
  ok(info.latestVersion === '7.41f', `последняя версия серии — ${info.latestVersion}`);
  const bare = patchInfo([{ name: '7.41', date: '2026-03-24', id: 1 }], ['7_41']);
  ok(bare.latestVersion === '7.41' && bare.prevSeries === '7.41', 'без буквенных версий последняя версия — сама серия');
  let threw = false;
  try { patchInfo([], []); } catch { threw = true; }
  ok(threw, 'пустой patch.json — явная ошибка сборки');
}

/* ------------------------------ 4. база знаний ------------------------------ */
console.log('\n4. База знаний');
const heroes = J('heroes.json');
const abilities = J('abilities.json');
const items = J('items.json');
const meta = J('meta.json');
const kbIndex = J('kb_index.json');
const kb = Object.fromEntries(kbIndex.files.map((f) => [f, J(`kb/${f}`)]));
const plans = Object.assign({}, ...kbIndex.files.filter((f) => f.startsWith('plans')).map((f) => kb[f]));
{
  // abilities передаём: с ними валидатор проверяет, что в порядке прокачки планов стоят только
  // изучаемые способности 7.41 (не врождённые пассивки и не шард-способности — см. ниже).
  const real = validateKb({ heroes, items, abilities, kb });
  ok(real.errors.length === 0, 'все ссылки базы знаний (герои, способности, предметы, теги) существуют', real.errors.slice(0, 5).join('; '));
  for (const w of real.warnings) console.log(`    ⚠ ${w}`);
  const text = kbTextIssues({ heroes, abilities, items, plans });
  ok(text.length === 0, 'в текстах планов нет устаревших названий способностей и опечаток в них', text.join('; '));

  const planFile = kbIndex.files.find((f) => f.startsWith('plans') && kb[f].queenofpain) || kbIndex.files.find((f) => f.startsWith('plans'));
  const slug = Object.keys(kb[planFile]).find((k) => !k.startsWith('_'));
  const broken = clone(kb);
  const plan = broken[planFile][slug];
  plan.items = plan.items || {};
  plan.items.core = [...(plan.items.core || []), ['not_an_item', 'тест']];
  plan.items.bogus = [['tango', 'тест']];
  plan.skills = [...(plan.skills || []), ['invoker_sun_strike', 'чужая способность']];
  plan.beats = [...(plan.beats || []), 'constructor'];
  broken['tags.json'].heroes.axe = [...(broken['tags.json'].heroes.axe || []), 'no_such_tag'];
  broken['tags.json'].heroes.no_such_hero = ['invis'];
  broken['rules.json'].rules.no_such_tag = { items: [['dust', '']], picks: ['ghost_hero'] };
  broken['rules.json'].combos.push({ tags: ['invis', 'bogus_tag'], items: [['gem_of_nothing', '']] });
  broken['timings.json'].events.push({ at: '1:00', title: 'тест', items: ['ancient_relic'] });
  const res = validateKb({ heroes, items, kb: broken });
  const has = (re) => res.errors.some((e) => re.test(e));
  ok(has(/items\.core: предмет «not_an_item»/), 'битый предмет в plan.items.core найден (прежний валидатор смотрел в plan.core и пропускал его)');
  ok(has(/items: неизвестная группа «bogus»/), 'неизвестная группа предметов плана найдена');
  ok(has(/skills: способность «invoker_sun_strike» не принадлежит/), 'чужая способность в плане найдена');
  ok(has(/beats: герой «constructor»/), 'унаследованное имя («constructor») героем не считается');
  ok(has(/тег «no_such_tag» отсутствует/) && has(/tags\.json\[no_such_hero\]/), 'неизвестный тег и неизвестный герой в tags.json найдены');
  ok(has(/rules\.json\[no_such_tag\]: тег/) && has(/picks: герой «ghost_hero»/), 'правило с тегом вне словаря и неизвестным пиком найдено');
  ok(has(/combos#\d+\]: тег «bogus_tag»/) && has(/предмет «gem_of_nothing»/), 'комбо с неизвестным тегом и предметом найдено');
  ok(has(/timings\.json: предмет «ancient_relic»/), 'предмет в таймингах проверяется');

  // Порядок прокачки: врождённая пассивка (Necromastery) и шард-способность (Warp Flare у Tinker)
  // не качаются очками. Раньше именно они стояли в планах шести мидовых героев.
  const nevFile = kbIndex.files.find((f) => f.startsWith('plans') && kb[f].nevermore);
  const innateKb = clone(kb);
  innateKb[nevFile].nevermore.skills = [['nevermore_shadowraze1', 'тест'], ['nevermore_necromastery', 'тест']];
  const innateRes = validateKb({ heroes, items, abilities, kb: innateKb });
  ok(innateRes.errors.some((e) => /nevermore_necromastery.*врождённая/.test(e)), 'врождённая способность в порядке прокачки найдена');
  const tinkerFile = kbIndex.files.find((f) => f.startsWith('plans') && kb[f].tinker);
  const shardKb = clone(kb);
  shardKb[tinkerFile].tinker.skills = [['tinker_warp_grenade', 'тест']];
  const shardRes = validateKb({ heroes, items, abilities, kb: shardKb });
  ok(shardRes.errors.some((e) => /tinker_warp_grenade.*шард/.test(e)), 'шард-способность в порядке прокачки найдена');

  const textBroken = {
    furion: { lane: 'Force of Nature даёт пуш и обзор' },
    dragon_knight: { tips: ["Wyrn's Wrath усиливает способности"] },
    templar_assassin: { tips: ['Psionic Traps расставляй заранее'] },
  };
  const found = kbTextIssues({ heroes, abilities, items, plans: textBroken });
  ok(found.some((s) => /furion: устаревшее название «force of nature»/.test(s)), 'устаревшее название способности (Force of Nature → Nature\'s Call) найдено');
  ok(found.some((s) => /dragon_knight: вероятная опечатка «Wyrn's Wrath»/.test(s)), 'опечатка в названии способности найдена');
  ok(!found.some((s) => s.startsWith('templar_assassin')), 'множественное число («Psionic Traps») опечаткой не считается');
}

/* ------------------------------ 5. собранные данные ------------------------------ */
console.log('\n5. Собранные данные');
const icons = J('icons.json');
const patchnotes = J('patchnotes.json');
const templates = J('templates.json');
{
  ok(meta.heroes === Object.keys(heroes).length && meta.items === Object.keys(items).length,
    `meta.json согласована: героев ${meta.heroes}, предметов ${meta.items}`);
  const series = parsePatchVersion(meta.latestPatch)?.series;
  ok(series === meta.patchSeries, `серия патча в meta: ${meta.patchSeries} (latestPatch ${meta.latestPatch})`);
  const own = Object.keys(patchnotes).filter((k) => parsePatchVersion(k)?.series === meta.patchSeries).sort(comparePatchVersions);
  ok(own.length > 0 && meta.latestVersion === own[own.length - 1], `meta.latestVersion = последняя версия серии в патчноутах (${meta.latestVersion})`);
  ok(parsePatchVersion(meta.latestVersion)?.series === meta.patchSeries, 'буквенная версия относится к той же серии — серия и версия не перепутаны');
  ok(Object.keys(patchnotes).every((k) => parsePatchVersion(k)), 'все ключи патчноутов — версии патча');

  const badHeroes = Object.entries(heroes).filter(([slug, h]) => !(h && h.slug === slug && typeof h.localized_name === 'string'
    && Array.isArray(h.roles) && ['str', 'agi', 'int', 'all'].includes(h.primary_attr) && h.stats && Array.isArray(h.slots)));
  ok(badHeroes.length === 0, 'у каждого героя есть поля, на которые опирается интерфейс', badHeroes.map(([s]) => s).join(', '));
  ok(Object.values(items).every((it) => it && typeof it.dname === 'string' && (it.cost === null || typeof it.cost === 'number')),
    'у каждого предмета есть имя и цена (или null)');

  const iconDir = path.join(DATA, 'icons');
  const files = fs.readdirSync(iconDir).filter((f) => f.endsWith('.webp'));
  ok(Object.keys(icons).every((s) => Object.prototype.hasOwnProperty.call(heroes, s)), 'icons.json ссылается только на героев из данных');
  ok(Object.values(icons).every((f) => fs.existsSync(path.join(iconDir, f))), `файлы всех ${Object.keys(icons).length} иконок на месте`);
  ok(files.every((f) => Object.values(icons).includes(f)), 'в data/icons нет файлов вне манифеста');
  const noIcon = Object.keys(heroes).filter((s) => !icons[s]);
  console.log(`    без иконки (буквенный аватар): ${noIcon.map((s) => heroes[s].localized_name).join(', ') || '—'}`);

  const tplHeroes = templates.heroes || {};
  const variants = (templates.meta && templates.meta.variants) || [];
  ok(Object.keys(tplHeroes).every((s) => Object.prototype.hasOwnProperty.call(heroes, s) && icons[s]),
    'шаблоны распознавания — только для героев из данных с иконкой');
  ok(Object.values(tplHeroes).every((sigs) => Array.isArray(sigs) && sigs.length === variants.length && sigs.every((h) => /^[0-9a-f]{160}$/.test(h))),
    `у каждого героя ${variants.length} подписей по 80 байт`);
  ok(templates.meta.heroes === Object.keys(tplHeroes).length && templates.meta.signatures === Object.keys(tplHeroes).length * variants.length,
    `meta шаблонов согласована: ${templates.meta.heroes} героев × ${variants.length} кадров`);
  const noTpl = Object.keys(heroes).filter((s) => !tplHeroes[s]).sort();
  ok(JSON.stringify(noTpl) === JSON.stringify([...noIcon].sort()), 'без шаблонов ровно те герои, у которых нет иконки (их подставляет пользователь)');

  const kbFiles = fs.readdirSync(path.join(DATA, 'kb')).filter((f) => f.endsWith('.json')).sort();
  ok(JSON.stringify(kbIndex.files) === JSON.stringify(kbFiles), 'kb_index.json перечисляет все файлы базы знаний', kbIndex.files.join(', '));

  // Гигиена источника: пустой массив в скалярном поле — это «данных нет», а не значение. У 19
  // способностей так приходили dmg_type, bkbpierce и behavior, и карточка Huskar и Dark Seer
  // печатала «тип урона: » без значения (пустой массив в JS истинен). Сборщик это чинит,
  // а тест следит, чтобы мусор не вернулся ни через источник, ни через правку сборщика.
  const SCALARS = ['dmg_type', 'bkbpierce', 'dispellable', 'mc', 'cd', 'behavior'];
  // Массивы в mc/cd/behavior — это норма (значения по уровням, список поведения): ловим пустые.
  const arraysInScalars = Object.entries(abilities).filter(([, a]) => SCALARS.some((f) => Array.isArray(a[f]) && a[f].length === 0)).map(([k]) => k);
  ok(arraysInScalars.length === 0, `в скалярных полях способностей нет пустых массивов (найдено: ${arraysInScalars.length})`,
    arraysInScalars.slice(0, 5).join(', '));
  const deviant = (f, good) => Object.entries(abilities).filter(([, a]) => a[f] !== null && a[f] !== undefined && !good(a[f])).map(([k]) => k);
  ok(deviant('dmg_type', (v) => typeof v === 'string' && v).length === 0, 'dmg_type — непустая строка или отсутствует');
  ok(deviant('bkbpierce', (v) => typeof v === 'string' && v).length === 0, 'bkbpierce — непустая строка или отсутствует');
  ok(Object.values(abilities).every((a) => a.desc === null || typeof a.desc === 'string'), 'описание — строка или null («источник не дал»)');
  const noDesc = Object.values(abilities).filter((a) => !a.desc).length;
  ok(noDesc <= 34, `без описания из источника — ${noDesc} способностей (новых быть не должно: в dotaconstants текста для них нет)`);

  // attrib способностей — только подпись и значение: ключ характеристики (percent_damage_per_burn)
  // интерфейсу не нужен, а 95 КБ ключей — десятая часть файла.
  const attrFields = [...new Set(Object.values(abilities).flatMap((a) => (a.attrib || []).flatMap((r) => Object.keys(r))))].sort();
  ok(JSON.stringify(attrFields) === JSON.stringify(['header', 'value']), 'attrib способностей содержит только header и value', attrFields.join(', '));
  ok(Object.values(abilities).every((a) => a.type === undefined), 'мёртвое поле type (в источнике его нет) не выводится');
  ok(Object.values(heroes).every((h) => h.cm_enabled === undefined), 'cm_enabled, одинаковый у всех героев, не выводится');
  const descLen = Object.values(abilities).filter((a) => !a.desc).length;
  console.log(`    способностей без описания в источнике: ${descLen}; предметов: ${Object.keys(items).length}`);
}

/* ------------------------------ 6. вес первой загрузки ------------------------------ */
console.log('\n6. Вес первой загрузки');
/**
 * Бюджет стартовых данных: столько приложение тянет до первого рендера. Список файлов берётся из
 * самого приложения (loadData), поэтому тест не разойдётся с кодом и заметит тяжёлый файл, который
 * кто-то добавил в стартовый набор. Патчноуты (365 КБ) и подписи распознавания грузятся лениво —
 * их в списке быть не должно.
 */
const BOOT_BUDGET_KB = 400;
{
  const app = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
  const start = app.indexOf('async function loadData()');
  const end = app.indexOf('let patchnotesLoading');
  ok(start > 0 && end > start, 'в assets/app.js найден стартовый набор данных (loadData)');
  const block = app.slice(start, end);
  const boot = [...block.matchAll(/get\('(data\/[^']+)'\)/g)].map((m) => m[1]);
  ok(boot.length >= 8, `в loadData перечислено файлов: ${boot.length}`, boot.join(', '));
  // База знаний подтягивается циклом по kb_index: на старте нужны архетипы и планы.
  const kbAtBoot = kbIndex.files.map((f) => `data/kb/${f}`).filter((f) => /archetypes|plans/.test(f));
  const files = [...boot, ...kbAtBoot];
  const heavy = files.filter((f) => /patchnotes|templates/.test(f));
  ok(heavy.length === 0, `тяжёлые файлы на старте не грузятся (в списке их ${heavy.length})`, heavy.join(', '));
  let raw = 0;
  let gz = 0;
  const rows = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    const packed = zlib.gzipSync(buf).length;
    raw += buf.length;
    gz += packed;
    rows.push(`    ${f.padEnd(30)} ${String(Math.round(buf.length / 1024)).padStart(5)} КБ → ${String(Math.round(packed / 1024)).padStart(4)} КБ gzip`);
  }
  console.log(rows.join('\n'));
  console.log(`    итого: ${(raw / 1024).toFixed(0)} КБ → ${(gz / 1024).toFixed(0)} КБ gzip (бюджет ${BOOT_BUDGET_KB} КБ)`);
  ok(gz <= BOOT_BUDGET_KB * 1024, `стартовые данные укладываются в бюджет ${BOOT_BUDGET_KB} КБ gzip (сейчас ${(gz / 1024).toFixed(1)} КБ)`);
  // Профиль веса: если один файл съедает больше половины бюджета, разговор о ленивой загрузке
  // идёт не про мелочи — тест это подсвечивает, но не валит.
  const gzOf = (row) => Number(row.match(/→\s*(\d+) КБ/)[1]);
  const biggest = rows.reduce((a, b) => (gzOf(a) >= gzOf(b) ? a : b));
  console.log(`    самый тяжёлый стартовый файл: ${biggest.trim().split(/\s{2,}/)[0]} (${gzOf(biggest)} КБ gzip)`);
}

/* ------------------------------ 7. документация ------------------------------ */
console.log('\n7. README соответствует данным');
{
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const midPlans = Object.entries(plans).filter(([k, p]) => !k.startsWith('_') && p && p.mid).length;
  const noteKeys = Object.keys(patchnotes).sort(comparePatchVersions);
  const noIcon = Object.keys(heroes).filter((s) => !icons[s]).sort();
  const tplCount = Object.keys(templates.heroes).length;
  const claim = (re, label, expected) => {
    const m = readme.match(re);
    ok(m !== null && String(m[1]) === String(expected), `README: ${label}`, m ? `в README «${m[1]}», в данных ${expected}` : `в README нет фразы ${re} — обновите README`);
  };
  claim(/^# .*\(патч ([\d.]+)\)/m, 'серия патча в заголовке', meta.patchSeries);
  claim(/Все (\d+) героев/, 'число героев', Object.keys(heroes).length);
  claim(/мидовые планы \((\d+) героев\)/, 'число мидовых планов', midPlans);
  // Фраза в README: «Бюджет стартовых данных (400 КБ gzip) проверяет tools/test_data.mjs».
  claim(/Бюджет стартовых\s+данных \((\d+) КБ gzip\)/, 'бюджет стартовых данных, КБ gzip', BOOT_BUDGET_KB);
  claim(/\((\d+) героя × \d+ кадров/, 'число героев с шаблонами распознавания', tplCount);
  claim(/героя × (\d+) кадров/, 'число кадров шаблона', templates.meta.variants.length);
  claim(/Патчноуты \(([\d.a-z]+) → /, 'последняя версия в патчноутах', noteKeys[noteKeys.length - 1]);
  claim(/Патчноуты \([\d.a-z]+ → ([\d.a-z]+)\)/, 'первая версия в патчноутах', noteKeys[0]);
  const listed = (readme.match(/сейчас ((?:`[a-z_]+`(?:, )?)+)/) || [])[1];
  const slugs = listed ? [...listed.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort() : [];
  ok(JSON.stringify(slugs) === JSON.stringify(noIcon), 'README: список героев без иконок', `в README ${slugs.join(', ') || '—'}, в данных ${noIcon.join(', ')}`);
}

console.log(failed ? `\n✗ Провалено проверок: ${failed}` : '\nДанные, сборщик и документация согласованы.');
process.exit(failed ? 1 : 0);
