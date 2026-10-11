/**
 * analysis.js — движок разбора драфта.
 *
 * Модуль не зависит от DOM и работает как в браузере, так и в Node (для тестов).
 * Вся логика строится на данных 7.41 (data/*.json) и правилах из data/kb/*.json:
 * ничего не «додумывается» о патче — если данных нет, движок честно об этом пишет.
 */

const ATTR_KEY = { str: 'base_str', agi: 'base_agi', int: 'base_int', all: null };

/** Средний урон автоатаки: база + основной атрибут (для универсалов — 0.7 за каждый пункт любого из трёх). */
export function heroDamage(h) {
  const base = ((h.stats.base_attack_min || 0) + (h.stats.base_attack_max || 0)) / 2;
  const attr = h.primary_attr === 'all'
    ? 0.7 * ((h.stats.base_str || 0) + (h.stats.base_agi || 0) + (h.stats.base_int || 0))
    : h.stats[ATTR_KEY[h.primary_attr]] || 0;
  return base + attr;
}

export function heroHp(h) {
  return (h.stats.base_health || 0) + 22 * (h.stats.base_str || 0);
}

export function heroMana(h) {
  return (h.stats.base_mana || 0) + 12 * (h.stats.base_int || 0);
}

export function heroArmor(h) {
  return (h.stats.base_armor || 0) + (h.stats.base_agi || 0) / 6;
}

