/**
 * app.js — интерфейс драфт-помощника.
 * Данные: data/*.json (собираются tools/build_data.mjs из игровых констант 7.41),
 * знания: data/kb/*.json (планы героев, теги, правила, тайминги).
 */
import {
  laneReport, threatsFor, combosFor, counterPicks, buildPlan, buildChecklist, checklistUniverse,
  heroDamage, heroHp, heroMana, heroArmor, isServiceAbility, isSubAbility, archetypeFor,
  ROLES, ROLE_TITLES,
} from './analysis.js';
import {
  recognizeScreenshot, recognizeCells, manualCells, clampRegion, clampGridSize, MAX_GRID,
} from './recognize.js';

const DATA = {
  heroes: {}, abilities: {}, items: {}, icons: {}, meta: {}, archetypes: null,
  tagsKb: { vocabulary: {}, heroes: {} }, rules: { rules: {}, combos: [] },
  timings: { events: [], notes: [] }, plans: {},
  templates: null, // подписи героев для распознавания — грузятся при первом открытии вкладки
  patchnotes: null, // патчноуты — при первом открытии вкладки «Патч» (365 КБ)
};

/** Сколько карточек предметов рисуем сразу: остальное подгружается по скроллу или кнопкой. */
const ITEM_PAGE = 60;
/** Самая длинная сторона кадра для распознавания: больше — только медленнее (подписи 32×32). */
const SHOT_MAX_SIDE = 2560;

const state = {
  tab: 'draft',
  me: null,
  myRole: null,
  enemies: [null, null, null, null, null],
  enemyMid: null,
  allies: [null, null, null, null],
  selectedHero: null,
  heroSearch: '',
  attrFilter: null,
  roleFilter: null,
  onlyMid: false,
  itemSearch: '',
  itemsShown: ITEM_PAGE,
  patch: null,
  timer: { running: false, start: 0, offset: 0 },
  checks: {},
  shot: {
    image: null,      // { width, height, data } — пиксели скриншота (RGBA)
    name: '',
    result: null,     // { grid, cells, confidence } — итог распознавания
    busy: false,
    error: '',
    cols: 0,          // поля ручной нарезки
    rows: 0,
    region: null,     // { x, y, w, h } — область, которая режется вручную
    regionEdited: false, // пользователь сам задал область (её не перетирает автопоиск)
    manual: false,    // последний результат получен ручной нарезкой
    picks: {},        // правки распознавания: индекс ячейки → слаг героя или null («не определён»)
    notice: '',       // итог последнего заполнения драфта
    scaledFrom: null, // исходный размер кадра, если он был уменьшен перед распознаванием
  },
};

const ROLE_RU = {
  Carry: 'Керри', Support: 'Саппорт', Nuker: 'Нюкер', Disabler: 'Дизейблер',
  Initiator: 'Инициатор', Durable: 'Танк', Escape: 'Эскейп', Pusher: 'Пушер',
};
const ATTR_RU = { str: 'Сила', agi: 'Ловкость', int: 'Интеллект', all: 'Универсал' };
const KIND_RU = { rune: 'Руны', objective: 'Объективы', rhythm: 'Ритм карты', neutral: 'Нейтралки' };

const $ = (sel, root = document) => root.querySelector(sel);
/**
 * Известный приложению герой: только собственные ключи DATA.heroes. Проверка через `DATA.heroes[s]`
 * пропускала унаследованные имена ('constructor', 'toString', '__proto__'), и испорченный
 * localStorage ронял интерфейс при загрузке.
 */
const isHero = (s) => typeof s === 'string' && Object.prototype.hasOwnProperty.call(DATA.heroes, s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byName = (a, b) => a.localeCompare(b, 'ru');

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function parseAt(str) {
  const [m, s] = String(str).split(':').map(Number);
  return m * 60 + (s || 0);
}

/**
 * Порядок версий патча: серия (7.41) раньше своих буквенных версий (7.41a … 7.41f),
 * серии сравниваются как числа (7.9 < 7.10), а не как строки.
 */
function parsePatch(v) {
  const m = /^(\d+)\.(\d+)([a-z]*)$/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2]), m[3]] : null;
}
function comparePatch(a, b) {
  const pa = parsePatch(a);
  const pb = parsePatch(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2].length - pb[2].length || pa[2].localeCompare(pb[2]);
}
/** Серия патча (7.41) — из meta; буквенную версию (7.41f) в неё не подмешиваем. */
function patchSeries() {
  return String(DATA.meta.patchSeries || DATA.meta.latestPatch || '');
}
/**
 * Последняя версия текущей серии в патчноутах: 7.41 → 7.41f (или сама серия, если букв ещё нет).
 * Обычно ответ есть в meta.json; разбор патчноутов — запасной путь, а самих патчноутов до
 * открытия вкладки «Патч» в памяти нет, поэтому список версий может быть пустым.
 */
function latestPatchVersion() {
  const series = patchSeries();
  if (DATA.meta.latestVersion) return String(DATA.meta.latestVersion);
  const own = Object.keys(DATA.patchnotes || {}).filter((k) => {
    const p = parsePatch(k);
    return p && `${p[0]}.${p[1]}` === series;
  });
  return own.sort(comparePatch).pop() || series;
}

/* ------------------------------ загрузка ------------------------------ */

async function loadData() {
  const get = async (p) => {
    const res = await fetch(p);
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
    return res.json();
  };
  // Патчноутов (365 КБ) в стартовом наборе нет: в шапке, карточке героя и подписях нужны только
  // серия и её последняя версия — они есть в meta.json, — а сами изменения читают на вкладке «Патч».
  const [heroes, abilities, items, meta, icons, kbIndex, tagsKb, rules, timings] = await Promise.all([
    get('data/heroes.json'), get('data/abilities.json'), get('data/items.json'),
    get('data/meta.json'), get('data/icons.json'),
    get('data/kb_index.json'), get('data/kb/tags.json'), get('data/kb/rules.json'), get('data/kb/timings.json'),
  ]);
  Object.assign(DATA, { heroes, abilities, items, meta, icons, tagsKb, rules, timings });
  for (const f of kbIndex.files) {
    if (f === 'archetypes.json') DATA.archetypes = await get(`data/kb/${f}`);
    else if (f.startsWith('plans')) Object.assign(DATA.plans, await get(`data/kb/${f}`));
  }
  state.patch = latestPatchVersion() || null;
}

/**
 * Патчноуты грузятся при первом открытии вкладки «Патч» и кэшируются в памяти. Неудачная попытка
 * не кэшируется: повторное открытие вкладки запросит файл снова (как у подписей распознавания).
 */
let patchnotesLoading = null;
function ensurePatchnotes() {
  if (DATA.patchnotes) return Promise.resolve(DATA.patchnotes);
  if (!patchnotesLoading) {
    patchnotesLoading = (async () => {
      const res = await fetch('data/patchnotes.json');
      if (!res.ok) throw new Error(`data/patchnotes.json: HTTP ${res.status}`);
      const json = await res.json();
      if (!json || typeof json !== 'object' || !Object.keys(json).length) throw new Error('data/patchnotes.json: пустой файл');
      DATA.patchnotes = json;
      return json;
    })().finally(() => { patchnotesLoading = null; });
  }
  return patchnotesLoading;
}

/** Пока патчноуты едут, вкладка показывает заглушку; ошибка видна с объяснением, а не «пусто». */
function renderPatchTab() {
  const view = $('#view');
  view.innerHTML = `<div class="panel"><h2>Патчноуты</h2><p class="small muted">Загружаю изменения патчей…</p></div>`;
  ensurePatchnotes().then(() => {
    if (state.tab === 'patch') render();
  }).catch((err) => {
    if (state.tab !== 'patch') return;
    view.innerHTML = `<div class="panel"><h2>Патчноуты не загрузились</h2>
      <p class="small warn">${esc(err && err.message)}</p>
      <p class="small muted">Обнови страницу или открой вкладку ещё раз — запрос повторится.</p></div>`;
  });
}

/* ------------------------------ распознавание скриншота ------------------------------ */

/**
 * Подписи героев для распознавания: грузятся один раз и кэшируются в памяти. Оставляем только
 * героев из данных приложения — распознавание не может вернуть неизвестный слаг. Неудачная
 * загрузка не кэшируется: следующая попытка запросит файл снова.
 */
let templatesLoading = null;
function ensureTemplates() {
  if (DATA.templates) return Promise.resolve(DATA.templates);
  if (!templatesLoading) {
    templatesLoading = (async () => {
      const res = await fetch('data/templates.json');
      if (!res.ok) throw new Error(`data/templates.json: HTTP ${res.status}`);
      const json = await res.json();
      const raw = json && typeof json.heroes === 'object' && json.heroes ? json.heroes : null;
      if (!raw) throw new Error('data/templates.json: нет раздела heroes с подписями');
      const known = {};
      for (const [slug, sigs] of Object.entries(raw)) if (isHero(slug) && Array.isArray(sigs) && sigs.length) known[slug] = sigs;
      if (!Object.keys(known).length) throw new Error('data/templates.json: нет подписей ни для одного героя из данных');
      DATA.templates = known;
      return known;
    })().finally(() => { templatesLoading = null; });
  }
  return templatesLoading;
}

/** Уменьшенная копия кадра для предпросмотра: распознавание работает по полному изображению. */
function shotPreviewSize(image, maxW = 900) {
  const k = Math.min(1, maxW / image.width);
  return { w: Math.max(1, Math.round(image.width * k)), h: Math.max(1, Math.round(image.height * k)), k };
}

/**
 * Ячейки ручной нарезки: область и число колонок/строк берём из состояния, а по умолчанию —
 * из найденной автоматически рамки, чтобы правку можно было начать с готового результата.
 * Рамка обрезается по кадру, колонки и строки — по MAX_GRID (см. recognize.js → manualCells).
 */
function shotManualCells() {
  const img = state.shot.image;
  if (!img) return [];
  return manualCells(img, state.shot.region || { x: 0, y: 0, w: img.width, h: img.height }, state.shot.cols, state.shot.rows);
}

/** Распознавание кадра и подготовка состояния: автопоиск сетки либо ручная нарезка. */
function shotRecognize({ manual = false } = {}) {
  const shot = state.shot;
  if (!shot.image || !DATA.templates) return;
  if (manual) {
    const cells = shotManualCells();
    const results = recognizeCells(shot.image, cells, DATA.templates, { topK: 5 });
    shot.result = { grid: null, cells: results, confidence: null };
    shot.manual = true;
  } else {
    shot.result = recognizeScreenshot(shot.image, DATA.templates, { topK: 5 });
    shot.manual = false;
    const cells = shot.result.cells;
    if (cells && cells.length && shot.result.grid && !shot.regionEdited) {
      const xs = cells.map((c) => c.rect.x);
      const ys = cells.map((c) => c.rect.y);
      const xe = cells.map((c) => c.rect.x + c.rect.w);
      const ye = cells.map((c) => c.rect.y + c.rect.h);
      // Сдвиг фазы сетки может вынести крайнюю ячейку за край кадра — поля области показывают
      // уже обрезанную по кадру рамку, с которой ручная нарезка и начнётся.
      shot.region = clampRegion({
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xe) - Math.min(...xs), h: Math.max(...ye) - Math.min(...ys),
      }, shot.image.width, shot.image.height);
      shot.cols = clampGridSize(shot.result.grid.cols, 1);
      shot.rows = clampGridSize(shot.result.grid.rows, 1);
    }
  }
  shot.picks = {};
  shot.notice = '';
}

/**
 * Запуск распознавания с перерисовкой «идёт распознавание…» (тяжёлый проход — вне текущего кадра).
 * Каждый запуск получает номер: результат устаревшего запуска (кадр сменили или сбросили, пока
 * шла загрузка шаблонов) отбрасывается и не перетирает состояние нового.
 */
let shotRunSeq = 0;
function shotRun(options = {}) {
  const shot = state.shot;
  if (!shot.image) return;
  const runId = ++shotRunSeq;
  const image = shot.image;
  shot.busy = true;
  shot.error = '';
  render();
  setTimeout(() => {
    ensureTemplates()
      .then(() => {
        if (runId !== shotRunSeq || state.shot.image !== image) return;
        shotRecognize(options);
      })
      .catch((err) => {
        if (runId !== shotRunSeq) return;
        state.shot.error = `Распознавание не удалось: ${err.message}`;
      })
      .finally(() => {
        if (runId !== shotRunSeq) return;
        state.shot.busy = false;
        render();
      });
  }, 30);
}

/** Отменяет ожидающие запуски распознавания (сброс кадра). */
function shotCancelRuns() { shotRunSeq++; }

/**
 * Итоговый список ячеек: правки пользователя поверх распознанного.
 * status: 'ok' — герой распознан уверенно; 'weak' — слабое совпадение (героя не подставляем,
 * кандидаты — подсказки); 'empty' — пустая ячейка; 'manual' — герой выбран вручную;
 * 'cleared' — пользователь сам отметил ячейку как «не определён».
 * В slug попадает только известный приложению герой — иначе null.
 */
