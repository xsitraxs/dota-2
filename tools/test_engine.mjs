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
  laneReport, threatsFor, combosFor, counterPicks, buildPlan, buildChecklist, checklistUniverse,
  heroDamage, heroHp, heroMana, heroArmor, archetypeFor, heroLearnableSkills, isSubAbility,
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
const archetypes = J('kb/archetypes.json');

const data = { heroes, abilities, items, tagsKb, rules, plans, timings, meta, archetypes };
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

// 0. формулы статов. Константы — из патчноутов (dotaconstants build/patchnotes.json, dota2.com/patches):
//    7.38 «Universal Heroes' damage per attribute decreased from 0.7 to 0.45» (в 7.39–7.41f не менялось);
//    7.33 «HP per point of Strength increased from 20 to 22»; 7.27 «Armor per agility … to 1/6»;
//    12 маны за интеллект. Числа записаны здесь явно: тест сверяет формулы движка с источником,
//    а не с самим движком.
{
  const avg = (h) => (h.stats.base_attack_min + h.stats.base_attack_max) / 2;
  const bane = heroes['bane'];
  const expected = avg(bane) + 0.45 * (bane.stats.base_str + bane.stats.base_agi + bane.stats.base_int);
  ok(Math.abs(heroDamage(bane) - expected) < 0.01, 'урон универсала = база + 0.45×(сила+ловкость+интеллект) (с 7.38)', `bane=${heroDamage(bane).toFixed(1)} (ожидалось ${expected.toFixed(1)})`);
  const qop = heroes['queenofpain'];
  ok(Math.abs(heroDamage(qop) - (avg(qop) + qop.stats.base_int)) < 0.01, 'урон интового героя = база + интеллект', `qop=${heroDamage(qop).toFixed(1)}`);
  const byAttr = { str: 'base_str', agi: 'base_agi', int: 'base_int' };
  const wrongPrimary = Object.values(heroes).filter((h) => h.primary_attr !== 'all'
    && Math.abs(heroDamage(h) - (avg(h) + h.stats[byAttr[h.primary_attr]])) > 1e-9);
  ok(wrongPrimary.length === 0, 'урон силовиков, ловкачей и интовиков = база + основной атрибут (все герои)', wrongPrimary.map((h) => h.slug).join(', '));
  const universals = Object.values(heroes).filter((h) => h.primary_attr === 'all');
  ok(universals.length > 0 && universals.every((h) => Math.abs(heroDamage(h) - (avg(h) + 0.45 * (h.stats.base_str + h.stats.base_agi + h.stats.base_int))) < 1e-9),
    `формула универсала верна для всех ${universals.length} универсалов`);
  const axe = heroes['axe'];
  ok(heroHp(axe) === axe.stats.base_health + 22 * axe.stats.base_str, 'HP = база + 22×сила', `axe=${heroHp(axe)}`);
  ok(heroMana(qop) === qop.stats.base_mana + 12 * qop.stats.base_int, 'мана = база + 12×интеллект', `qop=${heroMana(qop)}`);
  const pa = heroes['phantom_assassin'];
  ok(Math.abs(heroArmor(pa) - (pa.stats.base_armor + pa.stats.base_agi / 6)) < 1e-9, 'броня = база + ловкость/6', `pa=${heroArmor(pa).toFixed(2)}`);
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
ok(!picks.some((p) => ['huskar', 'riki', 'tidehunter', 'oracle', 'medusa'].includes(p.slug)),
  'героя противника не предлагают взять себе (раньше в этом драфте рекомендовался Huskar)');
{
  // Свойство на сотнях случайных драфтов (детерминированный ГПСЧ): рекомендации никогда не включают
  // героев противника, своего героя и союзников, без повторов и не длиннее limit.
  let seed = 41;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const all = Object.keys(heroes);
  const pickN = (n, used) => { const out = []; while (out.length < n) { const s = all[Math.floor(rnd() * all.length)]; if (!used.has(s)) { used.add(s); out.push(s); } } return out; };
  let violations = 0;
  for (let k = 0; k < 300; k++) {
    const used = new Set();
    const enemies = pickN(1 + Math.floor(rnd() * 5), used);
    const [me] = pickN(1, used);
    const allies = pickN(Math.floor(rnd() * 5), used);
    const res = counterPicks({ enemies, enemyMid: enemies[0], data, limit: 6, exclude: [me, ...allies] });
    const bad = res.filter((p) => enemies.includes(p.slug) || p.slug === me || allies.includes(p.slug));
    if (bad.length || new Set(res.map((p) => p.slug)).size !== res.length || res.length > 6) violations++;
  }
  ok(violations === 0, 'на 300 случайных драфтах рекомендации не содержат занятых героев и повторов', `нарушений: ${violations}`);
}

// 6. закуп и чеклист
const plan = buildPlan({ heroSlug: 'queenofpain', enemySlugs: ['riki', 'clinkz', 'huskar'], data });
ok(plan.items.start.length > 0 && plan.items.core.length > 0, 'закуп собирается', `ситуативных: ${plan.items.situational.length}`);
// Ситуативный закуп = курируемый список героя (он не должен теряться) + до 10 адаптивных ответов на теги.
const curatedSituational = (plan.plan.items.situational || []).map(([key]) => key);
ok(plan.items.situational.length <= curatedSituational.length + 10,
  'ситуативный закуп ограничен по приоритету', `курируемых: ${curatedSituational.length}, всего: ${plan.items.situational.length}`);
ok(curatedSituational.length > 0 && curatedSituational.every((key) => plan.items.situational.some((i) => i.key === key)),
  'курируемые ситуативные предметы плана попадают в закуп', `в плане: ${curatedSituational.length}`);
ok(new Set(plan.items.situational.map((i) => i.key)).size === plan.items.situational.length, 'в ситуативном закупе нет повторов по ключу');
ok(plan.items.situational.every((i) => items[i.key]), 'ситуативные предметы существуют');
const generic = buildPlan({ heroSlug: 'largo', enemySlugs: ['riki'], data });
ok(!generic.curated && generic.items.core.length > 0, 'для героя без плана есть сборка по роли');

// 6.1 архетипы ролей: у 91 героя нет курируемого плана, и закуп им собирается по роли героя,
// а не одним универсальным списком (раньше это был bottle+treads+BKB для всех).
{
  const archetypes = JSON.parse(fs.readFileSync('data/kb/archetypes.json', 'utf8'));
  const names = Object.keys(archetypes.archetypes);
  ok(names.length >= 4, `архетипов в базе: ${names.join(', ')}`);
  const noPlan = Object.keys(heroes).filter((s) => !plans[s]);
  const unresolved = noPlan.filter((s) => !archetypeFor(heroes[s], archetypes));
  ok(unresolved.length === 0, `у каждого героя без плана есть роль (без роли: ${unresolved.length}${unresolved.length ? ` — ${unresolved.join(', ')}` : ''})`);
  const badItems = [];
  for (const [name, a] of Object.entries(archetypes.archetypes)) {
    for (const group of ['start', 'early', 'core']) for (const [key] of a[group] || []) if (!items[key]) badItems.push(`${name}.${group}:${key}`);
    for (const [attr, pair] of Object.entries(a.statByAttr || {})) if (!items[pair[0]]) badItems.push(`${name}.statByAttr.${attr}:${pair[0]}`);
    for (const [attr, list] of Object.entries(a.coreByAttr || {})) for (const [key] of list || []) if (!items[key]) badItems.push(`${name}.coreByAttr.${attr}:${key}`);
  }
  ok(badItems.length === 0, `все предметы архетипов есть в данных (нет: ${badItems.join(', ') || 'нет'})`);

  // Закуп поддержки, керри и оффлейнера обязан различаться: это и есть смысл архетипов.
  const support = buildPlan({ heroSlug: 'crystal_maiden', enemySlugs: ['riki'], data });
  const carry = buildPlan({ heroSlug: 'antimage', enemySlugs: ['riki'], data });
  const offlane = buildPlan({ heroSlug: 'axe', enemySlugs: ['riki'], data });
  const keys = (p, group) => p.items[group].map((i) => i.key).join(',');
  ok(support.archetype && support.archetype.name === 'support' && support.items.start.some((i) => i.key === 'ward_observer'),
    `поддержке предлагаются варды: ${keys(support, 'start')}`);
  ok(carry.archetype && carry.archetype.name === 'carry' && carry.items.start.some((i) => i.key === 'quelling_blade'),
    `керри получает добивание: ${keys(carry, 'start')}`);
  ok(offlane.archetype && offlane.archetype.name === 'offlane' && offlane.items.core.some((i) => i.key === 'blink'),
    `оффлейнер получает инициацию: ${keys(offlane, 'core')}`);
  ok(keys(support, 'start') !== keys(carry, 'start') && keys(carry, 'core') !== keys(support, 'core'),
    'закуп разных ролей не совпадает');
  ok(carry.items.core.some((i) => i.key === 'manta'), `керри-ловкач получает предмет под атрибут: ${keys(carry, 'core')}`);
  const strCarry = buildPlan({ heroSlug: 'sven', enemySlugs: [], data });
  ok(strCarry.items.core.some((i) => i.key === 'armlet'), `керри-силовик получает свой предмет: ${keys(strCarry, 'core')}`);
  const allCarry = buildPlan({ heroSlug: 'brewmaster', enemySlugs: [], data });
  ok(allCarry.items.core.some((i) => i.key === 'diffusal_blade'), `универсал получает свой предмет: ${keys(allCarry, 'core')}`);
  ok(support.items.core.every((i) => /роль/.test(i.source || '')), 'источник предметов роли подписан в закупе');
  ok(!support.skills.length || !support.skills.some(([k]) => abilities[k] && abilities[k].granted),
    'в порядок прокачки роли не попадают способности за шард/агханим');
  ok(support.curve && support.tips.length >= 2, 'у сборки по роли есть кривая и советы');
  const lich = buildPlan({ heroSlug: 'nyx_assassin', enemySlugs: [], data });
  ok(lich.archetype && lich.archetype.name === 'roam' && lich.archetype.why, `переназначенная роль объяснена: ${lich.archetype && lich.archetype.why}`);
  const curated = buildPlan({ heroSlug: 'queenofpain', enemySlugs: [], data });
  ok(curated.curated && !curated.archetype, 'у курируемого плана архетип не подмешивается');
}
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

// 6c. Порядок способностей: без дублей по имени и без под-способностей ультимейтов/стоек.
{
  // Три Shadowraze (nevermore_shadowraze1/2/3) — это один слот прокачки, а не три строки.
  const razeNames = heroLearnableSkills(heroes.nevermore, abilities)
    .map((k) => abilities[k]?.dname || k).filter((n) => n === 'Shadowraze');
  ok(razeNames.length === 1, 'у Nevermore в порядке прокачки одна Shadowraze, а не три',
    heroLearnableSkills(heroes.nevermore, abilities).map((k) => abilities[k]?.dname || k).join(' → '));
  // Под-способности: их открывает другая способность героя, отдельными слотами они не качаются.
  const subs = ['ember_spirit_activate_fire_remnant', 'visage_stone_form_self_cast',
    'monkey_king_primal_spring', 'dark_willow_bedlam'];
  for (const key of subs) {
    const owner = Object.values(heroes).find((h) => [...h.slots.map((s) => s.key), ...h.extra].includes(key));
    ok(owner && !heroLearnableSkills(owner, abilities).includes(key),
      `под-способность ${key} не попадает в порядок прокачки`, owner ? owner.slug : 'герой не найден');
    ok(isSubAbility(key), `isSubAbility(${key}) — под-способность`);
  }
  const badList = [];
  for (const h of Object.values(heroes)) {
    const list = heroLearnableSkills(h, abilities);
    const names = list.map((k) => abilities[k]?.dname || k);
    if (new Set(names).size !== names.length) badList.push(`${h.slug}: дубль имени`);
    if (list.some((k) => isSubAbility(k))) badList.push(`${h.slug}: под-способность`);
  }
  ok(badList.length === 0, `у всех ${Object.keys(heroes).length} героев порядок прокачки без дублей и под-способностей`,
    badList.join(', ') || 'чисто');
}

// 6d. Выбранная роль меняет только закуп: порядок способностей и тайминги героя сохраняются.
{
  const qopPlan = plans.queenofpain;
  const qopCarry = buildPlan({ heroSlug: 'queenofpain', enemySlugs: ['riki'], data, role: 'carry' });
  ok(!qopCarry.curated && qopCarry.items.start.length > 0
    && qopCarry.items.start.every((i) => /роль/.test(i.source || '')),
    'закуп под роль «Керри» собирается по архетипу, а не курируемому мид-плану');
  ok(JSON.stringify(qopCarry.skills) === JSON.stringify(qopPlan.skills),
    'при другой роли порядок способностей героя из плана не сбрасывается в genericSkills');
  ok(qopCarry.spikes.length > 0 && JSON.stringify(qopCarry.spikes) === JSON.stringify(qopPlan.spikes),
    'при другой роли тайминги героя из плана не теряются');
  // Первый тег адаптивного предмета назван в source — строки закупа в интерфейсе выводят
  // только дополнительные теги (см. itemRows в assets/app.js), инвариант держит именно buildPlan.
  const adaptive = qopCarry.items.situational.filter((i) => i.source && i.source.startsWith('под их «'));
  const quoted = adaptive.filter((i) => (i.tags || [])
    .some((t) => i.source.includes(`«${tagsKb.vocabulary[t]?.title || t}»`)));
  ok(adaptive.length > 0 && quoted.length === adaptive.length,
    'первый тег каждого адаптивного предмета уже назван в source', `адаптивных: ${adaptive.length}`);
}

// 7. тайминги
ok(timings.events.some((e) => e.at === '20:00' && e.title.includes('Торментор')), 'Торментор 20:00 в таймингах');
ok(timings.events.some((e) => e.at === '7:00'), 'святилище мудрости 7:00 в таймингах');

// 8. Экспертные сценарии: драфт → ждемая угроза → предмет/пик-ответ → почему это верно
//    по контексту игры (tools/expert_scenarios.json). Это проверка осмысленности рекомендаций,
//    а не только того, что предметы существуют и не дублируются.
{
  const expert = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'expert_scenarios.json'), 'utf8'));
  ok(expert.cases.length >= 6 && expert.cases.every((c) => c.id && c.title && c.why),
    'экспертные сценарии подписаны: драфт → угроза → ответ → почему', `сценариев: ${expert.cases.length}`);
  for (const c of expert.cases) {
    const threats = c.enemies ? threatsFor(c.enemies, data) : [];
    for (const t of (c.expect && c.expect.threats) || []) {
      const found = threats.find((x) => x.tag === t.tag);
      const have = found ? found.items.map(([k]) => k) : [];
      ok(!!found, `[${c.id}] их состав показывает угрозу «${t.tag}»`,
        found ? '' : `нет; видно теги: ${threats.map((x) => x.tag).join(', ')}`);
      if (!found) continue;
      if (t.itemsAll) {
        const missing = t.itemsAll.filter((i) => !have.includes(i));
        ok(missing.length === 0 && t.itemsAll.every((i) => items[i]),
          `[${c.id}] ${t.tag} → в ответе обязательны: ${t.itemsAll.join(', ')}`,
          missing.length ? `нет: ${missing.join(', ')}` : `все предметы есть в базе`);
      }
      if (t.itemsAny) {
        const hit = t.itemsAny.find((i) => have.includes(i));
        ok(!!hit && t.itemsAny.every((i) => items[i]),
          `[${c.id}] ${t.tag} → в ответе один из подходящих контексту: ${t.itemsAny.join('/')}`,
          hit ? `найден: ${hit}` : `фактически: ${have.slice(0, 8).join(', ')}`);
      }
    }
    if (c.expect && c.expect.plan) {
      const plan = buildPlan({ heroSlug: c.expect.plan.hero, enemySlugs: c.enemies, data });
      const sit = plan.items.situational.map((i) => i.key);
      const missing = c.expect.plan.situationalAll.filter((i) => !sit.includes(i));
      ok(missing.length === 0,
        `[${c.id}] план ${c.expect.plan.hero} собирается под их драфт: ${c.expect.plan.situationalAll.join(', ')}`,
        missing.length ? `не хватает: ${missing.join(', ')}` : `ситуативно: ${sit.slice(0, 12).join(', ')}`);
    }
    if (c.expect && c.expect.picks) {
      const want = c.expect.picks;
      const picks = counterPicks({ enemies: c.enemies, enemyMid: c.enemyMid, data, limit: want.top });
      const top = picks.slice(0, want.top).map((p) => p.slug);
      const hit = want.anyOf.find((s) => top.includes(s));
      ok(!!hit, `[${c.id}] ожидаемый контр-пик (${want.anyOf.join('/')}) в топ-${want.top} по контексту`,
        `топ: ${top.join(', ')}`);
    }
    if (c.expect && c.expect.lane) {
      const l = c.expect.lane;
      const r = laneReport(heroes[c.me], heroes[l.vs], ctx);
      const scoreOk = (l.maxScore === undefined || r.score <= l.maxScore)
        && (l.minScore === undefined || r.score >= l.minScore);
      ok(scoreOk && r.verdict.title === l.title,
        `[${c.id}] лейн ${c.me} против ${l.vs}: «${l.title}» и счёт в ожидаемом диапазоне`,
        `фактически: «${r.verdict.title}» (score ${r.score})`);
    }
  }
}

console.log(failed === 0 ? '\nВсе проверки пройдены.\n' : `\nПровалено проверок: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