const r1 = (n) => Math.round(n * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Оценка мид-лейна «я против их мида».
 * Считает только измеримые вещи из клиента: дистанция атаки, урон, анимация, броня,
 * мобильность, састен и угрозу убийства по тегам.
 */
export function laneReport(me, them, ctx) {
  if (!me || !them) return null;
  const { tagsKb, rules, plans } = ctx;
  const myTags = (tagsKb.heroes && tagsKb.heroes[me.slug]) || [];
  const theirTags = (tagsKb.heroes && tagsKb.heroes[them.slug]) || [];
  const has = (arr, t) => arr.includes(t);
  const factors = [];
  let score = 0;

  // 1. Дистанция атаки
  const rangeDiff = (me.stats.attack_range || 0) - (them.stats.attack_range || 0);
  if (me.attack_type !== them.attack_type || Math.abs(rangeDiff) > 50) {
    const v = clamp(rangeDiff / 120, -2.5, 2.5);
    score += v;
    factors.push({
      label: 'Дистанция атаки',
      me: `${me.stats.attack_range}`, them: `${them.stats.attack_range}`,
      note: rangeDiff > 120 ? 'ты бьёшь и харишь из безопасной зоны'
        : rangeDiff < -120 ? 'тебя будут бить там, где ты не ответишь'
          : 'примерно равные дистанции — решает позиция',
      value: v,
    });
  }

  // 2. Урон
  const dmgDiff = heroDamage(me) - heroDamage(them);
  {
    const v = clamp(dmgDiff / 12, -2, 2);
    score += v;
    factors.push({
      label: 'Урон автоатаки на 1 уровне',
      me: r1(heroDamage(me)).toFixed(0), them: r1(heroDamage(them)).toFixed(0),
      note: dmgDiff > 6 ? 'каждый размен в твою пользу' : dmgDiff < -6 ? 'размены на линии проигрышны' : 'практически равный урон',
      value: v,
    });
  }

  // 3. Анимация и снаряд (добивание и харрас)
  const animMe = (me.stats.attack_point || 0) + (me.stats.projectile_speed ? 300 / me.stats.projectile_speed : 0);
  const animThem = (them.stats.attack_point || 0) + (them.stats.projectile_speed ? 300 / them.stats.projectile_speed : 0);
  {
    const v = clamp((animThem - animMe) * 4, -1, 1);
    score += v;
    factors.push({
      label: 'Удобство добивания',
      me: `${animMe.toFixed(2)}s до удара`,
      them: `${animThem.toFixed(2)}s до удара`,
      note: animMe < animThem ? 'у тебя быстрее анимация и полёт снаряда — денаить легче' : 'их анимация удобнее: следи за добиванием',
      value: v,
    });
  }

  // 4. Броня и живучесть
  const armorDiff = heroArmor(me) - heroArmor(them);
  {
    const v = clamp(armorDiff / 4, -1, 1);
    score += v;
    factors.push({
      label: 'Броня на 1 уровне (оценка)',
      me: r1(heroArmor(me)).toString(), them: r1(heroArmor(them)).toString(),
      note: armorDiff > 1.5 ? 'физические размены выигрываешь ты' : armorDiff < -1.5 ? 'их обычные удары бьют больнее' : 'броня сопоставима',
      value: v,
    });
  }

  // 5. Мобильность и угроза убийства из тегов
  const tagChecks = [
    ['gap_close', has(myTags, 'gap_close'), has(theirTags, 'gap_close'), 'Дистанция закрывается', 'у тебя есть чем доехать до цели', 'у него есть чем доехать до тебя', 0.8],
    ['poke_lane', has(myTags, 'poke_lane'), has(theirTags, 'poke_lane'), 'Харрас на линии', 'ты душишь его с дистанции', 'он харрасит тебя без ответа', 0.8],
    ['lane_sustain', has(myTags, 'lane_sustain'), has(theirTags, 'lane_sustain'), 'Реген (састейн) на линии', 'размены тебе не страшны', 'он восстанавливается быстрее тебя', 0.7],
    ['burst_magical', false, has(theirTags, 'burst_magical'), 'Угроза маг. бурста', '', 'одна связка может быть смертельной — держи дистанцию', -1.0],
    ['burst_physical', false, has(theirTags, 'burst_physical'), 'Угроза физ. урона', '', 'не подпускай под автоатаки', -0.9],
    ['waveclear', has(myTags, 'waveclear'), has(theirTags, 'waveclear'), 'Контроль волны', 'ты быстрее выдавливаешь волну и идёшь к рунам', 'он первым уходит на руны и ганги', 0.5],
    ['roam_ganker', false, has(theirTags, 'roam_ganker'), 'Риск гангов', '', 'он роумит: ставь вард на подходе к миду', -0.7],
  ];
  for (const [tag, mine, theirs, label, noteMe, noteThem, w] of tagChecks) {
    if (!mine && !theirs) continue;
    const v = mine && !theirs ? Math.abs(w) : !mine && theirs ? -Math.abs(w) : 0;
    score += v;
    factors.push({ label, me: mine ? 'да' : '—', them: theirs ? 'да' : '—', note: v > 0 ? noteMe : v < 0 ? noteThem : 'качества сопоставимы', value: v, tag });
  }

  // 6. Матчап из планов героев (ручная разметка «кто кого стоит»)
  if (plans) {
    const myPlan = plans[me.slug];
    const theirPlan = plans[them.slug];
    let v = 0;
    const notes = [];
    if (myPlan?.beats?.includes(them.slug)) { v += 2.5; notes.push('в планах героя отмечено, что ты хорошо стоишь против него'); }
    if (myPlan?.loses_to?.includes(them.slug)) { v -= 2.5; notes.push('в планах героя отмечено, что он давит на тебя'); }
    if (theirPlan?.beats?.includes(me.slug)) { v -= 1.5; notes.push('его матчап-план включает победу над тобой'); }
    if (theirPlan?.loses_to?.includes(me.slug)) { v += 1.5; notes.push('его план прямо указывает на слабость против тебя'); }
    if (v !== 0) {
      score += v;
      factors.push({ label: 'Матчап и механики', me: '', them: '', note: notes.join('; '), value: v });
    }
  }

  const s = clamp(score, -10, 10);
  const verdict = s >= 4 ? { title: 'Комфортный лейн', tone: 'good', text: 'Ты можешь фармить агрессивно и забирать руны. Играй на выигрыш лейна, а не на выживание.' }
    : s >= 1.5 ? { title: 'Лёгкий перевес', tone: 'good', text: 'Лейн в твою сторону: дави волну, забирай воду и не давай им фармить спокойно.' }
      : s > -1.5 ? { title: 'Ровный лейн', tone: 'even', text: 'Лейн решится позиционированием и хилками, а не героями: следи за HP и не трать ресурсы на пустые трейды.' }
        : s > -4 ? { title: 'Тяжёлый лейн', tone: 'bad', text: 'Ты проигрываешь размены: играй от своей башни, тяни уровни и проси ротацию саппорта.' }
          : { title: 'Лейн проигран по цифрам', tone: 'bad', text: 'Прямые размены бессмысленны. Задача — не умереть, добирать опыт и ждать ганга или своего тайминга с 6-го уровня.' };

  const tips = [];
  if ((me.stats.attack_range || 0) - (them.stats.attack_range || 0) < -150) tips.push('Держи дистанцию больше их радиуса ответа: харась только когда их способность на КД.');
  if ((me.stats.base_health_regen || 0) < 1 && !has(myTags, 'lane_sustain')) tips.push('У тебя слабый реген: купи сали/фляску и не разменивайся ниже 60% HP.');
  if (has(theirTags, 'silence')) tips.push('Их сайленс опасен на линии: не стой в радиусе сайленса и держи ману на побег.');
  if (has(theirTags, 'roam_ganker')) tips.push('Их герой роумит: вард на подходе к миду дешевле, чем одна смерть.');
  if (has(myTags, 'waveclear')) tips.push('Выталкивай волну перед каждой руной: руна 2:00/4:00 (вода) и 6:00 (сила) — твой бесплатный темп.');
  if (has(theirTags, 'hex_root') || has(theirTags, 'single_target_lockdown')) tips.push('У них есть чем тебя поймать: не стой в открытом поле на низком HP.');
  return { score: r1(s), verdict, factors, tips };
}

/** Карта тегов из правил (для UI). */
export function tagMeta(tagsKb, rules, tag) {
  return {
    ...(tagsKb.vocabulary[tag] || { title: tag, why: '' }),
    ...(rules.rules[tag] || {}),
  };
}

/** Ключевые слова в описаниях способностей — резервный разбор для героев без ручной разметки. */
const KEYWORD_TAGS = [
  [/silenc/i, 'silence'],
  [/\bhex\b|ensnare|превращает в лягушку/i, 'hex_root'],
  [/\broot|приков/i, 'hex_root'],
  [/stun|knock ?up in the air|taunt|fear|mesmeriz/i, 'heavy_lockdown'],
  [/invisib|in a cloud of smoke|скрывает/i, 'invis'],
  [/illusion/i, 'illusions'],
  [/summon|spiderling|eidolon|treant|familiar|zombie|golem|boar|hawk|wolves|bear\b/i, 'summons'],
  [/disable their passives|disables passives|break the target/i, 'disables_passives'],
  [/evasion|miss chance|chance to miss/i, 'evasion'],
  [/lifesteal|restores? health|grants? health|increases? health regeneration|heals? /i, 'heavy_heal'],
  [/barrier|damage reduction|immune to damage|untargetable/i, 'save'],
  [/teleport|anywhere on the map|across the map/i, 'global'],
  [/mana burn|burn.{0,12}mana|steal.{0,12}mana|drain.{0,12}mana/i, 'mana_burn'],
  [/blinks?|dash|leaps?|charges toward|jumps? to/i, 'gap_close'],
  [/reduces? (their )?armor|armor reduction|reduces armor by/i, 'armor_reduce'],
  [/damage amplification|amplifies? .{0,16}damage|takes? more (magic|spell)? ?damage/i, 'magic_amp'],
];

/**
 * Угрозы драфта врага: ручные теги + авто-разбор текстов способностей.
 * Для каждой угрозы подставляются контрмеры из rules.json.
 */
export function threatsFor(enemySlugs, data) {
  const { heroes, abilities, tagsKb, rules } = data;
  enemySlugs = [...new Set(enemySlugs)]; // защита от дублей в слотах
  const out = [];
  const seen = new Set();
  const evidenceByHero = {}; // slug -> { tag: [строки «Герой: Способность»] }
  for (const slug of enemySlugs) {
    const h = heroes[slug];
    if (!h) continue;
    const manual = (tagsKb.heroes && tagsKb.heroes[slug]) || [];
    const auto = new Set();
    const ev = {};
    for (const slot of [...h.slots, ...h.extra.map((k) => ({ key: k }))]) {
      const a = abilities[slot.key];
      if (!a || !a.desc) continue;
      if (a.desc.length < 40) continue;
      for (const [re, tag] of KEYWORD_TAGS) {
        if (re.test(a.desc)) {
          auto.add(tag);
          if (!ev[tag]) ev[tag] = [];
          if (ev[tag].length < 3) ev[tag].push(`${h.localized_name}: ${a.dname}`);
        }
      }
    }
    evidenceByHero[slug] = ev;
    const tags = new Set(manual);
    for (const t of auto) if (!manual.includes(t)) tags.add(t); // авто — только как дополнение
    for (const tag of tags) {
      const rule = rules.rules[tag];
      if (!rule) continue;
      const key = tag;
      const existing = out.find((o) => o.tag === tag);
      if (existing) { existing.heroes.push({ slug, name: h.localized_name }); continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        tag,
        title: (tagsKb.vocabulary[tag] || {}).title || tag,
        why: rule.why || (tagsKb.vocabulary[tag] || {}).why || '',
        severity: rule.severity || 1,
        items: rule.items || [],
        actions: rule.actions || [],
        heroes: [{ slug, name: h.localized_name }],
        auto: !manual.includes(tag),
      });
    }
  }
  // Свидетельства «по тексту способностей» — только от героев, входящих в эту угрозу.
  for (const t of out) {
    t.evidence = [...new Set(t.heroes.flatMap((h) => (evidenceByHero[h.slug] || {})[t.tag] || []))].slice(0, 3);
  }
  out.sort((a, b) => b.severity - a.severity || b.heroes.length - a.heroes.length);
  return out;
}

