/**
 * analysis.js — движок разбора драфта.
 *
 * Модуль не зависит от DOM и работает как в браузере, так и в Node (для тестов).
 * Вся логика строится на данных 7.41 (data/*.json) и правилах из data/kb/*.json:
 * ничего не «додумывается» о патче — если данных нет, движок честно об этом пишет.
 */

const ATTR_KEY = { str: 'base_str', agi: 'base_agi', int: 'base_int', all: null };

/**
 * Урон универсала за каждый пункт силы, ловкости и интеллекта. Патч 7.38: «Universal Heroes'
 * damage per attribute decreased from 0.7 to 0.45» (патчноуты dotaconstants и dota2.com/patches/7.38);
 * в 7.39–7.41f множитель не менялся.
 */
export const UNIVERSAL_DAMAGE_PER_ATTRIBUTE = 0.45;

/** Средний урон автоатаки: база + основной атрибут (для универсалов — 0.45 за каждый пункт любого из трёх). */
export function heroDamage(h) {
  const base = ((h.stats.base_attack_min || 0) + (h.stats.base_attack_max || 0)) / 2;
  const attr = h.primary_attr === 'all'
    ? UNIVERSAL_DAMAGE_PER_ATTRIBUTE * ((h.stats.base_str || 0) + (h.stats.base_agi || 0) + (h.stats.base_int || 0))
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

/** Многоуровневая способность: уровни считает сборщик данных (длина массивов mc/cd/attrib). */
const abilityLevels = (a) => (a && Number.isFinite(a.levels) ? a.levels : 0);
const abilityBehavior = (a) => {
  const b = a && a.behavior;
  return Array.isArray(b) ? b : b ? [b] : [];
};

/** Служебный слот: под украденное/съеденное заклинание (*_empty1, *_empty_souvenir). */
const SERVICE_KEY_RE = /_empty(\d+|_|$)/;

/**
 * Запись источника без собственной способности: служебный слот (Stolen Spell, Devoured Ability,
 * Souvenir Slot) или скрытая техническая запись без названия и описания (rubick_hidden1,
 * dawnbreaker_land). Такие записи не показываем и не качаем.
 */
export function isServiceAbility(key, a) {
  return SERVICE_KEY_RE.test(String(key)) || !a || (!a.dname && !a.desc);
}

/**
 * Изучаемая способность 7.41. Признаки берутся из данных, а не из догадок:
 *   • у изучаемых есть уровни (длина шкал attrib/mc/cd), у врождённых пассивок и под-способностей их нет;
 *   • врождённые (Necromastery, Static Field, Eureka!, Dragon Blood, Greevil's Greed, Mana Shield)
 *     качать нельзя — кроме тех, что открываются на уровне героя (first_ability_level: Invoke);
 *   • шард/агханим выдают «новую способность» предметом (Warp Flare, Nimbus, Fireball, Cold Blooded);
 *   • скрытые записи — под-способности и служебные слоты.
 */
export function isLearnableAbility(key, a) {
  if (!a || isServiceAbility(key, a)) return false;
  if (a.granted) return false;
  if (abilityBehavior(a).includes('Hidden')) return false;
  const unlocked = Number.isFinite(a.firstLevel);
  if (a.innate === true && !unlocked) return false;
  return abilityLevels(a) >= 1 || unlocked;
}

/**
 * Строка в «Порядке способностей» плана героя. Обычно это изучаемая способность, но у героев
 * с вызываемыми заклинаниями (Invoker: Chaos Meteor, Sun Strike) в списке стоят и они — как
 * связанные способности героя из extra. Врождённые пассивки и шард-способности не подходят:
 * именно они раньше попадали в порядок прокачки вместо базовых слотов 7.41.
 */
export function isPlanSkill(key, hero, abilities = {}) {
  const a = abilities[key];
  if (isLearnableAbility(key, a)) return true;
  if (!a || a.innate === true || a.granted) return false;
  return Boolean(hero && Array.isArray(hero.extra) && hero.extra.includes(key));
}

/**
 * Базовые (качаемые) способности героя в порядке слотов — для героев без курируемого плана.
 */
export function heroLearnableSkills(h, abilities = {}) {
  const keys = [...(h.slots || []).map((s) => s.key), ...(h.extra || [])];
  const seen = new Set();
  const out = [];
  for (const key of keys) {
    if (seen.has(key) || !isLearnableAbility(key, abilities[key])) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Ультимейт героя: изучаемая способность в слоте 5. Если в этом слоте лежит врождённая пассивка
 * (Dumb Luck у Огра-мага), берём изучаемую из extra (Multicast); если и такой нет — ульта в базе
 * нет. Invoke у Invoker стоит в слоте 5 и считается изучаемой: 7.41b даёт ей уровень на 6/12/18.
 */
export function heroUltimateKey(h, abilities = {}) {
  const slot5 = (h.slots || []).find((s) => s.i === 5);
  if (slot5 && isLearnableAbility(slot5.key, abilities[slot5.key])) return slot5.key;
  const fromExtra = (h.extra || []).find((k) => isLearnableAbility(k, abilities[k]));
  return fromExtra || null;
}

/**
 * Оценка мид-лейна «я против их мида».
 * Считает только измеримые вещи из клиента: дистанция атаки, урон, анимация, броня,
 * мобильность, састен и угрозу убийства по тегам.
 */
export function laneReport(me, them, ctx) {
  if (!me || !them) return null;
  const { tagsKb, plans } = ctx;
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

  // 3. Анимация и снаряд (добивание и харрас). Полёт снаряда есть только у дальних героев:
  //    у милишников в константах лежит заглушка (projectile_speed = 900), из-за которой лейн
  //    получал лишние +0.33 с, — считаем снаряд только при attack_type === 'Ranged'.
  const flightTime = (h) => (h.attack_type === 'Ranged' && h.stats.projectile_speed ? 300 / h.stats.projectile_speed : 0);
  const animMe = (me.stats.attack_point || 0) + flightTime(me);
  const animThem = (them.stats.attack_point || 0) + flightTime(them);
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

/**
 * Ключевые слова в описаниях способностей — резервный разбор для героев без ручной разметки.
 * Формулировки подобраны так, чтобы не ловить противоположное по смыслу: «reveals invisible
 * enemy units» (Slardar, Drow, Chronosphere) — это ответ на невидимость, а не невидимость;
 * «summons a column of flames» (Lina) и «summons a rising torrent» (Kunkka) — эффекты, а не
 * саммоны; «short distance teleportation» (Blink у QoP и Anti-Mage) — блинк, а не глобальный
 * каст. Авто-разбор включается только у героя без ручной разметки (см. threatsFor).
 */
const KEYWORD_TAGS = [
  [/silenc/i, 'silence'],
  [/\bhex\b|ensnare|превращает в лягушку/i, 'hex_root'],
  [/\broot|приков/i, 'hex_root'],
  [/stun|knock ?up in the air|taunt|fear|mesmeriz/i, 'heavy_lockdown'],
  [/(becom(e|es|ing)|remains?|stays?|turns?|fades?)\b[^.]{0,40}\binvisible\b|(?<!\b(reveal\w*|going)\s)\binvisib(le|ly|ility)\b(?![^.]{0,30}\b(enem\w*|unit\w*|hero\w*|target\w*|reveal\w*|see\w*|vision\w*|true sight)\b)|in a cloud of (smoke|shadows?)|out of visibility|скрывает(ся)?|невидим/i, 'invis'],
  [/illusion/i, 'illusions'],
  [/summons? (a|an|the|his|her|its|their)? ?(?:\w+ )?(spirit|bear|boar|hawk|wolves|wolf|eidolon|treant|familiar|spiderling|zombie|golem|skeletons?|serpent|unit|creep|beast|demon|tombstone|ward)s?\b|takes? control of|under (his|her|their|its) control|spiderling|eidolon|treant|familiar|\bboar\b|\bhawk\b|\bwolves\b|\bbear\b|\bskeletons?\b/i, 'summons'],
  [/disable their passives|disables passives|break the target/i, 'disables_passives'],
  [/evasion|miss chance|chance to miss/i, 'evasion'],
  [/lifesteal|restores? health|grants? health|increases? health regeneration|heals? /i, 'heavy_heal'],
  [/barrier|damage reduction|immune to damage|untargetable/i, 'save'],
  [/anywhere on the map|across the map|to any point on the map|to any location|any location on the battlefield|\bglobally\b/i, 'global'],
  [/mana burn|burn.{0,12}mana|steal.{0,12}mana|drain.{0,12}mana/i, 'mana_burn'],
  [/blinks?|dash|leaps?|charges toward|jumps? to/i, 'gap_close'],
  [/reduces? (their )?armor|armor reduction|reduces armor by/i, 'armor_reduce'],
  [/damage amplification|amplifies? .{0,16}damage|takes? more (magic|spell)? ?damage/i, 'magic_amp'],
];

/**
 * Угрозы драфта врага: ручные теги героя + авто-разбор текстов способностей.
 * Для каждой угрозы подставляются контрмеры из rules.json.
 *
 * Авто-разбор — только резерв для героя без ручной разметки: если разметка есть, ключевые слова
 * не подмешиваются. Иначе грубые совпадения давали ложные угрозы: невидимость у Slardar
 * («revealing invisibility»), Drow и Faceless Void (их способности её *раскрывают*), глобальный
 * каст у QoP и Anti-Mage (короткий блинк), саммоны у Lina, Kunkka и Tidehunter («summons a
 * column of flames»).
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
    const ev = {};
    if (!manual.length) {
      // Ручной разметки нет — разбираем тексты способностей как дополнение.
      for (const slot of [...h.slots, ...h.extra.map((k) => ({ key: k }))]) {
        const a = abilities[slot.key];
        if (!a || !a.desc) continue;
        if (a.desc.length < 40) continue;
        for (const [re, tag] of KEYWORD_TAGS) {
          if (re.test(a.desc)) {
            if (!ev[tag]) ev[tag] = [];
            if (ev[tag].length < 3) ev[tag].push(`${h.localized_name}: ${a.dname}`);
          }
        }
      }
    }
    evidenceByHero[slug] = ev;
    const tags = Object.keys(ev).length ? [...manual, ...Object.keys(ev).filter((t) => !manual.includes(t))] : manual;
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
  // Дубли слотов не должны удваивать счётчик тегов: два «Riki» — это один Riki.
  for (const slug of new Set((enemySlugs || []).filter(Boolean))) {
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
  // Героя, уже взятого противником, взять нельзя: такие пики не предлагаем никогда.
  const skip = new Set([...exclude.filter(Boolean), ...enemySet]);
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
      // Планы передаём те же, что и на вкладке «Драфт»: иначе оценка лейна в рекомендациях
      // расходится с вердиктом по тому же самому матчапу (матчап-термин не учитывался).
      const lane = laneReport(h, heroes[enemyMid], { tagsKb, rules, plans });
      if (lane) { score += clamp(lane.score * 0.35, -3, 3); if (lane.score > 2) reasons.push('выигрывает лейн по цифрам'); }
    }
    results.push({ slug, name: h.localized_name, score: r1(score), reasons: [...new Set(reasons)].slice(0, 4) });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit).filter((r) => r.score > 0);
}

/**
 * Роли героя из клиента → архетип закупа. Порядок ролей в данных не случаен: первый слот — основная
 * роль героя, поэтому Carry в первом слоте — керри, а Axe («Initiator, Durable, …, Carry») — оффлейн.
 * Явные исключения (Pudge, Nyx Assassin и другие) лежат в data/kb/archetypes.json с объяснением:
 * без них Pudge уходил бы в мидовый закуп, а Mirana — в керрийный.
 * @returns {{name: string, title: string, why: string}|null}
 */
export function archetypeFor(hero, archetypes) {
  if (!hero || !archetypes || !archetypes.archetypes) return null;
  const all = archetypes.archetypes;
  const override = (archetypes.overrides || {})[hero.slug];
  let name = override && override.archetype;
  if (!name) {
    const roles = hero.roles || [];
    const first = roles[0] || '';
    if (roles.includes('Support') && !roles.includes('Carry')) name = 'support';
    else if (first === 'Carry') name = 'carry';
    else if (first === 'Support') name = 'support';
    else if (first === 'Initiator' || first === 'Durable') name = 'offlane';
    else name = 'mid';
  }
  const archetype = all[name];
  if (!archetype) return null;
  return { name, title: archetype.title || name, why: (override && override.why) || '', data: archetype };
}

/** Группы предметов архетипа: стартовый стат-предмет и «свой» большой слот зависят от атрибута. */
function archetypeItems({ archetype, title, attr }) {
  const source = `роль «${title}»`;
  const stage = (list) => (list || []).map(([key, why]) => ({ key, why, source }));
  const byAttr = archetype.statByAttr || {};
  const coreByAttr = archetype.coreByAttr || {};
  const stat = byAttr[attr] || byAttr.all;
  return {
    start: stage(stat ? [...(archetype.start || []), stat] : archetype.start),
    early: stage(archetype.early),
    core: stage([...(archetype.core || []), ...(coreByAttr[attr] || [])]),
  };
}

/** Сборка плана: базовый билд героя + адаптация под теги врага. */
export function buildPlan({ heroSlug, enemySlugs, data }) {
  const { heroes, abilities, plans, rules, tagsKb, archetypes } = data;
  const h = heroes[heroSlug];
  if (!h) return null;
  const plan = plans[heroSlug];
  const enemyTags = new Set();
  // Дубли слотов (подложенный localStorage или скриншот) теги не удваивают.
  for (const slug of new Set((enemySlugs || []).filter(Boolean))) {
    for (const t of (tagsKb.heroes && tagsKb.heroes[slug]) || []) enemyTags.add(t);
  }

  const items = { start: [], early: [], core: [], situational: [] };
  if (plan && plan.items) {
    for (const g of Object.keys(items)) items[g] = (plan.items[g] || []).map(([k, why]) => ({ key: k, why, source: 'план героя' }));
  } else {
    // Курируемого плана под 7.41 у героя нет — берём закуп его роли (data/kb/archetypes.json).
    // Раньше здесь был один универсальный мидовый старт: 91 герой из 127 получал одинаковые
    // bottle/treads и ядро из одного BKB, включая всех керри и всех поддержек.
    const arche = archetypeFor(h, archetypes);
    if (arche) Object.assign(items, archetypeItems({ archetype: arche.data, title: arche.title, attr: h.primary_attr }));
  }

  // Ситуативный закуп: сначала курируемые предметы плана героя (они не должны теряться —
  // раньше этот список затирался адаптацией), затем — ответы на теги их драфта.
  const curated = [];
  const curatedKeys = new Set();
  for (const [key, why] of (plan && plan.items && plan.items.situational) || []) {
    if (curatedKeys.has(key)) continue;
    if (['start', 'early', 'core'].some((g) => items[g].some((i) => i.key === key))) continue;
    curatedKeys.add(key);
    curated.push({ key, why, source: 'план героя', tags: [] });
  }

  const situational = new Map();
  const orderedTags = Object.entries(rules.rules)
    .filter(([tag]) => enemyTags.has(tag))
    .sort((a, b) => (b[1].severity || 1) - (a[1].severity || 1));
  for (const [tag, rule] of orderedTags) {
    for (const [key, why] of rule.items || []) {
      if (curatedKeys.has(key)) continue; // уже показан как предмет плана героя
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

  const ultKey = heroUltimateKey(h, abilities);
  const skillPlan = plan && plan.skills ? plan.skills : null;
  // Без курируемого плана показываем только изучаемые базовые способности: неизучаемые слоты
  // 7.41 (Stolen Spell, Devoured Ability, Souvenir Slot) и врождённые в порядок прокачки не годятся.
  // Ультимейт идёт отдельной строкой, поэтому в список базовых не попадает.
  const genericSkills = heroLearnableSkills(h, abilities)
    .filter((key) => key !== ultKey)
    .map((key) => [key, 'основная способность — качай по ситуации']);
  const skills = skillPlan || genericSkills;

  const arche = plan ? null : archetypeFor(h, archetypes);
  return {
    hero: h,
    plan,
    // Архетип по роли (data/kb/archetypes.json) — только когда курируемого плана нет.
    archetype: arche ? { name: arche.name, title: arche.title, why: arche.why } : null,
    items: {
      ...items,
      // Курируемый список героя + до 10 адаптивных ответов на теги их драфта; повторов по ключу нет.
      situational: [
        ...curated,
        ...[...situational.values()]
          .sort((a, b) => (b.severity || 1) - (a.severity || 1))
          .slice(0, 10),
      ],
    },
    skills,
    ult: ultKey,
    // Ульт уже описан в списке способностей (в курируемых планах у него свой комментарий) —
    // интерфейс не должен выводить его второй раз отдельной строкой.
    ultInSkills: Boolean(ultKey && skills.some(([key]) => key === ultKey)),
    lane: plan?.lane || null,
    spikes: plan?.spikes || [],
    // Без курируемого плана кривую и советы даёт архетип роли: иначе панель плана оставалась бы
    // без объяснения, зачем брать именно эти предметы.
    tips: plan?.tips || (arche ? arche.data.tips || [] : []),
    curve: plan?.curve || (arche ? arche.data.curve || null : null),
    difficulty: plan?.difficulty || null,
    curated: Boolean(plan),
  };
}

/** Пункты чеклиста, которые включаются тегами угроз. Порядок фиксирован — он же порядок в списке. */
const CHECKLIST_BY_TAG = [
  { tags: ['roam_ganker'], text: 'Вард на проходе к миду к 3-4 минуте (50 золота против одной смерти)' },
  { tags: ['invis'], text: 'Сентри/дасты в инвентаре до 10-й минуты' },
  { tags: ['silence', 'heavy_lockdown'], text: 'План на диспел: циклон/Manta или БКБ в первом крупном закупе' },
  { tags: ['burst_magical'], text: 'Рейндропы и маг. wand на линии важнее лишнего урона' },
  { tags: ['save'], text: 'Порядок файта: сначала сайленс/хекс на спасающего, потом бурст' },
];

/** Пункт про комбо-предупреждение — первое предложение совета верхнего комбо. */
const comboSentence = (advice) => `Запомни комбо-предупреждение: ${String(advice || '').split('.')[0]}`;

const timingChecklist = (data) => ((data && data.timings && data.timings.checklist) || []);

/** Чеклист на игру — из угроз, комбо и таймингов (data/kb/timings.json → checklist). */
export function buildChecklist({ threats, combos, data }) {
  const tags = new Set((threats || []).map((t) => t.tag));
  const list = [];
  for (const rule of CHECKLIST_BY_TAG) {
    if (rule.tags.some((t) => tags.has(t))) list.push(rule.text);
  }
  if (combos && combos.length) list.push(comboSentence(combos[0].advice));
  list.push(...timingChecklist(data));
  return list;
}

/**
 * Все пункты, которые чеклист может выдать хоть на каком-то драфте.
 * Интерфейс сверяет с этим множеством галочки из localStorage, чтобы не копить
 * ключи от старых драфтов и прошлых версий базы знаний.
 */
export function checklistUniverse(data) {
  const list = CHECKLIST_BY_TAG.map((rule) => rule.text);
  for (const combo of (data && data.rules && data.rules.combos) || []) list.push(comboSentence(combo.advice));
  list.push(...timingChecklist(data));
  return new Set(list);
}
