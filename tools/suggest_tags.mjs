#!/usr/bin/env node
/**
 * Подсказчик тегов: печатает, чем подтверждается каждый тег механики у каждого героя и что стоит
 * добавить или снять в `data/kb/tags.json`. Сам ничего не пишет — разметка курируемая, решение
 * принимает человек, а инструмент избавляет его от чтения 788 описаний руками.
 *
 * Запуск:
 *   node tools/suggest_tags.mjs                    # сводка: чего не хватает и что не подтверждено
 *   node tools/suggest_tags.mjs --tag=invis        # подробно по одному тегу, с цитатами
 *   node tools/suggest_tags.mjs --hero=axe         # подробно по одному герою
 *   node tools/suggest_tags.mjs --hero=axe --abilities   # ещё и тексты его способностей
 *   node tools/suggest_tags.mjs --tag=invis --json # то же машинно (для разметки скриптом)
 *
 * Коды выхода: 0 — отчёт напечатан, 1 — найдена несогласованность разметки, 2 — нет данных.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEXT_RULES, NUM_RULES, MANUAL_ONLY, DENY, suggestTags, sentences } from './taglib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const args = process.argv.slice(2);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const asJson = args.includes('--json');
const onlyTag = opt('tag');
const onlyHero = opt('hero');
const PRECISION = {};
for (const [tag, rule] of Object.entries({ ...TEXT_RULES, ...NUM_RULES })) PRECISION[tag] = rule.precision || 'medium';

let heroes;
let abilities;
let tagsKb;
let rules;
try {
  heroes = read('data/heroes.json');
  abilities = read('data/abilities.json');
  tagsKb = read('data/kb/tags.json');
  rules = read('data/kb/rules.json').rules;
} catch (err) {
  console.error(`Не нашёл данные: ${err.message}`);
  console.error('Сначала собери их: node tools/build_data.mjs --cached');
  process.exit(2);
}

const vocabulary = Object.keys(rules);
const slugs = Object.keys(heroes).sort((a, b) => (heroes[a].localized_name || a).localeCompare(heroes[b].localized_name || b));

const rows = [];
for (const slug of slugs) {
  const hero = heroes[slug];
  const current = ((tagsKb.heroes || {})[slug] || []).slice().sort();
  const suggested = suggestTags(hero, abilities);
  const strong = {};
  for (const [tag, evs] of Object.entries(suggested)) {
    const keep = evs.filter((e) => e.strength !== 'weak');
    if (keep.length) strong[tag] = keep;
  }
  const missing = Object.keys(strong).filter((t) => !current.includes(t)).sort();
  const unproven = current.filter((t) => !strong[t]);
  rows.push({ slug, name: hero.localized_name, current, strong, suggested, missing, unproven });
}

const vocabularyIssues = [];
// Проверка самой таблицы исключений: опечатка в ключе способности означала бы молчаливое правило.
for (const [key, denied] of Object.entries(DENY)) {
  if (!abilities[key]) vocabularyIssues.push(`DENY: способности «${key}» нет в данных`);
  for (const tag of Object.keys(denied)) {
    if (!vocabulary.includes(tag)) vocabularyIssues.push(`DENY ${key}: тег «${tag}» не описан в rules.json`);
  }
}
for (const tag of vocabulary) {
  if (!PRECISION[tag] && !MANUAL_ONLY.includes(tag)) vocabularyIssues.push(`rules.json: у тега «${tag}» нет правила подсказчика и он не помечен как ручной`);
}
for (const [slug, tags] of Object.entries(tagsKb.heroes || {})) {
  for (const tag of tags) {
    if (!vocabulary.includes(tag)) vocabularyIssues.push(`${slug}: тег «${tag}» не описан в rules.json`);
  }
}

const showEvidence = (evs, current) => {
  for (const e of evs) {
    const where = e.kind === 'hero' ? 'сам герой' : `${e.dname}${e.ultimate ? ' (ультимейт)' : ''}`;
    const kind = e.kind === 'phrase' ? 'фраза' : e.kind === 'number' ? 'число' : 'оценка';
    console.log(`      ${current ? '✓' : '+'} ${kind}: ${where} — ${e.quote}${e.strength === 'weak' ? ' [слабое]' : ''}`);
  }
};

if (onlyHero) {
  const row = rows.find((r) => r.slug === onlyHero);
  if (!row) {
    console.error(`Нет героя ${onlyHero}`);
    process.exit(2);
  }
  const hero = heroes[onlyHero];
  console.log(`\n${row.name} (${row.slug}) — роли: ${(hero.roles || []).join(', ')}`);
  console.log(`Сейчас размечено: ${row.current.join(', ') || '—'}\n`);
  if (args.includes('--abilities')) {
    for (const key of [...(hero.slots || []).map((s) => s.key), ...(hero.extra || [])]) {
      const a = abilities[key];
      if (!a) continue;
      console.log(`  ${a.dname || key} [${key}] ${a.dmg_type || ''} ${[].concat(a.behavior || []).join(', ')}`);
      for (const s of sentences(a.desc).slice(0, 3)) console.log(`     «${s}»`);
    }
    console.log('');
  }
  for (const [tag, evs] of Object.entries(row.suggested)) {
    const mark = row.current.includes(tag) ? '✓ размечено' : '· нет в разметке';
    console.log(`  ${tag.padEnd(22)} [${PRECISION[tag] || 'ручной'}] ${mark}`);
    showEvidence(evs, row.current.includes(tag));
  }
  const noEvidence = row.current.filter((t) => !row.suggested[t]);
  if (noEvidence.length) console.log(`\n  Без машинного доказательства (решение человека): ${noEvidence.join(', ')}`);
  process.exit(vocabularyIssues.length ? 1 : 0);
}

if (onlyTag) {
  const list = rows.filter((r) => r.strong[onlyTag]).sort((a, b) => (b.strong[onlyTag].length - a.strong[onlyTag].length));
  if (asJson) {
    console.log(JSON.stringify(list.map((r) => ({
      slug: r.slug,
      name: r.name,
      current: r.current.includes(onlyTag),
      evidence: r.strong[onlyTag].map((e) => ({ ability: e.key, dname: e.dname, kind: e.kind, quote: e.quote })),
    })), null, 1));
    process.exit(0);
  }
  const rule = rules[onlyTag];
  console.log(`\nТег «${onlyTag}» [${PRECISION[onlyTag] || 'ручной'}]${rule ? ` — ${rule.why}` : ''}`);
  console.log(`Подтверждён у ${list.length}; размечен у ${rows.filter((r) => r.current.includes(onlyTag)).length}\n`);
  for (const r of list) {
    console.log(`${r.current.includes(onlyTag) ? '✓' : '+'} ${r.name} (${r.slug})`);
    showEvidence(r.strong[onlyTag], r.current.includes(onlyTag));
  }
  const ghosts = rows.filter((r) => r.current.includes(onlyTag) && !r.strong[onlyTag]);
  if (ghosts.length) console.log(`\nРазмечен без машинного подтверждения: ${ghosts.map((r) => r.name).join(', ')}`);
  process.exit(vocabularyIssues.length ? 1 : 0);
}

if (asJson) {
  console.log(JSON.stringify(rows.map((r) => ({
    slug: r.slug, name: r.name, current: r.current, missing: r.missing, unproven: r.unproven,
    evidence: Object.fromEntries(Object.entries(r.strong).map(([t, evs]) => [t, evs.map((e) => ({ ability: e.key, quote: e.quote }))])),
  })), null, 1));
  process.exit(vocabularyIssues.length ? 1 : 0);
}

const byTag = {};
for (const r of rows) for (const t of r.missing) byTag[t] = (byTag[t] || 0) + 1;
const total = rows.reduce((n, r) => n + r.current.length, 0);
console.log(`\nГероев: ${rows.length}. Размечено ${total} тегов, в среднем ${(total / rows.length).toFixed(2)} на героя.`);
console.log(`Предложений: ${rows.reduce((n, r) => n + r.missing.length, 0)} у ${rows.filter((r) => r.missing.length).length} героев.\n`);

const high = Object.entries(byTag).filter(([t]) => PRECISION[t] === 'high').sort((a, b) => b[1] - a[1]);
const medium = Object.entries(byTag).filter(([t]) => PRECISION[t] !== 'high').sort((a, b) => b[1] - a[1]);
console.log('Однозначные (precision: high) — обязаны стоять в разметке (проверяет test_tags):');
for (const [tag, n] of high) console.log(`  ${tag.padEnd(24)} ${String(n).padStart(3)} героев`);
console.log('\nНа взгляд человека (medium):');
for (const [tag, n] of medium) console.log(`  ${tag.padEnd(24)} ${String(n).padStart(3)} героев`);
console.log(`\nРазмечено без машинного подтверждения: ${rows.reduce((n, r) => n + r.unproven.length, 0)} тегов — нормально, часть механик видна только по игре.`);
console.log('Отклоняется только явно: строка в таблице DENY (tools/taglib.mjs) с причиной.');
console.log(`Героев с 1-2 тегами: ${rows.filter((r) => r.current.length <= 2).length}`);
if (vocabularyIssues.length) {
  console.log('\nНесогласованности разметки:');
  for (const issue of vocabularyIssues) console.log(`  - ${issue}`);
  process.exit(1);
}
console.log('\nРазметка и правила подсказчика согласованы. Подробности: --tag=<тег>, --hero=<слаг>.');
process.exit(0);