/** Комбо-предупреждения: несколько героев с одним тегом = отдельный совет. */
export function combosFor(enemySlugs, data) {
  const { tagsKb, rules } = data;
  const counts = {};
  for (const slug of enemySlugs) {
    for (const t of (tagsKb.heroes && tagsKb.heroes[slug]) || []) counts[t] = (counts[t] || 0) + 1;
  }
  const res = [];
  for (const combo of rules.combos || []) {
    const total = combo.tags.reduce((acc, t) => acc + (counts[t] || 0), 0);
    if (total >= combo.min) res.push({ ...combo, hits: total });
  }
  return res.sort((a, b) => b.hits - a.hits);
}

/** Рекомендации по пикам: кто из мидовых героев хорошо стоит против их драфта.
 *  exclude — уже занятые герои (я и союзники), их не предлагаем. */
export function counterPicks({ enemies, enemyMid, data, limit = 6, exclude = [] }) {
  const { heroes, plans, tagsKb, rules } = data;
  const tagRules = rules.rules;
  const enemySet = enemies.filter(Boolean);
  const skip = new Set(exclude.filter(Boolean));
  const results = [];
  for (const [slug, plan] of Object.entries(plans)) {
    if (slug.startsWith('_') || !plan.mid) continue;
    if (skip.has(slug)) continue;
    const h = heroes[slug];
    if (!h) continue;
    let score = 0;
    const reasons = [];
    for (const e of enemySet) {
      if ((plan.beats || []).includes(e)) { score += 2; reasons.push(`хорошо стоит против ${heroes[e]?.localized_name || e}`); }
      if ((plan.loses_to || []).includes(e)) { score -= 1.5; }
      for (const t of (tagsKb.heroes && tagsKb.heroes[e]) || []) {
        if ((tagRules[t]?.picks || []).includes(slug)) { score += 1; reasons.push(`ответ на «${(tagsKb.vocabulary[t] || {}).title || t}»`); }
      }
    }
    if (enemyMid && heroes[enemyMid]) {
      const lane = laneReport(h, heroes[enemyMid], { tagsKb, rules });
      if (lane) { score += clamp(lane.score * 0.35, -3, 3); if (lane.score > 2) reasons.push('выигрывает лейн по цифрам'); }
    }
    results.push({ slug, name: h.localized_name, score: r1(score), reasons: [...new Set(reasons)].slice(0, 4) });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit).filter((r) => r.score > 0);
}