function shotHeroes() {
  const shot = state.shot;
  const cells = shot.result && Array.isArray(shot.result.cells) ? shot.result.cells : [];
  return cells.map((cell, i) => {
    const candidates = (Array.isArray(cell.candidates) ? cell.candidates : []).filter((c) => c && isHero(c.slug));
    const auto = cell.status === 'ok' && isHero(cell.slug) ? cell.slug : null;
    const edited = Object.prototype.hasOwnProperty.call(shot.picks, i);
    const picked = edited && isHero(shot.picks[i]) ? shot.picks[i] : null;
    const slug = edited ? picked : auto;
    let status = cell.empty ? 'empty' : auto ? 'ok' : 'weak';
    if (edited) status = picked ? 'manual' : 'cleared';
    return {
      index: i,
      rect: cell.rect,
      slug,
      status,
      score: candidates.length ? candidates[0].score : null,
      margin: typeof cell.margin === 'number' ? cell.margin : null,
      candidates,
      edited,
    };
  });
}

/**
 * Заполнение драфта по порядку ячеек: свободные слоты группы заполняются сверху вниз.
 * Берутся только уверенно распознанные или выбранные вручную герои; герой, который уже стоит
 * в драфте (у себя, у противников или у союзников) или повторяется на скриншоте, пропускается.
 */
function shotFill(group) {
  const slots = group === 'enemies' ? state.enemies : state.allies;
  const taken = new Set([state.me, ...state.enemies, ...state.allies].filter(Boolean));
  const queue = [];
  let duplicates = 0;
  for (const row of shotHeroes()) {
    if (!row.slug) continue;
    if (taken.has(row.slug)) { duplicates++; continue; }
    taken.add(row.slug);
    queue.push(row.slug);
  }
  let added = 0;
  for (let i = 0; i < slots.length && added < queue.length; i++) {
    if (slots[i]) continue;
    slots[i] = queue[added++];
  }
  const noRoom = queue.length - added;
  // Мид противника здесь не назначаем: пока игрок не выбрал его в селекте (или не передал
  // в hash), его определяет guessEnemyMid по текущему составу врагов.
  const parts = [`Добавлено в ${group === 'enemies' ? 'противники' : 'союзники'}: ${added}`];
  if (duplicates) parts.push(`уже в драфте или повтор: ${duplicates}`);
  if (noRoom) parts.push(`не хватило свободных слотов: ${noRoom}`);
  state.shot.notice = parts.join(' · ');
  saveDraft();
  render();
}

/* ------------------------------ helpers ------------------------------ */

function heroBySlug(slug) {
  return isHero(slug) ? DATA.heroes[slug] : null;
}
/** Иконка героя или буквенный аватар цвета атрибута (для героев без иконки в источнике). */
function iconHTML(slug, cls = '') {
  const h = heroBySlug(slug);
  if (!h) return '';
  const file = Object.prototype.hasOwnProperty.call(DATA.icons, slug) ? DATA.icons[slug] : null;
  if (typeof file === 'string' && file) return `<img class="${esc(cls)}" src="data/icons/${esc(file)}" alt="${esc(h.localized_name)}" loading="lazy">`;
  const color = { str: '#f0703a', agi: '#6ecf5a', int: '#5aa9e6', all: '#c9a3f5' }[h.primary_attr] || '#8d9aad';
  const letters = String(h.localized_name || slug).split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  return `<div class="ph ${esc(cls)}" style="background:${color}" title="${esc(h.localized_name)} (нет иконки)">${esc(letters)}</div>`;
}
function heroMini(slug, removable = true, slotIdx = null, group = 'enemies') {
  const h = heroBySlug(slug);
  if (!h) return '';
  return `<div class="hero-mini">
    ${iconHTML(slug)}
    <div style="min-width:0">
      <div class="nm">${esc(h.localized_name)}</div>
      <div class="rl">${esc(ATTR_RU[h.primary_attr] || '')} · ${esc((h.roles || []).map((r) => ROLE_RU[r] || r).slice(0, 2).join(', '))}</div>
    </div>
    ${removable ? `<button data-remove="${group}:${slotIdx}" aria-label="Убрать героя ${esc(h.localized_name)}" title="Убрать">✕</button>` : ''}
  </div>`;
}
function itemChip(key) {
  const it = DATA.items[key];
  const name = it ? it.dname : key;
  const cost = it && it.cost ? `<span class="cost">${it.cost}</span>` : '';
  return `<span class="item-chip" data-item="${esc(key)}" title="Показать предмет">${esc(name)}${cost}</span>`;
}
function itemRows(list) {
  if (!list.length) return '<p class="muted small">—</p>';
  return list.map(({ key, why, source, tags }) => {
    const it = DATA.items[key];
    // Первый тег адаптивного предмета уже назван в source («под их «Невидимость»») —
    // выводим только дополнительные теги, иначе название печатается дважды.
    const extraTags = (tags || []).filter((t) => {
      const title = DATA.tagsKb.vocabulary[t]?.title || t;
      return !String(source || '').includes(`«${title}»`);
    });
    return `<div class="item-row">
      <div style="flex:0 0 auto">${itemChip(key)}</div>
      <div>
        <div class="small">${esc(why || '')}</div>
        <div class="tiny muted">${esc(source || '')}${extraTags.length ? ` · ${extraTags.map((t) => esc(DATA.tagsKb.vocabulary[t]?.title || t)).join(', ')}` : ''}${it ? ` · ${it.cost} золота` : ''}</div>
      </div>
    </div>`;
  }).join('');
}
function abilityCard(key) {
  const a = DATA.abilities[key];
  // Служебные слоты (Invoked Spell, Stolen Spell, Devoured Ability, Souvenir Slot) и пустые
  // технические записи источника — не способности героя.
  if (!a || isServiceAbility(key, a)) return '';
  const meta = [
    a.dmg_type ? `тип урона: ${esc(a.dmg_type)}` : null,
    a.mc !== null && a.mc !== undefined ? `мана: ${esc(Array.isArray(a.mc) ? a.mc.join(' / ') : a.mc)}` : null,
    a.cd !== null && a.cd !== undefined ? `КД: ${esc(Array.isArray(a.cd) ? a.cd.join(' / ') : a.cd)}` : null,
    a.bkbpierce === 'Yes' ? 'пробивает BKB' : null,
    a.dispellable === 'Yes' ? 'снимается диспелом' : null,
  ].filter(Boolean).join(' · ');
  const attrib = (a.attrib || []).filter((x) => x.header).slice(0, 8)
    .map((x) => `<div><i>${esc(x.header)}</i> ${esc(Array.isArray(x.value) ? x.value.join(' / ') : x.value)}</div>`).join('');
  // Врождённые способности 7.41 и способности, выдаваемые предметом, очками не качают: в списке
  // и в карточке это должно быть видно, иначе они читаются как обычные слоты прокачки.
  const kind = a.granted === 'shard' ? '<span class="badge">выдаёт шард</span>'
    : a.granted === 'scepter' ? '<span class="badge">выдаёт агханим</span>'
      : a.innate && !Number.isFinite(a.firstLevel) ? '<span class="badge">врождённая</span>'
        : Number.isFinite(a.firstLevel) ? `<span class="badge">с ${esc(a.firstLevel)} уровня героя</span>` : '';
  return `<div class="ability">
    <div class="nm">${esc(a.dname || key)} ${kind}</div>
    <div class="meta">${meta}</div>
    ${a.desc ? `<div class="desc">${esc(a.desc)}</div>` : ''}
    ${attrib ? `<div class="attrib">${attrib}</div>` : ''}
  </div>`;
}
function tagsOf(slug) { return (DATA.tagsKb.heroes || {})[slug] || []; }

/* ------------------------------ вкладка «Драфт» ------------------------------ */

