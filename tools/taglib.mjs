/**
 * Правила вывода тегов механик: чем подтверждается каждый тег — фразой из описания способности
 * или числом из источника. Модуль ничего не меняет, им пользуются `tools/suggest_tags.mjs`
 * (отчёт с доказательствами) и `tools/test_tags.mjs` (проверка, что каждая машинная подсказка
 * либо принята в data/kb/tags.json, либо осознанно отклонена в data/kb/tags_decisions.json).
 *
 * Зачем: разметка героев курируемая, но до сих пор её нельзя было перепроверить — тег ставился
 * руками, и никто не знал, откуда он взялся. Теперь у каждого тега есть правило с доказательством,
 * а у каждой машинной подсказки — решение с причиной.
 *
 * Достоверность (`precision`):
 *   - `high`   — фраза однозначна, такие подсказки обязаны иметь решение в tags_decisions.json;
 *   - `medium` — подсказка верна по смыслу, но требует взгляда человека (в решение её брать не нужно);
 *   - отсутствие правила — тег ставится только вручную (например, `single_target_lockdown`).
 *
 * Доказательство берётся из описания способности (`desc`) целиком фразой-предложением: заголовки
 * характеристик («DAMAGE REDUCTION:», «BARRIER AMOUNT:») — это обрывки без контекста, и раньше
 * именно они давали ложные теги (самоспасение героя принималось за спасение союзника).
 *
 * Что не считается доказательством:
 *   - способности, выдаваемые шардом/агханимом (`granted`): без покупки предмета их нет;
 *   - для «ключевых» тегов (тяжёлые механики из MANUAL_ONLY_MAIN) — под-способности и фасеты
 *     из `extra`: они есть не в каждой игре, а тег читается как постоянная механика героя;
 *   - способности из `DENY`: фразы формально подходят, но механика у героя не та — каждая
 *     строка таблицы объясняет, почему.
 */

const before = (words) => new RegExp(`\\b(?:${words})\\b[^.!?]{0,80}\\binvisib`, 'i');
const after = (words) => new RegExp(`\\binvisib[^.!?]{0,60}\\b(?:${words})`, 'i');

