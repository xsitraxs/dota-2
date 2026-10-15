#!/usr/bin/env node
/**
 * Проверка разметки героев (`data/kb/tags.json`) против правил подсказчика:
 *
 * 1. Инвариант доказательств: каждая подсказка с точностью `high` обязана стоять в разметке.
 *    Если подсказка неверна — её отклоняют не молча, а строкой в таблице DENY (`tools/taglib.mjs`)
 *    с объяснением, почему фраза подходит, а механика у героя не та. Так разметку можно
 *    перепроверять: разошлись данные — тест скажет, какой именно герой и какая фраза.
 * 2. Согласованность с правилами: каждый тег разметки описан в `rules.json` (иначе движок не
 *    найдёт контрмер) и разбирается либо правилом подсказчика, либо помечен как ручной.
 * 3. Целостность: слаги героев существуют, дублей тегов нет, у каждого героя есть хотя бы два
 *    тега, таблица DENY ссылается на существующие способности и теги.
 *
 * Запуск: node tools/test_tags.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEXT_RULES, NUM_RULES, MANUAL_ONLY, DENY, suggestTags } from './taglib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const verbose = process.argv.includes('--verbose');
const problems = [];
const check = (ok, message) => {
  if (ok) console.log(`  ✓ ${message}`);
  else {
    console.log(`  ✗ ${message}`);
    problems.push(message);
  }
};

const heroes = read('data/heroes.json');
const abilities = read('data/abilities.json');
const tagsKb = read('data/kb/tags.json');
const rules = read('data/kb/rules.json').rules;
const known = new Set([...Object.keys(TEXT_RULES), ...Object.keys(NUM_RULES), ...MANUAL_ONLY]);
const precision = {};
for (const [tag, rule] of Object.entries({ ...TEXT_RULES, ...NUM_RULES })) precision[tag] = rule.precision || 'medium';

console.log('\n1. Целостность разметки и словаря');
const vocabulary = Object.keys(rules);
const unknownHeroes = Object.keys(tagsKb.heroes || {}).filter((s) => !heroes[s]);
check(unknownHeroes.length === 0, `все слаги разметки есть среди героев (лишних: ${unknownHeroes.length}${unknownHeroes.length ? ` — ${unknownHeroes.join(', ')}` : ''})`);
const missingHeroes = Object.keys(heroes).filter((s) => !(tagsKb.heroes || {})[s]);
check(missingHeroes.length === 0, `у каждого героя есть разметка (без неё: ${missingHeroes.length}${missingHeroes.length ? ` — ${missingHeroes.slice(0, 5).join(', ')}` : ''})`);

const unknownTags = [];
const duplicated = [];
const thin = [];
for (const [slug, tags] of Object.entries(tagsKb.heroes || {})) {
  if (!Array.isArray(tags)) {
    problems.push(`${slug}: разметка не массив`);
    continue;
  }
  for (const tag of tags) if (!vocabulary.includes(tag)) unknownTags.push(`${slug}:${tag}`);
  if (new Set(tags).size !== tags.length) duplicated.push(slug);
  if (tags.length < 2) thin.push(`${slug} (${tags.length})`);
}
check(unknownTags.length === 0, `каждый тег разметки описан в rules.json (неизвестных: ${unknownTags.length}${unknownTags.length ? ` — ${unknownTags.slice(0, 5).join(', ')}` : ''})`);
check(duplicated.length === 0, `в разметке нет повторяющихся тегов (героев с дублями: ${duplicated.length})`);
check(thin.length === 0, `у каждого героя хотя бы два тега (с одним: ${thin.length}${thin.length ? ` — ${thin.join(', ')}` : ''})`);

const uncovered = vocabulary.filter((t) => !known.has(t));
check(uncovered.length === 0, `у каждого тега правил есть правило подсказчика или пометка «ручной» (без них: ${uncovered.join(', ') || 'нет'})`);

console.log('\n2. Таблица исключений DENY');
const badDeny = [];
for (const [key, denied] of Object.entries(DENY)) {
  if (!abilities[key]) badDeny.push(`${key}: нет такой способности`);
  for (const tag of Object.keys(denied)) {
    if (!vocabulary.includes(tag)) badDeny.push(`${key}: тег «${tag}» не из rules.json`);
    if (!String(denied[tag] || '').trim()) badDeny.push(`${key}:${tag}: нет причины`);
  }
}
check(badDeny.length === 0, `таблица DENY осмысленна (проблем: ${badDeny.length}${badDeny.length ? ` — ${badDeny.slice(0, 4).join('; ')}` : ''})`);

console.log('\n3. Каждая однозначная подсказка либо в разметке, либо объяснённо отклонена');
const unapplied = [];
let high = 0;
for (const [slug, hero] of Object.entries(heroes)) {
  const current = new Set((tagsKb.heroes || {})[slug] || []);
  const suggested = suggestTags(hero, abilities);
  for (const [tag, evs] of Object.entries(suggested)) {
    if (precision[tag] !== 'high') continue;
    if (!evs.some((e) => e.strength !== 'weak')) continue;
    high += 1;
    if (current.has(tag)) continue;
    const first = evs.find((e) => e.strength !== 'weak');
    unapplied.push(`${hero.localized_name} (${slug}): ${tag} — ${first.dname}: ${String(first.quote).slice(0, 90)}`);
  }
}
check(unapplied.length === 0, `подсказок «high»: ${high}, из них не применено: ${unapplied.length}`);
if (unapplied.length && verbose) for (const line of unapplied) console.log(`      ${line}`);

const total = Object.values(tagsKb.heroes || {}).reduce((n, t) => n + t.length, 0);
const heroesCount = Object.keys(tagsKb.heroes || {}).length;
console.log(`\nРазметка: ${heroesCount} героев, ${total} тегов, в среднем ${(total / heroesCount).toFixed(2)} на героя.`);
console.log(problems.length ? `\nПРОБЛЕМЫ (${problems.length}):\n - ${problems.join('\n - ')}` : '\nРазметка героев согласована с правилами и доказательствами.');
process.exit(problems.length ? 1 : 0);