function renderDraft() {
  const me = state.me;
  const myRole = state.myRole;
  const enemies = state.enemies.filter(Boolean);
  const allies = state.allies.filter(Boolean);
  const ctx = { tagsKb: DATA.tagsKb, rules: DATA.rules, plans: DATA.plans };
  const enemyMid = state.enemyMid && state.enemies.includes(state.enemyMid) ? state.enemyMid : guessEnemyMid(enemies);

  const isMidRole = !myRole || myRole === 'mid';
  const lane = me && enemyMid && isMidRole ? laneReport(DATA.heroes[me], DATA.heroes[enemyMid], ctx) : null;
  const threats = enemies.length ? threatsFor(enemies, DATA) : [];
  const combos = enemies.length ? combosFor(enemies, DATA) : [];
  const picks = enemies.length ? counterPicks({
    enemies, enemyMid, data: DATA, limit: 6,
    exclude: [state.me, ...state.allies.filter(Boolean), ...enemies],
  }) : [];
  const plan = me ? buildPlan({ heroSlug: me, enemySlugs: enemies, data: DATA, role: myRole }) : null;
  const checklist = buildChecklist({ threats, combos, data: DATA });

  const slot = (group, arr, i, label) => {
    const slug = arr[i];
    return slug
      ? heroMini(slug, true, i, group)
      : `<button class="slot-empty" data-pick="${group}:${i}" aria-label="${esc(label)} — выбрать героя"><span>${esc(label)}</span><span aria-hidden="true">+</span></button>`;
  };

  return `
  <div class="grid cols-2">
    <div class="stack">
      <div class="panel">
        <h2>Мой герой <span class="muted tiny">· твоя роль: ${esc(myRole ? (ROLE_TITLES[myRole] || myRole) : 'Авто')}</span></h2>
        ${me ? heroMini(me, false) : `<button class="slot-empty" data-pick="me:0" aria-label="Выбрать героя"><span>Выбрать героя — любого, на любую роль</span><span aria-hidden="true">+</span></button>`}
        <div style="margin-top:10px">
          <div class="tiny muted" style="margin-bottom:6px">Я играю на:</div>
          <div class="chips" role="group" aria-label="Выбор роли">
            <button class="chip ${!myRole ? 'active' : ''}" data-rolepick="" aria-pressed="${String(!myRole)}" title="Авто — роль по герою">Авто</button>
            ${ROLES.map((r) => `<button class="chip ${myRole === r ? 'active' : ''}" data-rolepick="${esc(r)}" aria-pressed="${String(myRole === r)}">${esc(ROLE_TITLES[r])}</button>`).join('')}
          </div>
          <div class="tiny muted" style="margin-top:6px">${myRole ? `Билд и советы под роль «${esc(ROLE_TITLES[myRole])}» — любой из 127 героев адаптируется под неё.` : 'Авто берёт роль героя из базы. Выбери роль — получишь закуп керри/саппорта/роамера на любом герое.'}</div>
        </div>
        ${me ? `<div class="row" style="margin-top:10px">
          <button class="btn sm ghost" data-pick="me:0">Сменить героя</button>
          <button class="btn sm ghost" data-action="clear-me">Очистить</button>
        </div>` : ''}
      </div>

      <div class="panel">
        <h2>Моя команда <span class="muted tiny">${(me ? 1 : 0) + allies.length}/5</span> <span class="muted tiny">· твои союзники</span></h2>
        <div class="stack">
          ${state.allies.map((s, i) => slot('allies', state.allies, i, `Союзник ${i + 1}`)).join('')}
        </div>
        <p class="tiny muted" style="margin-top:8px">Введи всех 4 союзников: они исключаются из пикера и рекомендаций по пикам, а полный состав 5×5 уходит в ссылку для шаринга и в план текстом. Ситуативные предметы считаются от драфта врага.</p>
      </div>

      <div class="panel">
        <h2>Вражеский драфт <span class="muted tiny">${enemies.length}/5</span></h2>
        <div class="stack">
          ${state.enemies.map((s, i) => slot('enemies', state.enemies, i, `Враг ${i + 1}`)).join('')}
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn sm ghost" data-shot="open-shot">Заполнить по скриншоту</button>
        </div>
        ${enemies.length ? `<div class="row small" style="margin-top:10px">
          <span class="muted">Их мид:</span>
          <select class="search" data-enemy-mid style="padding:6px 8px">
            ${enemies.map((s) => `<option value="${esc(s)}" ${s === enemyMid ? 'selected' : ''}>${esc(DATA.heroes[s]?.localized_name || s)}</option>`).join('')}
          </select>
        </div>` : ''}
      </div>

      <div class="panel">
        <h2>Действия</h2>
        <div class="row">
          <button class="btn" data-action="copy">Скопировать план текстом</button>
          <button class="btn ghost" data-action="share">Поделиться ссылкой</button>
          <button class="btn ghost" data-action="random" title="Случайный драфт для теста — с кайфом">🎲 Рандом</button>
          <button class="btn ghost" data-action="reset">Сбросить драфт</button>
        </div>
        <p class="tiny muted" style="margin-top:8px">Ссылка на драфт (включая роль) — в адресной строке (hash), кидай её тиммейтам — откроют твой пик 1-в-1.</p>
      </div>
    </div>

    <div class="stack">
      ${!me && !enemies.length ? `<div class="panel"><h2>Как пользоваться</h2>
        <ol class="tight small">
          <li>Выбери своего героя — любого из 127, не только мидера.</li>
          <li>Нажми «Я играю на: Керри/Мид/Оффлейн/Поддержка/Роам» — билд, тайминги и советы перестроятся под роль.</li>
          <li>Введи вражеский драфт (5) — ситуативные предметы подстроятся под них. Своих 4 союзников вводи, чтобы они не предлагались в пикере и рекомендациях, а полный состав 5×5 попадал в шаринг-ссылку и план текстом.</li>
          <li>Для мида укажи, кто у них на миде, чтобы получить разбор лейна; для других ролей — смотри план закупа под роль.</li>
          <li>Либо вставь скриншот экрана пика на вкладке «Скриншот» — герои распознаются и подставятся сами.</li>
        </ol>
        <p class="muted small">Всё работает офлайн и на цифрах патча 7.41 — без сторонних сервисов и винрейтов. Роль можно менять на лету — билд для любого героя на любой позиции готов.</p>
      </div>` : ''}

      ${lane ? `<div class="panel">
        <h2>Разбор мид-лейна</h2>
        <div class="verdict ${lane.verdict.tone}">
          <div class="spread">
            <div>
              <div class="score">${lane.score > 0 ? '+' : ''}${lane.score}</div>
              <div class="small muted">${esc(DATA.heroes[me].localized_name)} против ${esc(DATA.heroes[enemyMid].localized_name)}</div>
            </div>
            <div style="max-width:60%">
              <div style="font-weight:700">${esc(lane.verdict.title)}</div>
              <div class="small muted">${esc(lane.verdict.text)}</div>
            </div>
          </div>
        </div>
        <h3>Из чего сложилась оценка</h3>
        <table class="factors">
          <tr><th>Фактор</th><th>У тебя</th><th>У него</th><th>Вывод</th></tr>
          ${lane.factors.map((f) => `<tr>
            <td>${esc(f.label)}</td><td>${esc(f.me || '—')}</td><td>${esc(f.them || '—')}</td>
            <td class="${f.value > 0 ? 'pos' : f.value < 0 ? 'neg' : ''}">${esc(f.note)}</td>
          </tr>`).join('')}
        </table>
        ${lane.tips.length ? `<h3>Что делать прямо на линии</h3><ul class="tight small">${lane.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      </div>` : me && enemyMid && myRole && myRole !== 'mid' ? `<div class="panel"><h2>Разбор лейна</h2><p class="small muted">Роль «${esc(ROLE_TITLES[myRole])}» — разбор мида скрыт. Билд и советы ниже собраны под твою роль, а угрозы и ситуативные предметы — под их драфт 5×5.</p></div>` : ''}

      ${combos.length ? `<div class="panel">
        <h2>Предупреждения по драфту врага</h2>
        <div class="stack">
          ${combos.map((c) => `<div class="threat sev2">
            <div class="small">${esc(c.advice)}</div>
            <div class="row tiny muted" style="margin-top:6px">${(c.items || []).map(([k]) => itemChip(k)).join('')}</div>
          </div>`).join('')}
        </div>
      </div>` : ''}

      ${threats.length ? `<div class="panel">
        <h2>Угрозы их драфта и ответы</h2>
        <div class="stack">
          ${threats.map((t) => `<div class="threat sev${t.severity}">
            <div class="spread">
              <div class="t">${esc(t.title)}</div>
              <div class="row tiny">${t.heroes.map((h) => `<span class="tag-pill">${esc(h.name)}</span>`).join('')}</div>
            </div>
            <div class="small muted">${esc(t.why)}</div>
            ${t.evidence && t.evidence.length ? `<div class="tiny muted" style="margin-top:4px">по тексту способностей: ${t.evidence.map(esc).join('; ')}</div>` : ''}
            ${t.items.length ? `<div class="row" style="margin-top:8px">${t.items.slice(0, 6).map(([k]) => itemChip(k)).join('')}</div>` : ''}
            ${t.actions.length ? `<ul class="tight small">${t.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
          </div>`).join('')}
        </div>
      </div>` : ''}

      ${plan ? `<div class="panel">
        <h2>Твой план: ${esc(plan.hero.localized_name)} <span class="muted tiny">· ${esc(myRole ? (ROLE_TITLES[myRole] || myRole) : (plan.archetype ? plan.archetype.title : 'Авто'))}</span></h2>
        ${myRole ? `<p class="small muted">Роль «<b>${esc(ROLE_TITLES[myRole])}</b>»${plan.curated ? ` — курируемый мид-план героя · ${esc(plan.curve || '')}` : plan.archetype ? ` — закуп по архетипу · ${esc(plan.curve || '')}` : ' — универсальный закуп' }${plan.difficulty ? ` · сложность: ${esc(plan.difficulty)}` : ''}</p>`
          : plan.curated ? `<p class="small muted">${esc(plan.curve || '')}${plan.difficulty ? ` · сложность: ${esc(plan.difficulty)}` : ''}</p>`
          : plan.archetype ? `<p class="small muted">Курируемого плана под 7.41 у героя нет — закуп собран по его роли: <b>${esc(plan.archetype.title)}</b>.${plan.archetype.why ? ` ${esc(plan.archetype.why)}.` : ''} ${esc(plan.curve || '')}</p>`
            : `<p class="small muted">Для этого героя нет ни плана, ни роли в базе — показываю универсальный мидовый закуп и адаптацию под их драфт.</p>`}
        ${plan.lane ? `<h3>Как играть лейн</h3><p class="small">${esc(plan.lane)}</p>` : ''}
        ${!plan.curated && plan.tips && plan.tips.length ? `<h3>Как играть роль</h3><ul class="tight small">${plan.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        <h3>Порядок способностей</h3>
        <div class="stack small">
          ${plan.skills.map(([key, note]) => `<div class="row" style="align-items:flex-start">
            <b style="flex:0 0 200px">${esc(DATA.abilities[key]?.dname || key)}</b>
            <span class="muted">${esc(note)}</span>
          </div>`).join('')}
          ${plan.ult && !plan.ultInSkills ? `<div class="row" style="align-items:flex-start"><b style="flex:0 0 200px">${esc(DATA.abilities[plan.ult]?.dname || 'Ультимейт')}</b><span class="muted">уровни 6 / 12 / 18</span></div>` : ''}
        </div>
        <h3>Стартовый закуп</h3>${itemRows(plan.items.start)}
        <h3>Ранний закуп</h3>${itemRows(plan.items.early)}
        <h3>Ядро</h3>${itemRows(plan.items.core)}
        <h3>Ситуативно — под их драфт</h3>${itemRows(plan.items.situational)}
        ${plan.spikes.length ? `<h3>Тайминги героя</h3><ul class="tight small">${plan.spikes.map(([t, n]) => `<li><b>${esc(t)}</b> — ${esc(n)}</li>`).join('')}</ul>` : ''}
        ${plan.curated && plan.tips.length ? `<h3>Практика</h3><ul class="tight small">${plan.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      </div>` : ''}

      ${picks.length ? `<div class="panel">
        <h2>Кого ещё можно взять против их драфта</h2>
        <div class="stack">
          ${picks.map((p) => `<div class="row" style="justify-content:space-between">
            <div class="row">${iconHTML(p.slug, 'ico-sm')}<b>${esc(p.name)}</b><span class="tiny muted">очки: ${p.score}</span></div>
            <div class="row tiny muted" style="flex:1 1 260px">${p.reasons.map(esc).join(' · ') || 'нейтрально'}</div>
            <button class="btn sm ghost" data-set-me="${esc(p.slug)}">Поставить себе</button>
          </div>`).join('')}
        </div>
      </div>` : ''}

      <div class="panel">
        <h2>Чеклист на игру</h2>
        <div class="stack small">
          ${checklist.map((c) => `<label class="checkline">
            <input type="checkbox" data-check="${esc(c)}" ${state.checks[c] ? 'checked' : ''}>
            <span>${esc(c)}</span>
          </label>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

/** Где герой уже стоит в драфте: 'me', 'enemies', 'allies' или null. */
function draftOwner(slug) {
  if (!slug) return null;
  if (state.me === slug) return 'me';
  if (state.enemies.includes(slug)) return 'enemies';
  if (state.allies.includes(slug)) return 'allies';
  return null;
}

function guessEnemyMid(enemies) {
  let best = null;
  let bestScore = -1;
  for (const slug of enemies) {
    const h = DATA.heroes[slug];
    if (!h) continue;
    const plan = DATA.plans[slug];
    // Лучший кандидат на мида: курируемый мид-план героя, дальний атакующий и нюкер.
    const s = (plan?.mid ? 3 : 0) + (h.attack_type === 'Ranged' ? 1 : 0) + (h.roles.includes('Nuker') ? 1 : 0);
    if (s > bestScore) { bestScore = s; best = slug; }
  }
  return best;
}

/* ------------------------------ вкладка «Герои» ------------------------------ */

function heroFiltered() {
  const q = state.heroSearch.trim().toLowerCase();
  return Object.values(DATA.heroes)
    .filter((h) => !state.attrFilter || h.primary_attr === state.attrFilter)
    .filter((h) => !state.roleFilter || h.roles.includes(state.roleFilter))
    .filter((h) => !state.onlyMid || DATA.plans[h.slug]?.mid)
    .filter((h) => !q || h.localized_name.toLowerCase().includes(q) || h.slug.includes(q))
    .sort((a, b) => byName(a.localized_name, b.localized_name));
}

function heroListHTML(list) {
  return `<p class="small muted">Найдено: ${list.length}${state.heroSearch ? ` по запросу «${esc(state.heroSearch)}»` : ''}</p>
    <div class="pick-grid">
      ${list.map((h) => `<button class="pick" data-hero="${esc(h.slug)}" aria-label="${esc(h.localized_name)}">
        ${DATA.plans[h.slug]?.mid ? '<span class="mid" aria-hidden="true">мид</span>' : ''}
        <div class="avatar">${iconHTML(h.slug)}</div>
        <div class="nm">${esc(h.localized_name)}</div>
      </button>`).join('')}
    </div>`;
}

/**
 * Ввод в #heroSearch: обновляем только список карточек и счётчик, сам <input> не трогаем —
 * его пересоздание (полный render) сбрасывало историю Ctrl+Z, выделение и IME-ввод.
 */
function updateHeroList() {
  const wrap = document.getElementById('heroList');
  if (!wrap) { render(); return; }
  wrap.innerHTML = heroListHTML(heroFiltered());
}

function renderHeroes() {
  const list = heroFiltered();
  const hero = heroBySlug(state.selectedHero);
  return `
  <div class="panel">
    <div class="head row">
      <input class="search" id="heroSearch" placeholder="Поиск героя…" aria-label="Поиск героя" value="${esc(state.heroSearch)}">
      <div class="chips" role="group" aria-label="Фильтры героев">
        ${['str', 'agi', 'int', 'all'].map((a) => `<button class="chip ${state.attrFilter === a ? 'active' : ''}" data-attr="${a}" aria-pressed="${String(state.attrFilter === a)}">${ATTR_RU[a]}</button>`).join('')}
        ${['Carry', 'Nuker', 'Initiator', 'Support', 'Disabler', 'Pusher'].map((r) => `<button class="chip ${state.roleFilter === r ? 'active' : ''}" data-role="${r}" aria-pressed="${String(state.roleFilter === r)}">${ROLE_RU[r]}</button>`).join('')}
        <button class="chip ${state.onlyMid ? 'active' : ''}" data-only-mid aria-pressed="${String(state.onlyMid)}">только мидовые</button>
      </div>
    </div>
    <div id="heroList">${heroListHTML(list)}</div>
  </div>
  ${hero ? renderHeroCard(hero) : ''}`;
}

function renderHeroCard(h) {
  const plan = DATA.plans[h.slug];
  // Для героя без курируемого плана показываем, по какой роли собран закуп (data/kb/archetypes.json).
  const rolePlan = !plan ? archetypeFor(h, DATA.archetypes) : null;
  const s = h.stats;
  const notes = h.notes || [];
  const tags = tagsOf(h.slug);
  // Служебные слоты (Stolen Spell, Devoured Ability, Souvenir Slot) и пустые технические записи
  // из источника не показываем: это не способности героя. Под-способности ультимейтов/стоек
  // (Activate Fire Remnant, Stone Form, Primal Spring, Bedlam) и дубли имён (три Shadowraze
  // у Shadow Fiend) — тоже: это один слот прокачки, а не разных.
  const ability = (key) => DATA.abilities[key];
  const shownNames = new Set();
  const visible = (key) => {
    const a = ability(key);
    if (isServiceAbility(key, a) || isSubAbility(key)) return false;
    const name = (a && a.dname) || key;
    if (shownNames.has(name)) return false;
    shownNames.add(name);
    return true;
  };
  const slots = h.slots.filter((x) => x.i <= 5 && visible(x.key));
  // h.extra — врождённые способности и под-способности (Necromastery, Static Field, Eureka!,
  // Multicast, Invoked Spell…). У 46 героев их 3 и больше, и раньше вместо карточек с описанием
  // и цифрами показывался только список названий; теперь карточка одинакова для любого числа.
  const extra = (h.extra || []).filter((key) => visible(key));
  const beats = plan?.beats || [];
  const loses = plan?.loses_to || [];

  return `<div class="panel" id="heroCard">
    <div class="row" style="align-items:flex-start;gap:16px">
      <div style="flex:0 0 220px">
        <div class="avatar">${iconHTML(h.slug)}</div>
        <div class="row tiny muted" style="margin-top:6px">${esc(ATTR_RU[h.primary_attr] || '')} · ${esc(h.attack_type)}</div>
        <div class="row tiny muted">${esc((h.roles || []).map((r) => ROLE_RU[r] || r).join(' · '))}</div>
        <div class="row" style="margin-top:8px">
          ${draftOwner(h.slug) === 'me'
    ? `<span class="tiny muted">Уже выбран твоим героем</span>`
    : draftOwner(h.slug)
      ? `<span class="tiny muted">Уже в драфте: ${draftOwner(h.slug) === 'enemies' ? 'у противников' : 'у союзников'}</span>`
      : `<button class="btn sm gold" data-set-me="${esc(h.slug)}">Поставить себе в драфт</button>`}
        </div>
      </div>
      <div style="flex:1 1 420px">
        <h2 style="color:var(--text);text-transform:none;font-size:22px;margin-bottom:6px">${esc(h.localized_name)}</h2>
        <div class="kv">
          <div><span>Здоровье (оценка 1 ур.)</span><b>${Math.round(heroHp(h))}</b></div>
          <div><span>Мана (оценка)</span><b>${Math.round(heroMana(h))}</b></div>
          <div><span>Урон автоатаки</span><b>${Math.round(heroDamage(h))}</b></div>
          <div><span>Броня (оценка)</span><b>${Math.round(heroArmor(h) * 10) / 10}</b></div>
          <div><span>Дистанция атаки</span><b>${s.attack_range}</b></div>
          <div><span>Скорость</span><b>${s.move_speed}</b></div>
          <div><span>Анимация атаки</span><b>${s.attack_point}s</b></div>
          <div><span>Снаряд</span><b>${s.projectile_speed || '—'}</b></div>
          <div><span>Рост силы / ловк. / инты</span><b>${s.str_gain} / ${s.agi_gain} / ${s.int_gain}</b></div>
          <div><span>Обзор день / ночь</span><b>${s.day_vision} / ${s.night_vision}</b></div>
        </div>
        ${tags.length ? `<div class="row" style="margin-top:10px">${tags.map((t) => `<span class="tag-pill">${esc(DATA.tagsKb.vocabulary[t]?.title || t)}</span>`).join('')}</div>` : ''}
        ${plan ? `<div class="row small" style="margin-top:10px"><span class="badge">мидовый план есть</span><span class="muted">${esc(plan.curve || '')}</span></div>`
    : rolePlan ? `<div class="row small" style="margin-top:10px"><span class="badge">закуп по роли: ${esc(rolePlan.title)}</span><span class="muted">${esc(rolePlan.data?.curve || '')}</span></div>` : ''}
      </div>
    </div>

    <h3>Способности</h3>
    <div class="stack">
      ${slots.map((x) => abilityCard(x.key)).join('')}
    </div>
    ${extra.length ? `<h3>Связанные способности и стойки</h3><div class="stack">${extra.map((k) => abilityCard(k)).join('')}</div>` : ''}

    ${(() => {
      try {
        const enemies = state.enemies.filter(Boolean);
        const b = buildPlan({ heroSlug: h.slug, enemySlugs: enemies, data: DATA });
        if (!b || !b.items) return '';
        const isAdapted = enemies.length > 0;
        const head = isAdapted ? `Рекомендуемый билд <span class="muted tiny">под твой драфт врага (${enemies.map((s) => esc(DATA.heroes[s]?.localized_name || s)).join(', ')})</span>` : 'Рекомендуемый билд <span class="muted tiny">(база, без учёта врагов)</span>';
        const cur = b.curated ? `<span class="badge">мид-план</span>` : b.archetype ? `<span class="badge">по роли: ${esc(b.archetype.title)}</span>` : `<span class="badge">универсальный</span>`;
        // Кривая, тайминги и кнопка «Поставить себе» здесь не дублируются: кривая уже показана
        // в шапке карточки, тайминги — в блоке «Мидовый план», кнопка — в шапке карточки
        // (вместо неё для своего героя выводится пометка «Уже выбран твоим героем»).
        return `<hr class="sep">
      <h3>${head}</h3>
      <div class="row small" style="margin-bottom:8px">${cur}</div>
      <h3 style="margin-top:10px">Стартовый закуп</h3>${itemRows(b.items.start)}
      <h3>Ранний закуп</h3>${itemRows(b.items.early)}
      <h3>Ядро</h3>${itemRows(b.items.core)}
      <h3>Ситуативно ${isAdapted ? '<span class="muted tiny">— под угрозы врага</span>' : ''}</h3>${itemRows(b.items.situational)}`;
      } catch { return ''; }
    })()}

    ${plan ? `<hr class="sep">
      <h3>Мидовый план</h3>
      ${plan.lane ? `<p class="small">${esc(plan.lane)}</p>` : ''}
      <div class="small"><b>Приоритет способностей:</b> ${plan.skills.map(([k, n]) => `${esc(DATA.abilities[k]?.dname || k)} <span class="muted">(${esc(n)})</span>`).join(' · ')}</div>
      ${plan.spikes.length ? `<div class="small" style="margin-top:6px"><b>Тайминги:</b> ${plan.spikes.map(([t, n]) => `${esc(t)} — ${esc(n)}`).join(' · ')}</div>` : ''}
      ${plan.tips.length ? `<ul class="tight small">${plan.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      <div class="row small" style="margin-top:8px">
        ${beats.length ? `<span>Сильнее против: ${beats.map((b) => esc(DATA.heroes[b]?.localized_name || b)).join(', ')}</span>` : ''}
        ${loses.length ? `<span class="muted">Тяжело против: ${loses.map((b) => esc(DATA.heroes[b]?.localized_name || b)).join(', ')}</span>` : ''}
      </div>` : ''}

    ${notes.length ? `<h3>Изменения в серии ${esc(patchSeries())} (до ${esc(latestPatchVersion())})</h3><ul class="tight small">${notes.map((n) => `<li>${esc(patchText(n))}</li>`).join('')}</ul>` : ''}
  </div>`;
}

/* ------------------------------ вкладка «Предметы» ------------------------------ */

/** Полный отфильтрованный список: поиск всегда идёт по всем предметам, а не по нарисованным. */
function itemsFiltered() {
  const q = state.itemSearch.trim().toLowerCase();
  return Object.entries(DATA.items)
    .filter(([, it]) => !it.recipe)
    .filter(([k, it]) => !q || it.dname.toLowerCase().includes(q) || k.includes(q))
    .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0));
}

/**
 * Строка характеристики предмета. Источник даёт готовую строку с подстановкой («+ {value} Damage»),
 * у части характеристик её нет — тогда подписью служит сам ключ. Раньше характеристики, мана
 * и перезарядка не выводились вовсе, и карточка показывала только имя, цену и тип.
 */
function itemAttrHTML(a) {
  const value = Array.isArray(a.value) ? a.value.join(' / ') : a.value;
  const text = a.display && a.display.includes('{value}')
    ? a.display.replace(/\{value\}/g, value)
    : a.display ? `${a.display} ${value}`
      : `${String(a.key || '').replace(/_/g, ' ')}: ${value}`;
  return `<div>${esc(text)}</div>`;
}

function itemCardHTML([, it]) {
  const attrib = (it.attrib || []).slice(0, 8).map(itemAttrHTML).join('');
  const use = [
    it.mc ? `мана: ${it.mc}` : null,
    it.cd ? `перезарядка: ${it.cd} c` : null,
  ].filter(Boolean).join(' · ');
  return `<div class="ability item-card">
    <div class="spread"><div class="nm">${esc(it.dname)}</div><div class="cost" style="color:var(--gold);font-weight:700">${it.cost ?? ''}</div></div>
    <div class="meta">${esc(it.qual || '')}${it.tier ? ` · тир ${esc(it.tier)}` : ''}${it.behavior ? ` · ${esc(it.behavior)}` : ''}${use ? ` · ${esc(use)}` : ''}</div>
    ${attrib ? `<div class="attrib">${attrib}</div>` : ''}
    ${(it.abilities || []).map((a) => `<div class="desc"><b>${esc(a.title)}</b> <span class="muted tiny">(${a.type === 'active' ? 'актив' : 'пассив'})</span><br>${esc(a.description)}</div>`).join('')}
    ${it.notes ? `<div class="tiny muted" style="margin-top:6px">${esc(it.notes)}</div>` : ''}
    ${it.hint && it.hint.length ? `<div class="tiny muted" style="margin-top:6px">${it.hint.map(esc).join(' · ')}</div>` : ''}
    ${it.patchNotes && it.patchNotes.length ? `<div class="tiny" style="margin-top:6px;color:var(--gold)">${esc(patchSeries())}: ${it.patchNotes.slice(0, 2).map(esc).join('; ')}</div>` : ''}
    ${it.components && it.components.length ? `<div class="tiny muted" style="margin-top:6px">собирается из: ${it.components.map((c) => esc(DATA.items[c]?.dname || c)).join(' + ')}</div>` : ''}
  </div>`;
}

function itemsPagerHTML(total, shown) {
  if (shown >= total) return `<p class="tiny muted" id="itemPager" style="margin-top:10px">Показаны все ${total}.</p>`;
  const step = Math.min(ITEM_PAGE, total - shown);
  return `<div class="row" id="itemPager" style="margin-top:12px">
    <button class="btn ghost" data-items-more="${step}">Показать ещё ${step}</button>
    <span class="muted small">показано ${shown} из ${total}</span>
  </div>`;
}

function renderItems() {
  const list = itemsFiltered();
  const shown = Math.min(state.itemsShown, list.length);
  return `<div class="panel">
    <div class="head row">
      <input class="search" id="itemSearch" placeholder="Поиск предмета…" value="${esc(state.itemSearch)}">
      <span class="muted small" id="itemCount">${list.length} предметов</span>
    </div>
    <div class="cols-3 grid" id="itemGrid">
      ${list.slice(0, shown).map(itemCardHTML).join('')}
    </div>
    ${itemsPagerHTML(list.length, shown)}
  </div>`;
}

/**
 * Ввод в #itemSearch: заменяем только сетку карточек, счётчик и пагинацию — сам <input>
 * не пересоздаётся, чтобы не терять историю Ctrl+Z, выделение и IME-ввод (как и в поиске героев).
 */
function updateItemsList() {
  const grid = document.getElementById('itemGrid');
  if (!grid) { render(); return; }
  const list = itemsFiltered();
  const shown = Math.min(state.itemsShown, list.length);
  grid.innerHTML = list.slice(0, shown).map(itemCardHTML).join('');
  const count = document.getElementById('itemCount');
  if (count) count.textContent = `${list.length} предметов`;
  const pager = document.getElementById('itemPager');
  if (pager) pager.outerHTML = itemsPagerHTML(list.length, shown);
  if (shown >= list.length) stopItemsLazy();
  else if (state.tab === 'items') mountItemsLazy();
}

/** Догружает следующую порцию карточек, не перерисовывая уже показанные. */
function showMoreItems(step = ITEM_PAGE) {
  const grid = document.getElementById('itemGrid');
  if (!grid) return;
  const list = itemsFiltered();
  const shown = Math.min(state.itemsShown, list.length);
  const next = Math.min(shown + step, list.length);
  if (next > shown) {
    grid.insertAdjacentHTML('beforeend', list.slice(shown, next).map(itemCardHTML).join(''));
    state.itemsShown = next;
  }
  const pager = document.getElementById('itemPager');
  if (pager) pager.outerHTML = itemsPagerHTML(list.length, next);
  if (next >= list.length) stopItemsLazy();
}

let itemsObserver = null;

/** Подгрузка по скроллу: рядом с концом списка висит невидимый «часовой». */
function mountItemsLazy() {
  stopItemsLazy();
  // В jsdom/старых браузерах IntersectionObserver нет — остаётся кнопка «Показать ещё».
  if (typeof IntersectionObserver !== 'function') return;
  const grid = document.getElementById('itemGrid');
  if (!grid || state.itemsShown >= itemsFiltered().length) return;
  // Пустой блок высотой 1px: `display:none`-элемент не имеет бокса и наблюдатель его не увидит.
  const sentinel = document.createElement('div');
  sentinel.id = 'itemsSentinel';
  sentinel.style.cssText = 'height:1px;margin-top:-1px';
  grid.after(sentinel);
  itemsObserver = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) showMoreItems();
  }, { rootMargin: '800px 0px' });
  itemsObserver.observe(sentinel);
}

function stopItemsLazy() {
  if (itemsObserver) { itemsObserver.disconnect(); itemsObserver = null; }
  document.getElementById('itemsSentinel')?.remove();
}

/* ------------------------------ вкладка «Патч» ------------------------------ */

/**
 * Разметка источника в патчноутах. Свежая сборка данных уже отдаёт обычный текст (теги и
 * HTML-сущности вычищает tools/build_data.mjs), но если файл собран старой версией сборщика,
 * вкладка не должна печатать «<br>» и «<span class="Subtitle">» как текст.
 */
function patchText(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Строки списка изменений без HTML и без пустых пунктов (одиночный <br> — не пункт). */
const patchList = (arr) => (Array.isArray(arr) ? arr : []).map(patchText).filter(Boolean);

/**
 * Запись героя в патчноуте: объект «способность → изменения» (обычный случай) или массив строк
 * (как запись misc — «прочее»). Раньше массив разбирался как объект, и вкладка падала с
 * TypeError; теперь оба вида дают список строк.
 */
function heroNoteLines(obj) {
  if (Array.isArray(obj)) return patchList(obj);
  return Object.entries(obj || {}).flatMap(([ab, arr]) => patchList(arr)
    .map((c) => `<span class="muted">${esc(DATA.abilities[ab]?.dname || ab.replace(/_/g, ' '))}:</span> ${esc(c)}`));
}

function renderPatch() {
  const versions = Object.keys(DATA.patchnotes).sort(comparePatch);
  const v = state.patch && DATA.patchnotes[state.patch] ? state.patch : versions[versions.length - 1];
  state.patch = v;
  const note = DATA.patchnotes[v] || { general: [], items: {}, heroes: {} };
  // Пустые после чистки записи не показываем: заголовок без изменений только мешает читать.
  const itemEntries = Object.entries(note.items || {}).map(([k, arr]) => [k, patchList(arr)]).filter(([, arr]) => arr.length);
  const heroEntries = Object.entries(note.heroes || {}).filter(([k]) => DATA.heroes[k]);
  const general = patchList(note.general);
  const misc = Object.entries(note.heroes || {}).filter(([k]) => !DATA.heroes[k]);
  return `<div class="panel">
    <div class="head row">
      <h2 style="margin:0">Патчноуты</h2>
      <select class="search" id="patchSelect" style="flex:0 0 auto">
        ${versions.slice().reverse().map((x) => `<option value="${esc(x)}" ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}
      </select>
      <span class="muted small">показан патч ${esc(v)} · всего в базе: ${versions.length}</span>
    </div>
    ${general.length ? `<h3>Общие изменения</h3><ul class="tight small">${general.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    ${itemEntries.length ? `<h3>Предметы</h3><div class="stack small">${itemEntries.map(([k, arr]) => `
      <div>
        <div class="row"><b>${esc(DATA.items[k]?.dname || k)}</b>${DATA.items[k] ? itemChip(k) : ''}</div>
        <ul class="tight">${arr.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      </div>`).join('')}</div>` : ''}
    ${heroEntries.length ? `<h3>Герои</h3><div class="stack small">${heroEntries.map(([slug, obj]) => `
      <div>
        <div class="row" style="cursor:pointer" data-goto-hero="${esc(slug)}"><b>${esc(DATA.heroes[slug].localized_name)}</b></div>
        <ul class="tight">${heroNoteLines(obj).map((c) => `<li>${c}</li>`).join('')}</ul>
      </div>`).join('')}</div>` : ''}
    ${misc.length ? `<h3>Прочее</h3><div class="stack small">${misc.map(([k, obj]) => `<div><b>${esc(k.replace(/_/g, ' '))}</b><ul class="tight">${heroNoteLines(obj).map((c) => `<li>${c}</li>`).join('')}</ul></div>`).join('')}</div>` : ''}
  </div>`;
}

/* ------------------------------ вкладка «Тайминги» ------------------------------ */

function upcomingEvents(elapsed) {
  const out = [];
  for (const [idx, ev] of DATA.timings.events.entries()) {
    const at = parseAt(ev.at);
    if (ev.every) {
      const step = parseAt(ev.every);
      const n = elapsed <= at ? at : at + Math.ceil((elapsed - at) / step) * step;
      out.push({ ev, next: n, idx });
    } else if (elapsed < at) {
      out.push({ ev, next: at, idx });
    }
  }
  return out.sort((a, b) => a.next - b.next);
}

/** Строка одного события: индекс в DATA.timings.events служит ключом для точечных обновлений. */
function upcomingRowHTML({ ev, next, idx }, elapsed) {
  const left = next - elapsed;
  return `<div class="timer-row ${left <= 20 ? 'soon' : ''}" data-ev="${idx}">
      <span class="tag-pill">${esc(KIND_RU[ev.kind] || ev.kind)}</span>
      <div><b>${esc(ev.title)}</b><div class="tiny muted">${esc(ev.text.split('.')[0])}</div></div>
      <span class="in">${fmtTime(left)}</span>
    </div>`;
}
/** Идентификатор нарисованного набора событий: пока он тот же, структуру DOM трогать не нужно. */
const upcomingKey = (rows) => rows.map((r) => r.idx).join(',');
function renderUpcomingHTML(rows, elapsed) {
  return rows.map((r) => upcomingRowHTML(r, elapsed)).join('');
}

function renderTimers() {
  const groups = {};
  for (const ev of DATA.timings.events) (groups[ev.kind] ||= []).push(ev);
  const elapsed = timerElapsed();
  const rows = upcomingEvents(elapsed).slice(0, 8);

  return `<div class="grid cols-2">
    <div class="stack">
      <div class="panel">
        <h2>Живой таймер</h2>
        ${renderClockHTML()}
        <div class="row" style="margin-top:10px">
          <button class="btn gold" data-timer="start">▶ Старт (синхрон с рогом)</button>
          <button class="btn ghost" data-timer="stop">Стоп</button>
          <button class="btn ghost" data-timer="reset">Сброс</button>
        </div>
        <p class="tiny muted" style="margin-top:8px">Нажми «Старт» ровно в момент начала матча — панель сама подскажет ближайшие события.</p>
      </div>
      <div class="panel">
        <h2>Ближайшие события</h2>
        <div class="stack" id="upcoming" data-ev-rows="${upcomingKey(rows)}">
          ${renderUpcomingHTML(rows, elapsed)}
        </div>
      </div>
    </div>
    <div class="stack">
      ${Object.entries(groups).map(([kind, evs]) => `<div class="panel">
        <h2>${esc(KIND_RU[kind] || kind)}</h2>
        <div class="stack">
          ${evs.map((ev) => `<div class="threat sev1">
            <div class="spread"><div class="t">${esc(ev.title)}</div><span class="tag-pill">${esc(ev.at)}${ev.every ? ` / каждые ${esc(ev.every)}` : ''}</span></div>
            <div class="small muted">${esc(ev.text)}</div>
            ${ev.mid ? `<div class="small" style="margin-top:6px"><b>Для мида:</b> ${esc(ev.mid)}</div>` : ''}
            ${ev.types ? `<div class="tiny muted" style="margin-top:6px">Руны силы: ${ev.types.map(esc).join(', ')}</div>` : ''}
          </div>`).join('')}
        </div>
      </div>`).join('')}
      <div class="panel">
        <h2>Заметки по таймингам</h2>
        <ul class="tight small">${DATA.timings.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </div>
    </div>
  </div>`;
}

/* ------------------------------ вкладка «Как это работает» ------------------------------ */

function renderAbout() {
  return `<div class="panel">
    <h2>Как это работает</h2>
    <p class="small">Инструмент собран вокруг одного вопроса: <b>что мне делать в этом матче</b>. Он не использует сторонние сервисы,
    винрейты и телеметрию — только игровые данные вашего патча и механики, из которых эти решения выводятся.</p>
    <h3>Откуда данные</h3>
    <ul class="tight small">
      <li><b>Игровые константы</b> — открытый датасет <a href="https://github.com/odota/dotaconstants" target="_blank" rel="noreferrer">odota/dotaconstants</a>
        (герои, способности с цифрами, предметы, патчноуты). Версия: ${esc(DATA.meta.constantsVersion)}.</li>
      <li><b>Иконки героев</b> — репозиторий <a href="https://github.com/M-Hasan-Ibrahim/Dota2HeroInfoAndIcons" target="_blank" rel="noreferrer">Dota2HeroInfoAndIcons</a>:
        есть для ${Object.keys(DATA.heroes).length - heroesWithoutIcons().length} из ${Object.keys(DATA.heroes).length} героев.
        ${heroesWithoutIcons().length ? `Без иконки (показан буквенный аватар, на скриншоте не распознаются): ${esc(heroesWithoutIcons().join(', '))} — в источнике их нет.` : ''}</li>
      <li><b>Патч</b>: серия ${esc(patchSeries())} (вышла ${esc(String(DATA.meta.latestPatchDate).slice(0, 10))}), последняя версия в патчноутах — ${esc(latestPatchVersion())}.
        Героев: ${DATA.meta.heroes}, предметов: ${DATA.meta.items}. Данные собраны ${esc(String(DATA.meta.generatedAt || '').slice(0, 10))}.</li>
    </ul>
    <h3>Что считает движок</h3>
    <ul class="tight small">
      <li><b>Разбор лейна</b> — по цифрам клиента: дистанция атаки, урон, анимация и снаряд, броня, мобильность, састен и угроза убийства.
        Плюс ручная разметка матчапов из планов героев.</li>
      <li><b>Угрозы и ответы</b> — теги механик (невидимость, сайленсы, бурст, спасения…) превращаются в конкретные предметы и действия.
        Для героев без ручной разметки работает автоматический разбор текстов способностей (он помечен как «по тексту способностей»).</li>
      <li><b>План закупа</b> — базовый план героя под 7.41 + ситуативные ответы на их драфт, с ценой каждого предмета.</li>
      <li><b>Рекомендации по пикам</b> — пересечение матчапов и ответов на угрозы, без «винрейтов из воздуха».</li>
    </ul>
    <h3>Честные ограничения</h3>
    <ul class="tight small">
      <li>Это не статистика: цифры — из клиента, суждения — мои, их стоит проверять в игре.</li>
      <li>Герой, появившийся после обновления базы, покажет только то, что есть в данных, без «додумывания».</li>
      <li>Все планы строятся по патчу 7.41: фацеты удалены, врождённые способности скейлятся от уровня героя.</li>
    </ul>
    <h3>Обновить базу данных</h3>
    <p class="small muted">Локально: <code>node tools/build_data.mjs</code> — скачает свежие константы и иконки, пересоберёт <code>data/</code>
      и провалидирует файлы знаний (все ссылки на героев, способности, предметы и теги); <code>--cached</code> — собрать из уже скачанного.
      Затем <code>node tools/build_templates.mjs</code> пересчитает подписи для распознавания. Запуск сайта: <code>python3 -m http.server 8000</code> в корне репозитория.</p>
  </div>`;
}

/* ------------------------------ рендер ------------------------------ */

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  const view = $('#view');
  try {
    if (state.tab === 'draft') view.innerHTML = renderDraft();
    else if (state.tab === 'shot') { view.innerHTML = renderShot(); mountShot(); }
    else if (state.tab === 'heroes') view.innerHTML = renderHeroes();
    else if (state.tab === 'items') { view.innerHTML = renderItems(); mountItemsLazy(); }
    else if (state.tab === 'patch') { if (DATA.patchnotes) view.innerHTML = renderPatch(); else renderPatchTab(); }
    else if (state.tab === 'timers') view.innerHTML = renderTimers();
    else view.innerHTML = renderAbout();
  } catch (err) {
    // Ошибка рендера не прячется: она видна на экране и в консоли, а интерфейс не «зависает»
    // на прошлом кадре (например, на «Распознаю карточки…»).
    console.error(err);
    view.innerHTML = `<div class="panel"><h2>Ошибка интерфейса</h2><p class="small warn">${esc(err && err.message)}</p>
      <p class="small muted">Переключи вкладку или обнови страницу. Если ошибка повторяется — сообщи о ней вместе с шагами.</p></div>`;
  }
  if (state.tab !== 'items') stopItemsLazy();
  scrollToHeroCard();
}

/* ------------------------------ выбор героя ------------------------------ */

/**
 * Прокрутка к карточке героя — только когда героя выбрали (клик по списку или переход
 * «Показать героя»). Поиск и фильтры на вкладке «Герои» перерисовывают список десятки раз
 * на ввод одной буквы; раньше каждый такой рендер дёргал scrollIntoView и страница уезжала
 * к карточке прямо во время набора. Помним, для какого героя уже прокрутили.
 */
let heroCardScrolledFor = null;

function scrollToHeroCard() {
  if (state.tab !== 'heroes' || !state.selectedHero) return;
  if (heroCardScrolledFor === state.selectedHero) return;
  heroCardScrolledFor = state.selectedHero;
  const card = $('#heroCard');
  if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function openPicker(target) {
  const { group, idx } = target;
  let q = '';
  let attr = null;
  // Фильтр «только мидовые» по умолчанию — только для своего героя, пока роль не выбрана
  // (или выбрана мидовая): для саппорта/керри мид-планы героям не нужны.
  let onlyMid = group === 'me' && (!state.myRole || state.myRole === 'mid');
  const modal = document.createElement('div');
  modal.className = 'overlay';
  modal.setAttribute('role', 'presentation');
  modal.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Выбор героя">
    <div class="head row">
      <input class="search" id="pickerSearch" placeholder="Поиск героя…" aria-label="Поиск героя">
      <div class="chips" id="pickerChips" role="group" aria-label="Фильтры">
        <button class="chip ${onlyMid ? 'active' : ''}" data-mid="1" aria-pressed="${String(onlyMid)}">мидовые</button>
        <button class="chip ${onlyMid ? '' : 'active'}" data-mid="0" aria-pressed="${String(!onlyMid)}">все герои</button>
        ${['str', 'agi', 'int', 'all'].map((a) => `<button class="chip" data-attr="${a}" aria-pressed="false">${ATTR_RU[a]}</button>`).join('')}
      </div>
      <button class="btn ghost" data-close aria-label="Закрыть окно выбора">Закрыть</button>
    </div>
    <div class="pick-grid" id="pickerGrid"></div>
  </div>`;
  document.getElementById('modalRoot').appendChild(modal);
  const draw = () => {
    // Герой уже занят в другом слоте — не показываем его (дубликаты в драфте не нужны).
    const used = new Set();
    if (group === 'me') {
      state.enemies.filter(Boolean).forEach((s) => used.add(s));
      state.allies.filter(Boolean).forEach((s) => used.add(s));
    } else if (group === 'enemies') {
      if (state.me) used.add(state.me);
      state.enemies.forEach((s, i) => { if (s && i !== idx) used.add(s); });
      state.allies.filter(Boolean).forEach((s) => used.add(s));
    } else {
      if (state.me) used.add(state.me);
      state.enemies.filter(Boolean).forEach((s) => used.add(s));
      state.allies.forEach((s, i) => { if (s && i !== idx) used.add(s); });
    }
    const list = Object.values(DATA.heroes)
      .filter((h) => !used.has(h.slug))
      .filter((h) => !attr || h.primary_attr === attr)
      .filter((h) => !onlyMid || DATA.plans[h.slug]?.mid)
      // Поиск и по слагу: «antimage», «queenofpain», «furion», «nevermore», «zuus» — так героя
      // ищут по названию файла/строке драфта, а не только по локализованному имени.
      .filter((h) => !q || h.localized_name.toLowerCase().includes(q) || h.slug.includes(q))
      .sort((a, b) => byName(a.localized_name, b.localized_name));
    $('#pickerGrid', modal).innerHTML = list.map((h) => `<button class="pick" data-choose="${esc(h.slug)}" aria-label="Выбрать ${esc(h.localized_name)}">
      ${DATA.plans[h.slug]?.mid ? '<span class="mid">мид</span>' : ''}
      <div class="avatar">${iconHTML(h.slug)}</div><div class="nm">${esc(h.localized_name)}</div>
    </button>`).join('');
  };
  draw();
  // Escape закрывает пикер, как и клик по фону/кнопке «Закрыть»: раньше из модального окна
  // можно было выйти только мышью. Слушатель висит на document (ловит Escape с любым фокусом,
  // в том числе вне модалки) и снимается при закрытии — иначе каждый открытый пикер
  // оставлял бы за собой свой обработчик.
  const closePicker = () => {
    document.removeEventListener('keydown', pickerEsc);
    modal.remove();
  };
  function pickerEsc(e) {
    if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
  }
  document.addEventListener('keydown', pickerEsc);
  $('#pickerSearch', modal)?.focus();
  modal.addEventListener('input', (e) => { if (e.target.id === 'pickerSearch') { q = e.target.value.trim().toLowerCase(); draw(); } });
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) { closePicker(); return; }
    const chip = e.target.closest('.chip');
    if (chip) {
      if (chip.dataset.mid !== undefined) {
        onlyMid = chip.dataset.mid === '1';
        modal.querySelectorAll('[data-mid]').forEach((c) => { const on = c === chip; c.classList.toggle('active', on); c.setAttribute('aria-pressed', String(on)); });
      } else {
        attr = attr === chip.dataset.attr ? null : chip.dataset.attr;
        modal.querySelectorAll('[data-attr]').forEach((c) => { const on = attr && c.dataset.attr === attr; c.classList.toggle('active', !!on); c.setAttribute('aria-pressed', String(!!on)); });
      }
      draw();
      return;
    }
    const choose = e.target.closest('[data-choose]');
    if (choose) {
      const slug = choose.dataset.choose;
      if (group === 'me') state.me = slug;
      else if (group === 'enemies') state.enemies[idx] = slug;
      else if (group === 'allies') state.allies[idx] = slug;
      // Мид противника не назначаем автоматически: до ручного выбора в селекте (или параметра
      // em в hash) его определяет guessEnemyMid по текущему составу врагов.
      saveDraft();
      closePicker();
      render();
    }
  });
}

/* ------------------------------ вкладка «Скриншот» ------------------------------ */

/** Подписи статусов ячейки (см. shotHeroes). */
const SHOT_STATUS_RU = {
  ok: '',
  manual: 'выбран вручную',
  weak: 'не определён: слабое совпадение — выбери героя сам',
  empty: 'пустая ячейка',
  cleared: 'отмечено как «не определён»',
};

/** Строка результата: миниатюра ячейки, список героев и ближайшие альтернативы. */
function shotRowHTML(row, heroOptions) {
  // Кандидаты — подсказки: для слабого совпадения первым идёт лучший кандидат, для уверенного — следующие.
  const alts = row.candidates
    .filter((c) => c.slug !== row.slug)
    .slice(0, 3)
    .map((c) => `<button class="chip" data-shot-alt="${row.index}:${esc(c.slug)}" aria-label="Выбрать ${esc(DATA.heroes[c.slug].localized_name)}" title="Близость ${esc(c.score)}">${esc(DATA.heroes[c.slug].localized_name)}</button>`)
    .join('');
  const statusText = SHOT_STATUS_RU[row.status] || '';
  const warn = row.status === 'weak' || row.status === 'cleared';
  const info = [
    `ячейка ${row.index + 1}`,
    row.score === null ? null : `близость ${row.score}`,
    statusText ? (warn ? `<span class="warn">${esc(statusText)}</span>` : esc(statusText)) : null,
  ].filter(Boolean).join(' · ');
  return `<div class="shot-row" data-shot-status="${esc(row.status)}">
    <canvas class="shot-thumb" data-shot-thumb="${row.index}" width="52" height="52" aria-hidden="true"></canvas>
    <div class="shot-info">
      <select class="shot-pick" data-shot-pick="${row.index}" aria-label="Герой в ячейке ${row.index + 1}">
        <option value=""${row.slug ? '' : ' selected'}>— не определён —</option>
        ${heroOptions.map((h) => `<option value="${esc(h.slug)}"${h.slug === row.slug ? ' selected' : ''}>${esc(h.localized_name)}</option>`).join('')}
      </select>
      <div class="small muted">${info}</div>
      ${alts ? `<div class="chips" style="margin-top:4px">${row.slug ? '' : '<span class="tiny muted">возможно:</span>'}${alts}</div>` : ''}
    </div>
  </div>`;
}

/** Герои без иконки: их нет среди шаблонов, поэтому на скриншоте они не распознаются. */
function heroesWithoutIcons() {
  return Object.values(DATA.heroes).filter((h) => !DATA.icons[h.slug]).map((h) => h.localized_name).sort(byName);
}

function renderShot() {
  const shot = state.shot;
  const result = shot.result;
  const rows = shotHeroes();
  const found = rows.filter((r) => r.slug).length;
  const empty = rows.filter((r) => r.status === 'empty').length;
  const unsure = rows.filter((r) => r.status === 'weak').length;
  const heroOptions = Object.values(DATA.heroes).sort((a, b) => byName(a.localized_name, b.localized_name));
  const cols = clampGridSize(shot.cols, 1);
  const rowsN = clampGridSize(shot.rows, 1);
  let gridInfo = 'Кадр ещё не распознан.';
  if (result && result.grid) {
    const meta = result.grid.meta || {};
    gridInfo = `Сетка ${esc(result.grid.cols)}×${esc(result.grid.rows)}${meta.colMode ? ` (${esc(meta.colMode)}/${esc(meta.rowMode)})` : ''}`
      + `${typeof result.confidence === 'number' ? `, уверенность ${Math.round(result.confidence * 100)}%` : ''}.`;
  } else if (result && shot.manual) {
    gridInfo = `Нарезка задана вручную: ${cols}×${rowsN}.`;
  } else if (result) {
    gridInfo = '<span class="warn">Сетка карточек автоматически не найдена.</span> Задай колонки, строки и область вручную.';
  }
  const noIcons = heroesWithoutIcons();
  const busy = shot.busy;
  return `
  <div class="grid cols-2">
    <div class="stack">
      <div class="panel">
        <h2>Скриншот экрана пика</h2>
        <p class="small muted">Вставь скриншот (Ctrl+V), перетащи файл в область или выбери его кнопкой.
          Распознавание идёт целиком в браузере по локальным иконкам — картинка никуда не отправляется.</p>
        <div class="shot-drop${shot.image ? ' filled' : ''}" id="shotDrop">
          ${shot.image
    ? '<canvas id="shotPreview" class="shot-preview"></canvas>'
    : '<div class="shot-empty"><b>Ctrl+V</b> · перетащи файл сюда · <label class="btn sm ghost" data-file-label role="button" tabindex="0">выбрать файл<input type="file" id="shotFile" accept="image/*" hidden></label></div>'}
        </div>
        ${shot.image ? `<div class="row small muted" style="margin-top:8px">
          <span>${esc(shot.name || 'скриншот')} · ${shot.image.width}×${shot.image.height}${shot.scaledFrom ? ` (уменьшено с ${esc(shot.scaledFrom.width)}×${esc(shot.scaledFrom.height)})` : ''}</span>
          <button class="btn sm ghost" data-shot="reset">Другой скриншот</button>
        </div>` : ''}
        ${busy ? '<p class="small" id="shotBusy">Распознаю карточки…</p>' : ''}
        ${shot.error ? `<p class="small warn" id="shotError">${esc(shot.error)}</p>` : ''}
        ${noIcons.length ? `<p class="tiny muted">Без иконки и потому не распознаются: ${esc(noIcons.join(', '))} — выбери их вручную в списке ячейки.</p>` : ''}
      </div>
      ${shot.image ? `
      <div class="panel">
        <h2>Сетка карточек</h2>
        <div class="row small">
          <label class="lbl">колонок <input class="num" id="shotCols" type="number" min="1" max="${MAX_GRID}" value="${cols}"></label>
          <label class="lbl">строк <input class="num" id="shotRows" type="number" min="1" max="${MAX_GRID}" value="${rowsN}"></label>
          <button class="btn sm" data-shot="resplit">Нарезать заново</button>
          <button class="btn sm ghost" data-shot="auto">Автопоиск</button>
        </div>
        <div class="row small" style="margin-top:6px">
          <span class="muted">область:</span>
          <label class="lbl">x <input class="num" id="shotX" type="number" min="0" max="${shot.image.width - 1}" value="${Math.round(shot.region ? shot.region.x : 0)}"></label>
          <label class="lbl">y <input class="num" id="shotY" type="number" min="0" max="${shot.image.height - 1}" value="${Math.round(shot.region ? shot.region.y : 0)}"></label>
          <label class="lbl">ш <input class="num" id="shotW" type="number" min="1" max="${shot.image.width}" value="${Math.round(shot.region ? shot.region.w : shot.image.width)}"></label>
          <label class="lbl">в <input class="num" id="shotH" type="number" min="1" max="${shot.image.height}" value="${Math.round(shot.region ? shot.region.h : shot.image.height)}"></label>
        </div>
        <p class="small muted" id="shotGridInfo">${gridInfo} Если автопоиск ошибся, задай колонки, строки и область вручную —
          удобно нарезать по одному ряду карточек (например, ряд одной команды) и заполнять драфт по частям.
          Область, выходящая за край кадра, обрезается по нему.</p>
      </div>` : ''}
    </div>
    <div class="stack">
      ${result ? `
      <div class="panel">
        <h2>Распознано героев: ${found} из ${rows.length}</h2>
        ${rows.length && (empty || unsure) ? `<p class="small muted">Пустых ячеек: ${empty} · не определено: ${unsure}. Неуверенные совпадения
          не подставляются автоматически — выбери героя в списке или кнопкой-подсказкой.</p>` : ''}
        ${rows.length ? `<div class="stack" id="shotList">${rows.map((r) => shotRowHTML(r, heroOptions)).join('')}</div>` : '<p class="small muted" id="shotList">Карточки героев не найдены.</p>'}
        ${found ? `<div class="row" style="margin-top:10px">
          <button class="btn sm" data-shot="fill-enemies">В противники</button>
          <button class="btn sm" data-shot="fill-allies">В союзники</button>
          <button class="btn sm ghost" data-shot="open-draft">Открыть драфт</button>
        </div>` : ''}
        ${shot.notice ? `<p class="small" id="shotNotice">${esc(shot.notice)}</p>` : ''}
        <p class="small muted">Заполняются свободные слоты драфта по порядку ячеек — только распознанные уверенно
          или выбранные вручную герои; повторы и герои, уже стоящие в драфте, пропускаются.</p>
      </div>` : `
      <div class="panel">
        <h2>Как это работает</h2>
        <ol class="small" style="margin:0;padding-left:18px">
          <li>Кадр уменьшается до рабочих 32×32 на ячейку и превращается в «подпись»: разностный хеш
            (dHash) и средние цвета.</li>
          <li>Сетка карточек ищется по профилям яркости и градиента, затем фаза сетки подгоняется
            по узнаваемости карточек.</li>
          <li>Каждая ячейка сравнивается с локальными иконками всех героев. Героя подставляем, только если
            совпадение и близкое, и однозначное; иначе ячейка остаётся «не определён» с подсказками.</li>
        </ol>
      </div>`}
    </div>
  </div>`;
}

/**
 * Полноразмерная копия кадра в canvas — одна на кадр: из неё рисуются и предпросмотр, и все
 * миниатюры (раньше на каждую миниатюру копировался весь кадр).
 */
let shotCanvasCache = { image: null, canvas: null };
function shotSourceCanvas() {
  const img = state.shot.image;
  if (!img) return null;
  if (shotCanvasCache.image === img) return shotCanvasCache.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) return null;
  const pixels = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4);
  ctx.putImageData(new ImageData(pixels, img.width, img.height), 0, 0);
  shotCanvasCache = { image: img, canvas };
  return canvas;
}

/** Рисует предпросмотр: кадр, найденную сетку и миниатюры ячеек. */
function mountShot() {
  const shot = state.shot;
  if (state.tab !== 'shot' || !shot.image) return;
  const preview = document.getElementById('shotPreview');
  const ctx = preview && preview.getContext && preview.getContext('2d');
  if (!ctx) return; // нет canvas (jsdom, старый браузер) — предпросмотр просто не рисуется
  const src = shotSourceCanvas();
  if (!src) return;
  const size = shotPreviewSize(shot.image);
  preview.width = size.w;
  preview.height = size.h;
  ctx.drawImage(src, 0, 0, size.w, size.h);
  const rows = shotHeroes();
  ctx.lineWidth = 2;
  for (const row of rows) {
    const r = row.rect;
    const ok = row.status === 'ok' || row.status === 'manual';
    ctx.strokeStyle = ok ? 'rgba(110, 207, 90, 0.95)' : row.status === 'empty' ? 'rgba(141, 154, 173, 0.8)' : 'rgba(240, 112, 58, 0.95)';
    ctx.fillStyle = ok ? 'rgba(110, 207, 90, 0.12)' : 'rgba(240, 112, 58, 0.08)';
    ctx.fillRect(r.x * size.k, r.y * size.k, r.w * size.k, r.h * size.k);
    ctx.strokeRect(r.x * size.k, r.y * size.k, r.w * size.k, r.h * size.k);
  }
  for (const el of document.querySelectorAll('[data-shot-thumb]')) {
    const row = rows[Number(el.dataset.shotThumb)];
    const tctx = row && el.getContext && el.getContext('2d');
    if (!tctx) continue;
    const r = row.rect;
    const side = Math.min(r.w, r.h);
    tctx.drawImage(src, r.x + (r.w - side) / 2, r.y + (r.h - side) / 2, side, side, 0, 0, el.width, el.height);
  }
}

/** Кладёт пиксели кадра в состояние и запускает распознавание. */
function shotUseImage(image, name = 'скриншот', scaledFrom = null) {
  const shot = state.shot;
  shot.image = image;
  shot.name = name;
  shot.result = null;
  shot.picks = {};
  shot.region = null;
  shot.regionEdited = false; // ручная область прошлого кадра к новому кадру не относится
  shot.manual = false;
  shot.error = '';
  shot.notice = '';
  shot.scaledFrom = scaledFrom;
  shotRun();
}

/**
 * Разбор файла/вставки: File → пиксели через canvas. Очень большие кадры уменьшаются до
 * SHOT_MAX_SIDE по длинной стороне: распознавание работает с подписями 32×32, а лишние
 * мегапиксели только замедляют его (и упираются в лимит размера canvas на мобильных).
 */
async function shotLoadBlob(blob, name) {
  let url = null;
  try {
    if (!blob) throw new Error('файл не получен');
    if (blob.type && !blob.type.startsWith('image/')) throw new Error(`это не изображение (${blob.type})`);
    url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('формат изображения не поддержан'));
      img.src = url;
    });
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    if (!srcW || !srcH) throw new Error('изображение пустое');
    const k = Math.min(1, SHOT_MAX_SIDE / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * k));
    const h = Math.max(1, Math.round(srcH * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) throw new Error('браузер не дал доступ к canvas');
    if (k < 1) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const pixels = new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.length);
    shotUseImage({ width: data.width, height: data.height, data: pixels }, name, k < 1 ? { width: srcW, height: srcH } : null);
  } catch (err) {
    state.shot.error = `Не удалось прочитать изображение: ${err.message}`;
    render();
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

/** Вход для тестов: в jsdom нет canvas, поэтому кадр подкладывается готовыми пикселями. */
window.__dpShot = (image, name) => shotUseImage(image, name);

/* ------------------------------ таймер ------------------------------ */

function timerElapsed() {
  const t = state.timer;
  return t.running ? (Date.now() - t.start) / 1000 + t.offset : t.offset;
}
function renderClockHTML() {
  const elapsed = timerElapsed();
  const isDay = Math.floor(elapsed / 300) % 2 === 0;
  return `<div class="clock ${isDay ? 'day' : 'night'}" id="clock">${fmtTime(elapsed)}</div>
    <div class="small muted" id="clockPhase">${isDay ? 'день' : 'ночь'} · цикл 5 минут</div>`;
}
/** Тик таймера обновляет только часы и счётчики «через X:XX» — без пересборки всего DOM. */
function updateTimerDOM() {
  const clock = document.getElementById('clock');
  if (!clock) return;
  const elapsed = timerElapsed();
  const isDay = Math.floor(elapsed / 300) % 2 === 0;
  clock.textContent = fmtTime(elapsed);
  clock.className = `clock ${isDay ? 'day' : 'night'}`;
  const phase = document.getElementById('clockPhase');
  if (phase) phase.textContent = `${isDay ? 'день' : 'ночь'} · цикл 5 минут`;

  const up = document.getElementById('upcoming');
  if (!up) return;
  const rows = upcomingEvents(elapsed).slice(0, 8);
  const key = upcomingKey(rows);
  // Состав и порядок событий те же — правим только текстовые узлы и подсветку «скоро».
  if (up.dataset.evRows === key) {
    const nodes = up.querySelectorAll('.timer-row');
    rows.forEach((r, i) => {
      const row = nodes[i];
      if (!row) return;
      const left = r.next - elapsed;
      const cell = row.querySelector('.in');
      if (cell) cell.textContent = fmtTime(left);
      row.classList.toggle('soon', left <= 20);
    });
    return;
  }
  // Событие прошло или сменился порядок — только тогда пересобираем список.
  up.innerHTML = renderUpcomingHTML(rows, elapsed);
  up.dataset.evRows = key;
}
let timerLoop = null;
function startTimerLoop() {
  if (timerLoop) return;
  timerLoop = setInterval(() => {
    if (state.tab === 'timers') updateTimerDOM();
  }, 1000);
}

/* ------------------------------ сохранение ------------------------------ */

function saveDraft() {
  try {
    localStorage.setItem('dp.draft', JSON.stringify({
      me: state.me, myRole: state.myRole, enemies: state.enemies, enemyMid: state.enemyMid, allies: state.allies, checks: state.checks,
    }));
  } catch { /* приватный режим — просто не сохраняем */ }
  syncHash();
}

/** Шаринг драфта по ссылке: кодируем в hash #me=&role=&en=&em=&al= (только валидные герои, без повторов). */
function draftToHash() {
  const p = new URLSearchParams();
  if (isHero(state.me)) p.set('me', state.me);
  if (state.myRole && ROLES.includes(state.myRole)) p.set('role', state.myRole);
  const en = state.enemies.filter(isHero);
  if (en.length) p.set('en', en.join(','));
  if (isHero(state.enemyMid) && en.includes(state.enemyMid)) p.set('em', state.enemyMid);
  const al = state.allies.filter(isHero);
  if (al.length) p.set('al', al.join(','));
  const s = p.toString();
  return s ? '#' + s : '';
}
function draftFromHash() {
  try {
    if (typeof location === 'undefined') return null;
    const h = String(location.hash || '').replace(/^#/, '');
    if (!h) return null;
    const p = new URLSearchParams(h);
    const seen = new Set();
    const take = (s) => (isHero(s) && !seen.has(s) ? (seen.add(s), s) : null);
    const me = take(p.get('me'));
    const roleRaw = String(p.get('role') || '').trim();
    const myRole = ROLES.includes(roleRaw) ? roleRaw : null;
    const enRaw = (p.get('en') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const en = [];
    for (const s of enRaw) { const v = take(s); if (v) en.push(v); if (en.length >= 5) break; }
    while (en.length < 5) en.push(null);
    const alRaw = (p.get('al') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const al = [];
    for (const s of alRaw) { const v = take(s); if (v) al.push(v); if (al.length >= 4) break; }
    while (al.length < 4) al.push(null);
    const emRaw = String(p.get('em') || '').trim();
    // Ручной выбор мида (параметр em) — только валидный герой из этого же списка врагов.
    // Без него enemyMid остаётся null: «их мид» определяет guessEnemyMid, а не первый враг.
    const em = isHero(emRaw) && en.includes(emRaw) ? emRaw : null;
    // пустой hash — не считаем драфтом (роль без героев — тоже пусто, не перезаписываем сохранённое)
    if (!me && !en.find(Boolean) && !al.find(Boolean) && !myRole) return null;
    return { me, myRole, enemies: en, enemyMid: em, allies: al };
  } catch { return null; }
}
function syncHash() {
  try {
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    const h = draftToHash();
    const cur = location.hash || '';
    if (h !== cur) history.replaceState(null, '', location.pathname + location.search + h);
  } catch { /* ignore */ }
}
function applyHash() {
  const d = draftFromHash();
  if (!d) return false;
  state.me = d.me;
  state.myRole = d.myRole || null;
  state.enemies = d.enemies;
  state.allies = d.allies;
  state.enemyMid = d.enemyMid;
  return true;
}
function randomDraft() {
  const mids = Object.keys(DATA.plans).filter((k) => !k.startsWith('_') && DATA.plans[k]?.mid && isHero(k));
  const pool = Object.keys(DATA.heroes);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const seen = new Set();
  const takeUnique = () => {
    let s; let tries = 0;
    do { s = pick(pool); tries++; } while (seen.has(s) && tries < 100);
    seen.add(s); return s;
  };
  state.me = pick(mids.length ? mids : pool);
  seen.add(state.me);
  state.myRole = ROLES[Math.floor(Math.random() * ROLES.length)];
  state.enemies = [0, 1, 2, 3, 4].map(() => takeUnique());
  state.enemyMid = pick(state.enemies);
  state.allies = [0, 1, 2, 3].map(() => Math.random() < 0.5 ? takeUnique() : null);
  // сбрасываем чеклист под новый драфт
  state.checks = {};
  // конфетти для кайфа: если вердикт хороший — подсветим
  saveDraft();
  render();
  // лёгкий вау-эффект: вибрация и звук клика не нужны, просто скролл к вердикту
  setTimeout(() => document.querySelector('.verdict')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 100);
}
function loadDraft() {
  try {
    const raw = JSON.parse(localStorage.getItem('dp.draft') || 'null');
    if (!raw) return;
    // Сохранённое состояние могло быть записано другой версией или испорчено (у всех сайтов
    // на *.github.io одно хранилище) — принимаем только известных героев, без повторов между
    // слотами, и корректные массивы, иначе рендер упадёт или драфт окажется противоречивым.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const seen = new Set();
    const take = (s) => {
      if (!isHero(s) || seen.has(s)) return null;
      seen.add(s);
      return s;
    };
    const arr = (list, n) => {
      const out = (Array.isArray(list) ? list : []).slice(0, n).map(take);
      while (out.length < n) out.push(null);
      return out;
    };
    state.me = take(raw.me);
    state.myRole = typeof raw.myRole === 'string' && ROLES.includes(raw.myRole) ? raw.myRole : null;
    state.enemies = arr(raw.enemies, 5);
    state.allies = arr(raw.allies, 4);
    state.enemyMid = isHero(raw.enemyMid) && state.enemies.includes(raw.enemyMid) ? raw.enemyMid : null;
    const checks = {};
    if (raw.checks && typeof raw.checks === 'object' && !Array.isArray(raw.checks)) {
      for (const [k, v] of Object.entries(raw.checks)) if (v === true) checks[k] = true;
    }
    state.checks = checks;
  } catch { /* игнорируем */ }
}

/**
 * Чистит сохранённые галочки: оставляет только «true» и только те пункты,
 * которые чеклист может выдать хоть на каком-то драфте. Иначе ключи от старых
 * драфтов копятся в localStorage бессрочно.
 * @returns {number} сколько ключей удалено
 */
function pruneChecks() {
  const universe = checklistUniverse(DATA);
  let dropped = 0;
  for (const key of Object.keys(state.checks)) {
    if (state.checks[key] !== true || !universe.has(key)) { delete state.checks[key]; dropped++; }
  }
  return dropped;
}

/* ------------------------------ план текстом ------------------------------ */

function planAsText() {
  const enemies = state.enemies.filter(Boolean);
  const enemyMid = state.enemyMid && state.enemies.includes(state.enemyMid) ? state.enemyMid : guessEnemyMid(enemies);
  const lines = [`=== План на игру (Dota 2, патч ${patchSeries()}, патчноуты до ${latestPatchVersion()}) ===`];
  if (state.me) {
    const roleTxt = state.myRole ? ` · роль: ${ROLE_TITLES[state.myRole] || state.myRole}` : '';
    lines.push(`Мой герой: ${DATA.heroes[state.me]?.localized_name || state.me}${roleTxt}`);
  }
  if (state.allies.filter(Boolean).length) lines.push(`Союзники: ${state.allies.filter(Boolean).map((s) => DATA.heroes[s]?.localized_name || s).join(', ')}`);
  if (enemies.length) lines.push(`Враги: ${enemies.map((s) => DATA.heroes[s]?.localized_name || s).join(', ')}`);
  if (state.me && enemyMid && (!state.myRole || state.myRole === 'mid')) {
    const lane = laneReport(DATA.heroes[state.me], DATA.heroes[enemyMid], { tagsKb: DATA.tagsKb, rules: DATA.rules, plans: DATA.plans });
    lines.push(`\nМИД: ${lane.verdict.title} (${lane.score > 0 ? '+' : ''}${lane.score})`);
    lines.push(lane.verdict.text);
    for (const t of lane.tips) lines.push('  • ' + t);
  }
  if (enemies.length) {
    lines.push('\nУГРОЗЫ И ОТВЕТЫ:');
    for (const t of threatsFor(enemies, DATA)) {
      lines.push(`  • ${t.title} (${t.heroes.map((h) => h.name).join(', ')}) — предметы: ${t.items.slice(0, 4).map(([k]) => DATA.items[k]?.dname || k).join(', ')}`);
      for (const a of t.actions.slice(0, 2)) lines.push('      - ' + a);
    }
  }
  if (state.me) {
    const plan = buildPlan({ heroSlug: state.me, enemySlugs: enemies, data: DATA, role: state.myRole });
    lines.push('\nЗАКУП:');
    for (const g of ['start', 'early', 'core', 'situational']) {
      const arr = plan.items[g];
      if (!arr.length) continue;
      lines.push(`  ${g === 'start' ? 'старт' : g === 'early' ? 'ранний' : g === 'core' ? 'ядро' : 'ситуативно'}: ${arr.map((i) => DATA.items[i.key]?.dname || i.key).join(', ')}`);
    }
    if (plan.skills.length) lines.push('\nСПОСОБНОСТИ: ' + plan.skills.map(([k]) => DATA.abilities[k]?.dname || k).join(' → '));
    if (!plan.curated) lines.push('\nСБОРКА: ' + (plan.archetype
      ? `по роли «${plan.archetype.title}»${plan.curve ? `. ${plan.curve}` : ''}`
      : 'универсальный мидовый закуп: отдельного плана у героя нет'));
  }
  if (DATA.timings.plan_summary) lines.push('\nТАЙМИНГИ: ' + DATA.timings.plan_summary);
  return lines.join('\n');
}

/* ------------------------------ события ------------------------------ */

function bindEvents() {
  // Выбор файла: <label> с вложенным скрытым <input> кликается мышью, но с клавиатуры
  // метка без обработчика ничего не делает. Enter/Space на фокусированной метке (tabindex="0")
  // открывают выбор файла так же, как обычный клик.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const label = e.target && e.target.closest ? e.target.closest('label[data-file-label]') : null;
    if (!label) return;
    e.preventDefault();
    const input = label.querySelector('input[type="file"]');
    if (input) input.click();
  });
  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('#tabs button');
    if (tab) {
      state.tab = tab.dataset.tab;
      if (state.tab === 'timers') startTimerLoop();
      if (state.tab === 'items') state.itemsShown = ITEM_PAGE; // первый рендер вкладки — только первая порция
      render(); return;
    }

    const moreItems = e.target.closest('[data-items-more]');
    if (moreItems) { showMoreItems(Number(moreItems.dataset.itemsMore) || ITEM_PAGE); return; }

    const shotBtn = e.target.closest('[data-shot]');
    if (shotBtn) {
      const act = shotBtn.dataset.shot;
      if (act === 'reset') {
        shotCancelRuns(); // результат незавершённого распознавания старого кадра больше не нужен
        state.shot = {
          ...state.shot, image: null, result: null, picks: {}, region: null, regionEdited: false,
          error: '', busy: false, notice: '', manual: false, scaledFrom: null,
        };
        render();
        return;
      }
      if (act === 'auto') { shotRun({ manual: false }); return; }
      if (act === 'resplit') {
        const shot = state.shot;
        if (!shot.image) return;
        // Колонки/строки — целые 1…MAX_GRID, область — внутри кадра: в состоянии и в полях
        // формы остаётся ровно то, что реально режется.
        shot.cols = clampGridSize($('#shotCols')?.value, shot.cols || 1);
        shot.rows = clampGridSize($('#shotRows')?.value, shot.rows || 1);
        shot.region = clampRegion({
          x: $('#shotX')?.value, y: $('#shotY')?.value, w: $('#shotW')?.value, h: $('#shotH')?.value,
        }, shot.image.width, shot.image.height);
        shot.regionEdited = true;
        shotRun({ manual: true });
        return;
      }
      if (act === 'fill-enemies') { shotFill('enemies'); return; }
      if (act === 'fill-allies') { shotFill('allies'); return; }
      if (act === 'open-draft') { state.tab = 'draft'; render(); return; }
      if (act === 'open-shot') { state.tab = 'shot'; render(); return; }
    }

    const shotAlt = e.target.closest('[data-shot-alt]');
    if (shotAlt) {
      const [idx, slug] = shotAlt.dataset.shotAlt.split(':');
      const i = Number(idx);
      const cells = state.shot.result ? state.shot.result.cells : [];
      if (isHero(slug) && Number.isInteger(i) && i >= 0 && i < cells.length) {
        state.shot.picks[i] = slug;
        state.shot.notice = '';
      }
      render();
      return;
    }

    const pick = e.target.closest('[data-pick]');
    if (pick) { const [group, idx] = pick.dataset.pick.split(':'); openPicker({ group, idx: Number(idx) }); return; }

    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const [group, idx] = rm.dataset.remove.split(':');
      if (group === 'enemies') {
        const removed = state.enemies[Number(idx)];
        state.enemies[Number(idx)] = null;
        if (state.enemyMid === removed) state.enemyMid = null;
      } else if (group === 'allies') state.allies[Number(idx)] = null;
      saveDraft();
      render(); return;
    }

    const setMe = e.target.closest('[data-set-me]');
    if (setMe) {
      const slug = setMe.dataset.setMe;
      const owner = draftOwner(slug);
      // Один герой не может стоять в двух слотах драфта: занятого у противников или союзников не ставим.
      if (!isHero(slug) || (owner && owner !== 'me')) return;
      state.me = slug; state.tab = 'draft'; saveDraft(); render(); return;
    }

    const heroBtn = e.target.closest('[data-hero]');
    if (heroBtn) { state.selectedHero = heroBtn.dataset.hero; render(); return; }

    const gotoHero = e.target.closest('[data-goto-hero]');
    if (gotoHero) { state.selectedHero = gotoHero.dataset.gotoHero; state.tab = 'heroes'; state.heroSearch = ''; state.onlyMid = false; render(); return; }

    const rolePick = e.target.closest('[data-rolepick]');
    if (rolePick) {
      const v = rolePick.dataset.rolepick;
      state.myRole = v && ROLES.includes(v) ? v : null;
      saveDraft();
      render();
      return;
    }

    const attr = e.target.closest('[data-attr]');
    if (attr && attr.closest('#view')) { state.attrFilter = state.attrFilter === attr.dataset.attr ? null : attr.dataset.attr; render(); return; }
    const role = e.target.closest('[data-role]');
    if (role) { state.roleFilter = state.roleFilter === role.dataset.role ? null : role.dataset.role; render(); return; }
    if (e.target.closest('[data-only-mid]')) { state.onlyMid = !state.onlyMid; render(); return; }

    const timerBtn = e.target.closest('[data-timer]');
    if (timerBtn) {
      const act = timerBtn.dataset.timer;
      // Повторный «Старт» не сбрасывает идущий отсчёт в 0:00 (раньше сбивал время матча);
      // он лишь заново синхронизирует отсчёт с текущего момента, сохраняя прошедшее время.
      if (act === 'start') { state.timer = { running: true, start: Date.now(), offset: timerElapsed() }; }
      else if (act === 'stop') { state.timer = { running: false, start: 0, offset: state.timer.running ? (Date.now() - state.timer.start) / 1000 + state.timer.offset : state.timer.offset }; }
      else state.timer = { running: false, start: 0, offset: 0 };
      render(); return;
    }

    const action = e.target.closest('[data-action]');
    if (action) {
      const a = action.dataset.action;
      if (a === 'reset') { state.me = null; state.myRole = null; state.enemies = [null, null, null, null, null]; state.enemyMid = null; state.allies = [null, null, null, null]; state.checks = {}; saveDraft(); render(); }
      if (a === 'clear-me') { state.me = null; saveDraft(); render(); }
      if (a === 'copy') {
        const text = planAsText();
        // Возвращаем только текст самой кнопки: полный render() в этот момент пересобирал бы
        // весь экран и сбивал открытую вкладку/ввод пользователя.
        try { await navigator.clipboard.writeText(text); action.textContent = 'Скопировано ✓'; setTimeout(() => { action.textContent = 'Скопировать план текстом'; }, 1200); }
        catch { window.prompt('Скопируй план:', text); }
        return;
      }
      if (a === 'share') {
        syncHash();
        const url = location.href;
        try { await navigator.clipboard.writeText(url); action.textContent = 'Ссылка скопирована ✓'; setTimeout(() => { action.textContent = 'Поделиться ссылкой'; }, 1500); }
        catch { window.prompt('Скопируй ссылку:', url); }
        return;
      }
      if (a === 'random') { randomDraft(); return; }
      return;
    }

    const itemChipEl = e.target.closest('[data-item]');
    if (itemChipEl) {
      state.tab = 'items';
      state.itemSearch = DATA.items[itemChipEl.dataset.item]?.dname || itemChipEl.dataset.item;
      state.itemsShown = ITEM_PAGE;
      render(); return;
    }
  });

  document.addEventListener('input', (e) => {
    // Поля ручной нарезки переносим в состояние сразу: любая перерисовка (например, правка
    // ячейки в списке распознанного) перерисовывает форму, и введённые координаты области
    // раньше терялись — оставалось то, что запомнила последняя «Нарезать заново».
    if (['shotX', 'shotY', 'shotW', 'shotH', 'shotCols', 'shotRows'].includes(e.target.id)) {
      const shot = state.shot;
      if (shot.image) {
        // Пустое или нечисловое поле не превращаем в «весь кадр»: пока число не введено,
        // в состоянии остаётся предыдущая рамка.
        const num = (sel) => {
          const raw = $(sel)?.value;
          const n = Number(raw);
          return raw !== '' && raw !== null && raw !== undefined && Number.isFinite(n) ? n : null;
        };
        const cols = num('#shotCols');
        const rowsN = num('#shotRows');
        if (cols !== null) shot.cols = clampGridSize(cols, shot.cols || 1);
        if (rowsN !== null) shot.rows = clampGridSize(rowsN, shot.rows || 1);
        const region = { x: num('#shotX'), y: num('#shotY'), w: num('#shotW'), h: num('#shotH') };
        if (region.x !== null && region.y !== null && region.w !== null && region.h !== null) {
          shot.region = clampRegion(region, shot.image.width, shot.image.height);
        }
        shot.regionEdited = true;
      }
      return; // без render(): перерисовка на каждый символ сбивала бы курсор в поле
    }
    if (e.target.id === 'heroSearch') { state.heroSearch = e.target.value; updateHeroList(); }
    if (e.target.id === 'itemSearch') {
      state.itemSearch = e.target.value;
      state.itemsShown = ITEM_PAGE; // новый запрос — снова показываем первую порцию
      updateItemsList();
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-shot-pick]')) {
      const idx = Number(e.target.dataset.shotPick);
      const cells = state.shot.result ? state.shot.result.cells : [];
      if (Number.isInteger(idx) && idx >= 0 && idx < cells.length) {
        // «— не определён —» — тоже правка: ячейка больше не подставляет найденного автоматически героя.
        state.shot.picks[idx] = isHero(e.target.value) ? e.target.value : null;
        state.shot.notice = '';
      }
      render();
      return;
    }
    if (e.target.id === 'shotFile' && e.target.files && e.target.files[0]) {
      shotLoadBlob(e.target.files[0], e.target.files[0].name);
      return;
    }
    if (e.target.matches('[data-enemy-mid]')) { state.enemyMid = e.target.value; saveDraft(); render(); }
    if (e.target.id === 'patchSelect') { state.patch = e.target.value; render(); }
    if (e.target.matches('[data-check]')) {
      // Храним только отмеченные пункты: снятая галочка удаляет ключ, а не пишет false.
      if (e.target.checked) state.checks[e.target.dataset.check] = true;
      else delete state.checks[e.target.dataset.check];
      saveDraft();
    }
  });
  window.addEventListener('hashchange', () => {
    if (applyHash()) { try { localStorage.setItem('dp.draft', JSON.stringify({ me: state.me, myRole: state.myRole, enemies: state.enemies, enemyMid: state.enemyMid, allies: state.allies, checks: state.checks })); } catch { /* ignore */ } render(); }
  });
}