export const TEXT_RULES = {
  invis: {
    title: 'Невидимость',
    precision: 'high',
    note: 'нужен положительный смысл: «становится невидимым», а не «раскрывает невидимых»',
    patterns: [
      { re: before('become|becomes|becoming|became|fades?|fading|turns?|turning|goes|going|remains?|stays?|staying|is|are|be|moves?|moving|walks?|walking|travels?') },
      { re: /\b(?:grants?|granting|gains?|gain|provides?|providing)\b[^.!?]{0,50}\binvisib/i },
      { re: /\bin a cloud of (?:smoke|shadows?)\b/i },
    ],
    // «раскрывает невидимых» — это тег не про того героя: проверяем обе стороны фразы, запрет
    // уходить в невидимость (Overgrowth) и невидимость слуг вместо самого героя (волки Lycan).
    guards: [
      after('reveal\\w*|detect\\w*|true sight|vision|sight|sees?|seen'),
      /\b(?:reveal\w*|detect\w*|sees?|true sight|vision|sight)\b[^.!?]{0,60}\binvisib/i,
      /\b(?:prevent\w*|cannot|can not|unable)\b[^.!?]{0,50}\binvisib/i,
      /\b(?:wolves|wolf|bear|boar|hawk|familiars?|eidolons?|spiderlings?|treants?|skeletons?|archers?|units?|creeps?|minions?|servants?|summons?)\b[^.!?]{0,40}\b(?:gain|gains|gained|become|becomes|becoming|are|is|have|has)\b[^.!?]{0,30}\binvisib/i,
    ],
  },
  illusions: {
    title: 'Иллюзии / клоны',
    precision: 'high',
    note: 'нужно создание: «убивает иллюзии» и «иллюзии получают больше урона» — это не тег героя',
    patterns: [
      { re: /\b(?:creates?|creating|summons?|summoning|sends?|sending|calls?|calling|produces?|spawns?|spawning|generates?|forms?|makes?|assumes?|becomes?|turns? into)\b[^.!?]{0,40}\billusions?\b/i },
      { re: /\billusions?\b[^.!?]{0,25}\b(?:attack|deal|copy|mirror|are created|are summoned)\b/i, strong: false },
    ],
  },
  summons: {
    title: 'Саммоны и слуги',
    precision: 'high',
    note: '«summons» без существа рядом — не саммон (Lina «summons a column of flames»)',
    patterns: [
      { re: /\b(?:summons?|summoning|creates?|creating|spawns?|spawning|raises?|raising)\b[^.!?]{0,40}\b(?:spirits?|bears?|boars?|hawks?|wolves|wolf|eidolons?|treants?|familiars?|spiderlings?|zombies?|golems?|skeletons?|serpents?|creeps?|beasts?|dragons?|demons?|gargoyles?|bats?|soldiers?|warriors?|minions?|turret|tombstone|wards?)\b/i },
      { re: /\b(?:under (?:his|her|their|its|your) control|takes? control of|converts? (?:it|them|the unit) into)\b/i, strong: false },
    ],
  },
  silence: {
    title: 'Сайленс / мут',
    precision: 'high',
    note: 'сайленс должен накладываться на врага, а не упоминаться как условие',
    patterns: [{ re: /\bsilenc(?:e|es|ed|ing)\b/i }],
    guards: [/\b(?:while|when|if)\s+silenc/i, /\b(?:can be cast|may be cast|casts? (?:it|this|the ability))\b[^.!?]{0,30}\bsilenc/i],
  },
  hex_root: {
    title: 'Хекс и руты',
    precision: 'high',
    patterns: [
      { re: /\b(?:hex(?:ed|es)?|turns? .{0,30}into a (?:frog|chicken|pig|sheep)|transforms? .{0,30}into a (?:frog|chicken|pig|sheep))\b/i },
      { re: /\b(?:roots?|rooted|rooting|ensnares?|ensnared|entangled?|traps? .{0,20}in place|holds? .{0,15}in place)\b(?![^.!?]{0,25}\btrees?\b)/i },
    ],
  },
  evasion: {
    title: 'Уклонение',
    precision: 'high',
    note: '«chance to miss» и уклонение самого героя (для «промахов врагов» есть другие теги)',
    patterns: [{ re: /\b(?:evasion|evades?|evading|miss chance|chance to miss)\b/i }],
  },
  mana_burn: {
    title: 'Сжигание маны',
    precision: 'high',
    patterns: [{ re: /\b(?:burns? .{0,25}mana|mana burn|steals? .{0,25}mana|drains? .{0,25}mana|mana .{0,20}is burnt)\b/i }],
  },
  global: {
    title: 'Глобальное присутствие',
    precision: 'high',
    patterns: [
      { re: /\b(?:anywhere on the map|across the map|any point on the map|any location|entire map|to any point|globally|anywhere in the world|no matter where)\b/i },
    ],
  },
  magic_amp: {
    title: 'Усиление магического урона',
    precision: 'high',
    note: 'нужно именно магическое усиление: «amplify physical damage» — это тег armor_reduce',
    patterns: [
      { re: /\b(?:increases? .{0,40}(?:spell|magic) damage|magic damage amplification|amplif(?:y|ies|ied|ying) .{0,30}(?:spell|magic) damage|reduces? .{0,25}magic resistance|decreases? .{0,25}magic resistance)\b/i },
    ],
  },
  armor_reduce: {
    title: 'Снижение брони',
    precision: 'high',
    patterns: [
      { re: /\b(?:reduces? .{0,25}armor|armor (?:reduction|is reduced|loss)|decreases? .{0,25}armor|loses? .{0,15}armor|minus .{0,10}armor)\b/i },
    ],
    guards: [/\bincreas(?:es?|ing) .{0,25}armor\b/i, /\b(gains?|grants?|provides?|bonus) .{0,25}armor\b/i],
  },
  gap_close: {
    title: 'Сближение / мобильность',
    precision: 'high',
    patterns: [
      { re: /\b(?:blinks?|blinking|dashes?|dashing|leaps?|leaping|charges? (?:toward|at|to)|jumps? (?:to|forward|towards?)|teleports?)\b/i },
    ],
  },
  disables_passives: {
    title: 'Отключает пассивки',
    precision: 'high',
    patterns: [
      { re: /\b(?:disables? (?:their|the target'?s?) passives|break(?:s|ing)? the target|passives are disabled|disabling passives)\b/i },
    ],
  },
  heavy_lockdown: {
    title: 'Тяжёлый контроль',
    precision: 'medium',
    patterns: [
      { re: /\b(?:stun(?:s|ned|ning)?|knocks? .{0,20}into the air|knocked into the air|taunts?|taunted|feared|mesmeriz\w*|banishe?s?|banished)\b/i },
    ],
  },
  heavy_heal: {
    title: 'Много лечения / вампиризм',
    precision: 'medium',
    patterns: [
      { re: /\blifesteal\b/i },
      { re: /\b(?:heals?|healing|restores?|restoring)\b[^.!?]{0,40}\b(?:health|hp)\b/i },
      { re: /\bhealth regeneration\b(?![^.!?]{0,25}\b(?:reduced|decreased)\b)/i, strong: false },
    ],
  },
  save: {
    title: 'Спасение союзника',
    precision: 'medium',
    note: 'нужен союзник в предложении: самоспасение героя — это не саппорт-сейв',
    patterns: [
      { re: /\b(?:allied|ally|allies|friendly|your team|teammate|another hero)\b[^.!?]{0,60}\b(?:barrier|invulnerab\w*|cannot die|unkillable|damage reduction|reduces? .{0,20}damage)\b/i },
      { re: /\b(?:barrier|invulnerab\w*|cannot die|unkillable)\b[^.!?]{0,60}\b(?:allied|ally|allies|friendly|teammate)\b/i },
    ],
  },
  poke_lane: {
    title: 'Покер на линии',
    precision: 'medium',
    patterns: [
      { re: /\b(?:deals? damage|damages?) .{0,40}\b(?:in a (?:line|cone|radius|area)|to (?:all )?enemies in)\b/i },
      { re: /\bdamage over time\b/i, strong: false },
    ],
  },
  lane_sustain: {
    title: 'Выживание на линии',
    precision: 'medium',
    patterns: [
      { re: /\b(?:restores?|regenerates?|grants?)\b[^.!?]{0,30}\b(?:health|mana)\b[^.!?]{0,30}\b(?:to (?:an )?all(?:y|ies)|to (?:himself|herself|yourself))\b/i },
      { re: /\b(?:steals?|lifesteals?)\b[^.!?]{0,20}\bhealth\b/i },
    ],
  },
  tower_pressure: {
    title: 'Давление на башни',
    precision: 'medium',
    patterns: [
      { re: /\b(?:(?:deals?|does) damage to (?:enemy )?buildings?|damages? (?:enemy )?buildings?|bonus damage .{0,20}buildings?)\b/i },
    ],
  },
};

/** Числовые доказательства: тег подтверждается числами источника, а не фразой. */
export const NUM_RULES = {
  burst_magical: {
    title: 'Магический бурст',
    precision: 'high',
    note: 'урон одной способности по числам клиента',
    test: (hero, ability, num) => {
      if (ability.dmg_type !== 'Magical') return null;
      const dmg = num(ability, /^damage|damage$/i);
      if (!dmg || dmg < 300) return null;
      return `магический урон одной способностью до ${Math.round(dmg)}`;
    },
  },
  burst_physical: {
    title: 'Физический бурст / DPS',
    precision: 'high',
    test: (hero, ability, num) => {
      if (ability.dmg_type !== 'Physical') return null;
      const dmg = num(ability, /^damage|damage$/i);
      if (!dmg || dmg < 250) return null;
      return `физический урон одной способностью до ${Math.round(dmg)}`;
    },
  },
  waveclear: {
    title: 'Чистка волн',
    precision: 'medium',
    note: 'урон по области: чем больше радиус, тем полезнее против волны',
    test: (hero, ability, num) => {
      const dmg = num(ability, /^damage|damage$/i);
      const radius = num(ability, /^radius|radius$/i);
      if (!dmg || !radius || dmg < 80 || radius < 250) return null;
      return `урон ${Math.round(dmg)} по области радиусом ${Math.round(radius)}`;
    },
  },
  teamfight_ultimate: {
    title: 'Файтовый ультимейт',
    precision: 'medium',
    note: 'ультимейт с эффектом по большой площади: один ульт решает файт',
    ultimateOnly: true,
    test: (hero, ability, num) => {
      const radius = num(ability, /^radius|radius$/i);
      if (!radius || radius < 300) return null;
      const dmg = num(ability, /^damage|damage$/i);
      if (!dmg && !/\b(?:stun|taunt|fear|mesmeriz|banish|knock)/i.test(ability.desc || '')) return null;
      const effect = dmg ? `урон до ${Math.round(dmg)}` : 'контроль';
      return `ультимейт с эффектом по площади радиусом ${Math.round(radius)} (${effect})`;
    },
  },
  late_scaler: {
    title: 'Играет от поздней игры',
    precision: 'medium',
    heroTest: (hero) => {
      const s = hero.stats || {};
      const growth = (s.str_gain || 0) + (s.agi_gain || 0) + (s.int_gain || 0);
      const carry = (hero.roles || []).includes('Carry');
      if (!carry) return null;
      if (growth >= 7.5) return `керри с приростом статов ${growth.toFixed(1)} за уровень`;
      return null;
    },
  },
};

/** Теги, которые ставит только человек: машинного правила нет. */
export const MANUAL_ONLY = ['single_target_lockdown', 'passives_core', 'roam_ganker'];

/** Тяжёлые механики: подтверждаются только основными слотами, а не фасетами и под-способностями. */
export const MAIN_SLOT_ONLY = [
  'invis', 'silence', 'hex_root', 'heavy_lockdown', 'burst_magical', 'burst_physical',
  'save', 'teamfight_ultimate', 'late_scaler', 'disables_passives',
];

/**
 * Ложные срабатывания фраз: ключ способности → теги, которые у неё НЕ берём, и причина.
 * Правила читают текст, а текст бывает про соседнюю механику — здесь это зафиксировано явно,
 * чтобы подсказчик не возвращал их снова после каждой правки шаблонов.
 */
export const DENY = {
  enchantress_impetus: { illusions: 'наносит двойной урон иллюзиям, а не создаёт их' },
  medusa_mana_shield: { illusions: 'говорит о том, как иллюзии слабее, а не что Медуза их создаёт' },
  ringmaster_spotlight: { illusions: 'заставляет иллюзии исчезать', evasion: 'промахи врагов по союзникам, а не уклонение героя' },
  abaddon_aphotic_shield: { summons: '«энергии», а не боевая единица' },
  dawnbreaker_solar_guardian: { summons: '«350 units» — это расстояние, а не юнит' },
  death_prophet_spirit_siphon: { summons: 'связь с врагом, а не призыв' },
  faceless_void_chronosphere: { summons: '«units» в описании сферы — не призыв' },
  leshrac_lightning_storm: { summons: 'гроза — это урон, а не боевая единица' },
  night_stalker_void: { summons: '«void» — это дебафф, а не юнит' },
  sandking_sand_storm: { summons: 'песчаная буря — это урон и невидимость, а не юнит' },
  storm_spirit_static_remnant: { summons: 'остаточный образ — это урон, а не юнит' },
  tidehunter_gush: { summons: 'поток воды — это урон и замедление, а не юнит' },
  mars_arena_of_blood: { summons: 'воины арены не ходят и не толкают линии' },
  juggernaut_healing_ward: { summons: 'вард лечит, а не толкает линию и башни' },
  wisp_spirits: { summons: 'духи — это урон по площади, а не боевые единицы' },
  phoenix_fire_spirits: { summons: 'огненные духи — это дебафф, а не боевые единицы' },
  phantom_lancer_spirit_lance: { summons: 'создаёт иллюзию — это тег illusions' },
  monkey_king_wukongs_command: { summons: 'солдаты не бьют строения' },
  ancient_apparition_ice_blast_release: { silence: '«можно кастовать под сайленсом» — это про него, а не про врагов' },
  ringmaster_the_box: { silence: 'мьют и сайленс получает спасённый союзник' },
  brewmaster_drunken_brawler: { evasion: 'уклонение получает призванный дух, а не сам герой' },
  largo_amphibian_rhapsody: { evasion: '«misses a beat» — это про музыку, а не про промахи' },
  beastmaster_summon_raptor: { hex_root: 'рут только у фасетных ястребов' },
  life_stealer_infest: { burst_magical: 'урон срабатывает только при выходе из носителя' },
  leshrac_pulse_nova: { mana_burn: 'жжёт ману самого Leshrac, а не врага' },
  meepo_divided_we_stand: { mana_burn: 'речь о распределении бонусов предметов, а не о сжигании маны' },
  chen_holy_persuasion: { global: 'глобальная цель нужна, чтобы распустить своего крипа' },
  beastmaster_wild_axes: { magic_amp: 'усиливает весь свой урон, а не магический' },
  slardar_amplify_damage: { magic_amp: 'усиливает физический урон — это тег armor_reduce' },
  clinkz_infernal_shred: { armor_reduce: 'прямо сказано «does not reduce their armor»' },
  disruptor_glimpse: { illusions: 'убивает иллюзии, а не создаёт их', gap_close: 'возвращает врага назад, а не прыгает сам' },
  abyssal_underlord_dark_portal: { gap_close: 'портал для команды, а не рывок героя' },
  abyssal_underlord_raid_boss: { gap_close: 'мобильность союзников после телепорта, а не героя' },
  naga_siren_ensnare: { gap_close: '«blinking» в описании — запрет блинка у цели, а не мобильность героя' },
  zuus_arc_lightning: { gap_close: '«leaps through» относится к молнии, а не к Zeus' },
  sniper_shrapnel: { gap_close: '«launch a ball» — это снаряд, а не рывок' },
  treant_overgrowth: { summons: 'лозы держат врагов, но не воюют за тебя', gap_close: 'запрещает движение врагам, а не даёт мобильность герою' },
  vengefulspirit_nether_swap: { burst_magical: 'урон обмена — условие фасета, а не бурст' },
  dazzle_nothl_projection: { hex_root: 'хекс только под фасетным ультимейтом' },
  enchantress_little_friends: { hex_root: 'рут только у фасетной способности' },
  tinker_warp_grenade: { hex_root: 'рут только у способности за шард (её не берём и по правилу granted)' },
  tinker_keen_teleport: { gap_close: 'телепорт к своему строению — это ротация, а не рывок в бою' },
  naga_siren_reel_in: { hex_root: 'под-способность: рут даёт Ensnare, он в разметке отдельно' },
  hoodwink_decoy: { illusions: 'иллюзия-обманка фасета, а не боевой клон', invis: 'невидимость только у фасета Decoy' },
  kez_ravens_veil: { invis: 'невидимость только у фасета Raven’s Veil' },
};

/** Максимальное число характеристики способности по её строкам. */
export function maxOf(ability, re = /.*/) {
  let best = null;
  for (const row of ability.attrib || []) {
    const header = String(row.header || '');
    if (!re.test(header)) continue;
    const values = (Array.isArray(row.value) ? row.value : [row.value])
      .map((v) => Number(String(v).replace(/[^\d.]/g, '')))
      .filter((v) => Number.isFinite(v));
    for (const v of values) if (best === null || v > best) best = v;
  }
  return best;
}

/** Текст описания способности, разбитый на предложения: доказательство должно быть фразой. */
export function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Предложения по одному герою: { tag: [{ kind, quote, ability, precision, strength }] }.
 * Доказательство — предложение описания целиком, чтобы его можно было прочитать и проверить.
 */
export function suggestTags(hero, abilities) {
  const slots = hero.slots || [];
  const keys = [...slots.map((s) => s.key), ...(hero.extra || [])];
  const out = {};
  const add = (tag, ev) => {
    if (!out[tag]) out[tag] = [];
    out[tag].push(ev);
  };
  for (const key of keys) {
    const a = abilities[key];
    if (!a) continue;
    // Способность за шард/агханим доступна только с предметом: для постоянной механики героя её
    // не берём (в подсказке остаётся пометка, чтобы это не выглядело как пропуск).
    if (a.granted) continue;
    const slot = slots.find((s) => s.key === key);
    const where = { key, dname: a.dname || key, ultimate: Boolean(slot && slot.i === 5), sub: !slot };
    for (const [tag, rule] of Object.entries(TEXT_RULES)) {
      if (!rule.patterns.length) continue;
      if ((rule.guards || []).some((g) => g.test(a.desc || ''))) continue;
      if ((DENY[key] || {})[tag]) continue;
      if (!slot && MAIN_SLOT_ONLY.includes(tag)) continue;
      for (const sentence of sentences(a.desc)) {
        const p = rule.patterns.find((x) => x.re.test(sentence));
        if (!p) continue;
        add(tag, { ...where, kind: 'phrase', quote: sentence, strength: p.strong === false ? 'weak' : 'strong' });
        break;
      }
    }
    for (const [tag, rule] of Object.entries(NUM_RULES)) {
      if (!rule.test) continue;
      if (rule.ultimateOnly && !where.ultimate) continue;
      if ((DENY[key] || {})[tag]) continue;
      if (!slot && MAIN_SLOT_ONLY.includes(tag)) continue;
      const why = rule.test(hero, a, (ab, re) => maxOf(ab, re));
      if (why) add(tag, { ...where, kind: 'number', quote: why, strength: 'strong' });
    }
  }
  for (const [tag, rule] of Object.entries(NUM_RULES)) {
    if (!rule.heroTest) continue;
    const why = rule.heroTest(hero);
    if (why) add(tag, { key: null, dname: hero.localized_name, kind: 'hero', quote: why, strength: 'strong' });
  }
  return out;
}