/** Сборка плана: базовый билд героя + адаптация под теги врага. */
export function buildPlan({ heroSlug, enemySlugs, data }) {
  const { heroes, plans, rules, tagsKb } = data;
  const h = heroes[heroSlug];
  if (!h) return null;
  const plan = plans[heroSlug];
  const enemyTags = new Set();
  for (const slug of enemySlugs) for (const t of (tagsKb.heroes && tagsKb.heroes[slug]) || []) enemyTags.add(t);

  const items = { start: [], early: [], core: [], situational: [] };
  if (plan && plan.items) {
    for (const g of Object.keys(items)) items[g] = (plan.items[g] || []).map(([k, why]) => ({ key: k, why, source: 'план героя' }));
  } else {
    // Универсальный мидовый старт, если герой не в курируемом списке.
    const attr = h.primary_attr;
    const statItem = attr === 'str' ? 'bracer' : attr === 'agi' ? 'wraith_band' : 'null_talisman';
    items.start = [
      { key: 'tango', why: 'реген на размены', source: 'универсально' },
      { key: 'branches', why: 'статы и гибкость', source: 'универсально' },
      { key: statItem, why: 'статы под размены', source: 'универсально' },
    ];
    items.early = [
      { key: 'bottle', why: 'реген и мана от рун воды', source: 'универсально' },
      { key: 'power_treads', why: 'статы и атакспид', source: 'универсально' },
      { key: 'magic_wand', why: 'заряды от их кастов', source: 'универсально' },
    ];
    items.core = [
      { key: 'black_king_bar', why: 'без него с 25-й минуты ты не играешь файты', source: 'универсально' },
    ];
  }

  const situational = new Map();
  const orderedTags = Object.entries(rules.rules)
    .filter(([tag]) => enemyTags.has(tag))
    .sort((a, b) => (b[1].severity || 1) - (a[1].severity || 1));
  for (const [tag, rule] of orderedTags) {
    for (const [key, why] of rule.items || []) {
      if (['start', 'early', 'core'].some((g) => items[g].some((i) => i.key === key))) continue;
      if (situational.has(key)) {
        if (!situational.get(key).tags) situational.get(key).tags = [tag];
        else situational.get(key).tags.push(tag);
        continue;
      }
      situational.set(key, {
        key, why,
        source: `под их «${(tagsKb.vocabulary[tag] || {}).title || tag}»`,
        severity: rule.severity || 1,
        tags: [tag],
      });
    }
  }

  const skillPlan = plan && plan.skills ? plan.skills : null;
  const genericSkills = h.slots.filter((s) => s.i !== 5 && s.i < 4).map((s) => [s.key, 'основная способность — качай по ситуации']);
  const ult = h.slots.find((s) => s.i === 5);

  return {
    hero: h,
    plan,
    items: {
      ...items,
      situational: [...situational.values()]
        .sort((a, b) => (b.severity || 1) - (a.severity || 1))
        .slice(0, 10),
    },
    skills: skillPlan || genericSkills,
    ult: ult ? ult.key : null,
    lane: plan?.lane || null,
    spikes: plan?.spikes || [],
    tips: plan?.tips || [],
    curve: plan?.curve || null,
    difficulty: plan?.difficulty || null,
    curated: Boolean(plan),
  };
}

/** Чеклист на игру — из угроз, комбо и таймингов (data/kb/timings.json → checklist). */
export function buildChecklist({ threats, combos, data }) {
  const list = [];
  if (threats.some((t) => t.tag === 'roam_ganker')) list.push('Вард на проходе к миду к 3-4 минуте (50 золота против одной смерти)');
  if (threats.some((t) => t.tag === 'invis')) list.push('Сентри/дасты в инвентаре до 10-й минуты');
  if (threats.some((t) => t.tag === 'silence' || t.tag === 'heavy_lockdown')) list.push('План на диспел: циклон/Manta или БКБ в первом крупном закупе');
  if (threats.some((t) => t.tag === 'burst_magical')) list.push('Рейндаропы и маг. wand на линии важнее лишнего урона');
  if (threats.some((t) => t.tag === 'save')) list.push('Порядок файта: сначала сайленс/хекс на спасающего, потом бурст');
  if (combos.length) list.push(`Запомни комбо-предупреждение: ${combos[0].advice.split('.')[0]}`);
  list.push(...((data && data.timings && data.timings.checklist) || []));
  return list;
}