/** Вставка из буфера обмена и перетаскивание файла на область предпросмотра. */
function bindShotDrop() {
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      state.tab = 'shot';
      render();
      shotLoadBlob(file, 'вставленный скриншот');
      return;
    }
  });
  document.addEventListener('dragover', (e) => {
    if (state.tab !== 'shot') return;
    e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (state.tab !== 'shot') return;
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    shotLoadBlob(file, file.name);
  });
}

/* ------------------------------ старт ------------------------------ */

(async function boot() {
  try {
    await loadData();
    // Сначала сохранённое из localStorage (оно подтягивает и галочки чеклиста state.checks),
    // затем applyHash() поверх: hash меняет только драфт и state.checks не трогает. Раньше
    // порядок был обратным: при наличии hash loadDraft() не вызывался, и localStorage
    // перезаписывался пустым state.checks = {} — галочки терялись при перезагрузке.
    loadDraft();
    const fromHash = applyHash();
    if (fromHash) {
      // hash — источник истины при шаринге, продублируем драфт в localStorage (checks не затираем)
      try { localStorage.setItem('dp.draft', JSON.stringify({ me: state.me, myRole: state.myRole, enemies: state.enemies, enemyMid: state.enemyMid, allies: state.allies, checks: state.checks })); } catch { /* ignore */ }
    }
    if (pruneChecks()) saveDraft(); // выкинули мусор из старых галочек — сразу фиксируем это в хранилище
    else syncHash();
    $('#patchBadge').textContent = `патч ${patchSeries()}`;
    const patchTab = $('#tabs [data-tab="patch"]');
    if (patchTab) patchTab.textContent = `Патч ${patchSeries()}`;
    document.title = `Драфт-помощник Dota 2 — патч ${patchSeries()}`;
    $('#metaLine').textContent = `серия ${patchSeries()} от ${String(DATA.meta.latestPatchDate).slice(0, 10)} · патчноуты до ${latestPatchVersion()}`
      + ` · ${DATA.meta.heroes} героев · ${DATA.meta.items} предметов`;
    bindEvents();
    bindShotDrop();
    render();
  } catch (err) {
    $('#view').innerHTML = `<div class="panel"><h2>Ошибка загрузки данных</h2>
      <p class="small">${esc(err.message)}</p>
      <p class="small muted">Запусти сайт из корня репозитория, например: <code>python3 -m http.server 8000</code>, и открой <code>http://localhost:8000</code>.
      Файлы <code>data/*.json</code> должны быть уже собраны (см. <code>tools/build_data.mjs</code>).</p></div>`;
  }
})();
