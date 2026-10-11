#!/usr/bin/env node
/**
 * test_engine.mjs — проверка движка разбора драфта на собранных данных.
 * Запуск: node tools/test_engine.mjs
 *
 * Что проверяется:
 *   - данные 7.41 читаются и содержат все 127 героев;
 *   - планы героев ссылаются только на существующие способности и предметы;
 *   - разбор лейна даёт вменяемые вердикты на известных матчапах;
 *   - угрозы, комбо, рекомендации по пикам и закуп собираются без ошибок.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const J = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'));

const {
  laneReport, threatsFor, combosFor, counterPicks, buildPlan, buildChecklist, checklistUniverse, heroDamage,
} = await import(path.join(ROOT, 'assets', 'analysis.js'));

const heroes = J('heroes.json');
const abilities = J('abilities.json');
const items = J('items.json');
const meta = J('meta.json');
const tagsKb = J('kb/tags.json');
const rules = J('kb/rules.json');
const timings = J('kb/timings.json');
const plans = {};
for (const f of J('kb_index.json').files) if (f.startsWith('plans')) Object.assign(plans, J('kb/' + f));

const data = { heroes, abilities, items, tagsKb, rules, plans, timings, meta };
const ctx = { tagsKb, rules, plans };

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};

console.log(`\nДанные: патч ${meta.latestPatch} (${String(meta.latestPatchDate).slice(0, 10)}), константы ${meta.constantsVersion}`);
// Количество героев растёт с патчами — требуем «не меньше базы 7.41» и согласованность meta.json,
// чтобы тесты не падали при выходе нового героя.
ok(Object.keys(heroes).length >= 127, 'в базе все герои 7.41 (или новее)', String(Object.keys(heroes).length));
ok(Object.keys(heroes).length === meta.heroes, 'meta.json согласована с heroes.json');
ok(Object.keys(items).length > 400, 'предметы 7.41 собраны', String(Object.keys(items).length));
const planHeroes = Object.keys(plans).filter((k) => !k.startsWith('_'));
ok(planHeroes.length >= 36, 'мидовых планов в базе', String(planHeroes.length));

// 0. формулы статов: урон универсала = база + 0.7 за каждый пункт любого из трёх атрибутов
{
  const bane = heroes['bane'];
  const expected = ((bane.stats.base_attack_min + bane.stats.base_attack_max) / 2)
    + 0.7 * (bane.stats.base_str + bane.stats.base_agi + bane.stats.base_int);
  ok(Math.abs(heroDamage(bane) - expected) < 0.01, 'урон универсала = база + 0.7×сумма атрибутов', `bane=${heroDamage(bane).toFixed(1)} (ожидалось ${expected.toFixed(1)})`);
  const qop = heroes['queenofpain'];
  const qopExpected = ((qop.stats.base_attack_min + qop.stats.base_attack_max) / 2) + qop.stats.base_int;
  ok(Math.abs(heroDamage(qop) - qopExpected) < 0.01, 'урон интового героя = база + интеллект', `qop=${heroDamage(qop).toFixed(1)}`);
}

// 1. целостность планов
let badAbility = 0;
let badItem = 0;
for (const [slug, plan] of Object.entries(plans)) {
  if (slug.startsWith('_') || !heroes[slug]) continue;
  const own = new Set([...heroes[slug].slots.map((s) => s.key), ...heroes[slug].extra]);
  for (const [key] of plan.skills || []) if (!own.has(key)) { badAbility++; console.log(`    способность ${key} не принадлежит ${slug}`); }
  for (const g of ['start', 'early', 'core', 'situational']) {
    for (const [key] of plan.items?.[g] || []) if (!items[key]) { badItem++; console.log(`    предмет ${key} не найден (${slug}.${g})`); }
  }
}
ok(badAbility === 0, 'все способности в планах реальны');
ok(badItem === 0, 'все предметы в планах существуют в 7.41');

// 2. разбор лейна на известных матчапах
const cases = [
  ['queenofpain', 'huskar', -1, 'QoP против Huskar — тяжёлый лейн'],
  ['sniper', 'viper', 3, 'Sniper разменивает дистанцию против Viper'],
  ['viper', 'sniper', -3, 'обратная ситуация для Viper'],
];
for (const [a, b, threshold, label] of cases) {
  const r = laneReport(heroes[a], heroes[b], ctx);
  const okSign = threshold < 0 ? r.score <= threshold : r.score >= threshold;
  ok(okSign, label, `score=${r.score} (${r.verdict.title})`);
}

// 3. угрозы и ответы
const threats = threatsFor(['riki', 'oracle', 'tidehunter', 'warlock', 'clinkz'], data);
ok(threats.length >= 8, 'угрозы распознаны', String(threats.length));
ok(threats.every((t) => t.items.every(([k]) => items[k])), 'все контрмеры существуют как предметы');
ok(threats.some((t) => t.tag === 'invis' && t.items.some(([k]) => k === 'dust')), 'невидимость → дасты');

// 4. комбо-правила
const combos = combosFor(['riki', 'clinkz', 'oracle', 'dazzle', 'tidehunter'], data);
ok(combos.length >= 2, 'комбо-предупреждения срабатывают', combos.map((c) => c.tags.join('+')).join(', '));

// 5. рекомендации по пикам
const picks = counterPicks({ enemies: ['huskar', 'riki', 'tidehunter', 'oracle', 'medusa'], enemyMid: 'huskar', data, limit: 5 });
ok(picks.length >= 3, 'есть рекомендации по пикам', picks.map((p) => `${p.name}:${p.score}`).join(' '));

// 6. закуп и чеклист
const plan = buildPlan({ heroSlug: 'queenofpain', enemySlugs: ['riki', 'clinkz', 'huskar'], data });
ok(plan.items.start.length > 0 && plan.items.core.length > 0, 'закуп собирается', `ситуативных: ${plan.items.situational.length}`);
ok(plan.items.situational.length <= 10, 'ситуативный закуп ограничен по приоритету');
ok(plan.items.situational.every((i) => items[i.key]), 'ситуативные предметы существуют');
const generic = buildPlan({ heroSlug: 'largo', enemySlugs: ['riki'], data });
ok(!generic.curated && generic.items.core.length > 0, 'для героя без плана есть универсальная сборка');
const checklist = buildChecklist({ threats, combos, data });
ok(checklist.length >= 8, 'чеклист собирается', String(checklist.length));
ok(new Set(checklist).size === checklist.length, 'в чеклисте нет дублей');

// 6b. «вселенная» пунктов чеклиста — по ней интерфейс вычищает устаревшие галочки из localStorage.
const universe = checklistUniverse(data);
const otherEnemies = ['huskar', 'tidehunter', 'warlock', 'medusa', 'viper'];
const otherChecklist = buildChecklist({
  threats: threatsFor(otherEnemies, data), combos: combosFor(otherEnemies, data), data,
});
ok([...checklist, ...otherChecklist].every((c) => universe.has(c)),
  'любой пункт чеклиста входит во «вселенную»', `во вселенной: ${universe.size}`);
ok((rules.combos || []).every((c) => universe.has(`Запомни комбо-предупреждение: ${c.advice.split('.')[0]}`)),
  'все комбо-пункты из rules.json учтены во «вселенной»');
ok(universe.has('Сентри/дасты в инвентаре до 10-й минуты') && !universe.has('мусор'), 'во «вселенную» попадают только реальные пункты');

// 7. тайминги
ok(timings.events.some((e) => e.at === '20:00' && e.title.includes('Торментор')), 'Торментор 20:00 в таймингах');
ok(timings.events.some((e) => e.at === '7:00'), 'святилище мудрости 7:00 в таймингах');

console.log(failed === 0 ? '\nВсе проверки пройдены.\n' : `\nПровалено проверок: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
