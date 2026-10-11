/**
 * app.js — интерфейс драфт-помощника.
 * Данные: data/*.json (собираются tools/build_data.mjs из игровых констант 7.41),
 * знания: data/kb/*.json (планы героев, теги, правила, тайминги).
 */
import {
  laneReport, threatsFor, combosFor, counterPicks, buildPlan, buildChecklist, checklistUniverse,
  heroDamage, heroHp, heroMana, heroArmor,
} from './analysis.js';
import { recognizeScreenshot, recognizeCells, splitRect } from './recognize.js';

const DATA = {
  heroes: {}, abilities: {}, items: {}, patchnotes: {}, icons: {}, meta: {},
  tagsKb: { vocabulary: {}, heroes: {} }, rules: { rules: {}, combos: [] },
  timings: { events: [], notes: [] }, plans: {},
  templates: null, // подписи героев для распознавания — грузятся при первом открытии вкладки
};

/** Сколько карточек предметов рисуем сразу: остальное подгружается по скроллу или кнопкой. */
const ITEM_PAGE = 60;

const state = {
  tab: 'draft',
  me: null,
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
    picks: {},        // правки распознавания: индекс ячейки → слаг героя
  },
};

const ROLE_RU = {
  Carry: 'Керри', Support: 'Саппорт', Nuker: 'Нюкер', Disabler: 'Дизейблер',
  Initiator: 'Инициатор', Durable: 'Танк', Escape: 'Эскейп', Pusher: 'Пушер',
};
const ATTR_RU = { str: 'Сила', agi: 'Ловкость', int: 'Интеллект', all: 'Универсал' };
const KIND_RU = { rune: 'Руны', objective: 'Объективы', rhythm: 'Ритм карты', neutral: 'Нейтралки' };

const $ = (sel, root = document) => root.querySelector(sel);
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

/* ------------------------------ загрузка ------------------------------ */

async function loadData() {
  const get = async (p) => {
    const res = await fetch(p);
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
    return res.json();
  };
  const [heroes, abilities, items, patchnotes, meta, icons, kbIndex, tagsKb, rules, timings] = await Promise.all([
    get('data/heroes.json'), get('data/abilities.json'), get('data/items.json'),
    get('data/patchnotes.json'), get('data/meta.json'), get('data/icons.json'),
    get('data/kb_index.json'), get('data/kb/tags.json'), get('data/kb/rules.json'), get('data/kb/timings.json'),
  ]);
  Object.assign(DATA, { heroes, abilities, items, patchnotes, meta, icons, tagsKb, rules, timings });
  for (const f of kbIndex.files) {
    if (!f.startsWith('plans')) continue;
    Object.assign(DATA.plans, await get(`data/kb/${f}`));
  }
  state.patch = Object.keys(DATA.patchnotes).sort().pop();
}

/* ------------------------------ распознавание скриншота ------------------------------ */

/** Подписи героев для распознавания: грузятся один раз и кэшируются в памяти. */
async function ensureTemplates() {
  if (DATA.templates) return DATA.templates;
  const res = await fetch('data/templates.json');
  if (!res.ok) throw new Error(`data/templates.json: HTTP ${res.status}`);
  DATA.templates = (await res.json()).heroes;
  return DATA.templates;
}

/** Уменьшенная копия кадра для предпросмотра: распознавание работает по полному изображению. */
function shotPreviewSize(image, maxW = 900) {
  const k = Math.min(1, maxW / image.width);
  return { w: Math.max(1, Math.round(image.width * k)), h: Math.max(1, Math.round(image.height * k)), k };
}

/**
 * Ячейки ручной нарезки: область и число колонок/строк берём из состояния, а по умолчанию —
 * из найденной автоматически рамки, чтобы правку можно было начать с готового результата.
 */
function shotManualCells() {
  const img = state.shot.image;
  if (!img) return [];
  const region = state.shot.region || { x: 0, y: 0, w: img.width, h: img.height };
  const cols = Math.max(1, Math.min(24, Math.round(state.shot.cols) || 1));
  const rows = Math.max(1, Math.min(24, Math.round(state.shot.rows) || 1));
  return splitRect(region, cols, rows);
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
    if (cells && cells.length && !shot.regionEdited) {
      const xs = cells.map((c) => c.rect.x);
      const ys = cells.map((c) => c.rect.y);
      const xe = cells.map((c) => c.rect.x + c.rect.w);
      const ye = cells.map((c) => c.rect.y + c.rect.h);
      shot.region = {
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xe) - Math.min(...xs), h: Math.max(...ye) - Math.min(...ys),
      };
      shot.cols = shot.result.grid.cols;
      shot.rows = shot.result.grid.rows;
    }
  }
  shot.picks = {};
}

/** Запуск распознавания с перерисовкой «идёт распознавание…» (тяжёлый проход — вне текущего кадра). */
function shotRun(options = {}) {
  const shot = state.shot;
  if (!shot.image) return;
  shot.busy = true;
  shot.error = '';
  render();
  setTimeout(() => {
    try {
      ensureTemplates().then(() => {
        shotRecognize(options);
        shot.busy = false;
        render();
      }).catch((err) => {
        shot.busy = false;
        shot.error = err.message;
        render();
      });
    } catch (err) {
      shot.busy = false;
      shot.error = err.message;
      render();
    }
  }, 30);
}

/** Итоговый список героев: правки пользователя поверх распознанных. */
function shotHeroes() {
  const shot = state.shot;
  if (!shot.result) return [];
  return shot.result.cells.map((cell, i) => ({
    index: i,
    rect: cell.rect,
    slug: shot.picks[i] !== undefined ? shot.picks[i] : cell.candidates[0].slug,
    score: cell.candidates[0].score,
    candidates: cell.candidates,
    edited: shot.picks[i] !== undefined,
  }));
}

/** Заполнение драфта по порядку ячеек: пустые слоты заполняются сверху вниз. */
function shotFill(group) {
  const heroes = shotHeroes().map((h) => h.slug).filter(Boolean);
  const slots = group === 'enemies' ? state.enemies : state.allies;
  let k = 0;
  for (let i = 0; i < slots.length && k < heroes.length; i++) {
    if (slots[i]) continue;
    slots[i] = heroes[k++];
  }
  if (group === 'enemies' && !state.enemyMid && state.enemies.filter(Boolean).length) {
    state.enemyMid = state.enemies.filter(Boolean)[0];
  }
  saveDraft();
  render();
}

/* ------------------------------ helpers ------------------------------ */

function heroBySlug(slug) {
  const h = DATA.heroes[slug];
  if (!h) return null;
  return h;
}
function iconHTML(slug, cls = '') {
  const h = DATA.heroes[slug];
  if (!h) return '';
  const file = DATA.icons[slug];
  if (file) return `<img class="${cls}" src="data/icons/${file}" alt="${esc(h.localized_name)}" loading="lazy">`;
  const color = { str: '#f0703a', agi: '#6ecf5a', int: '#5aa9e6', all: '#c9a3f5' }[h.primary_attr];
  const letters = h.localized_name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div class="ph ${cls}" style="background:${color}" title="${esc(h.localized_name)} (нет иконки)">${letters}</div>`;
}
function heroMini(slug, removable = true, slotIdx = null, group = 'enemies') {
  const h = heroBySlug(slug);
  if (!h) return '';
  return `<div class="hero-mini">
    ${iconHTML(slug)}
    <div style="min-width:0">
      <div class="nm">${esc(h.localized_name)}</div>
      <div class="rl">${ATTR_RU[h.primary_attr]} · ${h.roles.map((r) => ROLE_RU[r] || r).slice(0, 2).join(', ')}</div>
    </div>
    ${removable ? `<button data-remove="${group}:${slotIdx}" title="Убрать">✕</button>` : ''}
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
    return `<div class="item-row">
      <div style="flex:0 0 auto">${itemChip(key)}</div>
      <div>
        <div class="small">${esc(why || '')}</div>
        <div class="tiny muted">${esc(source || '')}${tags && tags.length ? ` · ${tags.map((t) => esc(DATA.tagsKb.vocabulary[t]?.title || t)).join(', ')}` : ''}${it ? ` · ${it.cost} золота` : ''}</div>
      </div>
    </div>`;
  }).join('');
}
function abilityCard(key) {
  if (/_empty\d*$/.test(key)) return ''; // служебные слоты вроде invoker_empty1
  const a = DATA.abilities[key];
  if (!a) return '';
  const meta = [
    a.dmg_type ? `тип урона: ${esc(a.dmg_type)}` : null,
    a.mc !== null && a.mc !== undefined ? `мана: ${Array.isArray(a.mc) ? a.mc.join(' / ') : a.mc}` : null,
    a.cd !== null && a.cd !== undefined ? `КД: ${Array.isArray(a.cd) ? a.cd.join(' / ') : a.cd}` : null,
    a.bkbpierce === 'Yes' ? 'пробивает BKB' : null,
    a.dispellable === 'Yes' ? 'снимается диспелом' : null,
  ].filter(Boolean).join(' · ');
  const attrib = (a.attrib || []).filter((x) => x.header).slice(0, 8)
    .map((x) => `<div><i>${esc(x.header)}</i> ${esc(Array.isArray(x.value) ? x.value.join(' / ') : x.value)}</div>`).join('');
  return `<div class="ability">
    <div class="nm">${esc(a.dname || key)}</div>
    <div class="meta">${meta}</div>
    ${a.desc ? `<div class="desc">${esc(a.desc)}</div>` : ''}
    ${attrib ? `<div class="attrib">${attrib}</div>` : ''}
  </div>`;
}
function tagsOf(slug) { return (DATA.tagsKb.heroes || {})[slug] || []; }

/* ------------------------------ вкладка «Драфт» ------------------------------ */

function renderDraft() {
  const me = state.me;
  const enemies = state.enemies.filter(Boolean);
  const ctx = { tagsKb: DATA.tagsKb, rules: DATA.rules, plans: DATA.plans };
  const enemyMid = state.enemyMid && state.enemies.includes(state.enemyMid) ? state.enemyMid : guessEnemyMid(enemies);

  const lane = me && enemyMid ? laneReport(DATA.heroes[me], DATA.heroes[enemyMid], ctx) : null;
  const threats = enemies.length ? threatsFor(enemies, DATA) : [];
  const combos = enemies.length ? combosFor(enemies, DATA) : [];
  const picks = enemies.length ? counterPicks({
    enemies, enemyMid, data: DATA, limit: 6,
    exclude: [state.me, ...state.allies.filter(Boolean)],
  }) : [];
  const plan = me ? buildPlan({ heroSlug: me, enemySlugs: enemies, data: DATA }) : null;
  const checklist = buildChecklist({ threats, combos, data: DATA });

  const slot = (group, arr, i, label) => {
    const slug = arr[i];
    return slug
      ? heroMini(slug, true, i, group)
      : `<button class="slot-empty" data-pick="${group}:${i}"><span>${label}</span><span>+</span></button>`;
  };

  return `
  <div class="grid cols-2">
    <div class="stack">
      <div class="panel">
        <h2>Мой герой на миду</h2>
        ${me ? heroMini(me, false) : `<button class="slot-empty" data-pick="me:0"><span>Выбрать мидового героя</span><span>+</span></button>`}
        ${me ? `<div class="row" style="margin-top:10px">
          <button class="btn sm ghost" data-pick="me:0">Сменить</button>
          <button class="btn sm ghost" data-action="clear-me">Очистить</button>
        </div>` : ''}
      </div>

      <div class="panel">
        <h2>Вражеский драфт</h2>
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
        <h2>Свои союзники <span class="muted tiny">(не обязательно)</span></h2>
        <div class="stack">
          ${state.allies.map((s, i) => slot('allies', state.allies, i, `Союзник ${i + 1}`)).join('')}
        </div>
      </div>

      <div class="panel">
        <h2>Действия</h2>
        <div class="row">
          <button class="btn" data-action="copy">Скопировать план текстом</button>
          <button class="btn ghost" data-action="reset">Сбросить драфт</button>
        </div>
      </div>
    </div>

    <div class="stack">
      ${!me && !enemies.length ? `<div class="panel"><h2>Как пользоваться</h2>
        <ol class="tight small">
          <li>Выбери своего мидового героя.</li>
          <li>Добавь вражеский драфт — анализ сразу перестроится.</li>
          <li>Укажи, кто у них на миду, чтобы получить разбор лейна.</li>
          <li>Смотри план закупа, угрозы и рекомендации по следующим пикам.</li>
          <li>Либо вставь скриншот экрана пика на вкладке «Скриншот» — герои распознаются и подставятся сами.</li>
        </ol>
        <p class="muted small">Всё работает офлайн и на цифрах патча 7.41 — без сторонних сервисов и винрейтов.</p>
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
      </div>` : ''}

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
        <h2>Твой план: ${esc(plan.hero.localized_name)}</h2>
        ${plan.curated ? `<p class="small muted">${esc(plan.curve || '')}${plan.difficulty ? ` · сложность: ${esc(plan.difficulty)}` : ''}</p>`
          : `<p class="small muted">Для этого героя нет отдельного плана в базе — показываю универсальный мидовый закуп и адаптацию под их драфт.</p>`}
        ${plan.lane ? `<h3>Как играть лейн</h3><p class="small">${esc(plan.lane)}</p>` : ''}
        <h3>Порядок способностей</h3>
        <div class="stack small">
          ${plan.skills.map(([key, note]) => `<div class="row" style="align-items:flex-start">
            <b style="flex:0 0 200px">${esc(DATA.abilities[key]?.dname || key)}</b>
            <span class="muted">${esc(note)}</span>
          </div>`).join('')}
          ${plan.ult ? `<div class="row" style="align-items:flex-start"><b style="flex:0 0 200px">${esc(DATA.abilities[plan.ult]?.dname || 'Ультимейт')}</b><span class="muted">уровни 6 / 12 / 18</span></div>` : ''}
        </div>
        <h3>Стартовый закуп</h3>${itemRows(plan.items.start)}
        <h3>Ранний закуп</h3>${itemRows(plan.items.early)}
        <h3>Ядро</h3>${itemRows(plan.items.core)}
        <h3>Ситуативно — под их драфт</h3>${itemRows(plan.items.situational)}
        ${plan.spikes.length ? `<h3>Тайминги героя</h3><ul class="tight small">${plan.spikes.map(([t, n]) => `<li><b>${esc(t)}</b> — ${esc(n)}</li>`).join('')}</ul>` : ''}
        ${plan.tips.length ? `<h3>Практика</h3><ul class="tight small">${plan.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      </div>` : ''}

      ${picks.length ? `<div class="panel">
        <h2>Кого ещё можно взять против их драфта</h2>
        <div class="stack">
          ${picks.map((p) => `<div class="row" style="justify-content:space-between">
            <div class="row">${iconHTML(p.slug)}<b>${esc(p.name)}</b><span class="tiny muted">очки: ${p.score}</span></div>
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

function guessEnemyMid(enemies) {
  let best = null;
  let bestScore = -1;
  for (const slug of enemies) {
    const h = DATA.heroes[slug];
    if (!h) continue;
    const plan = DATA.plans[slug];
    let s = (plan?.mid ? 3 : 0) + (h.attack_type === 'Ranged' ? 1 : 0) + (h.roles.includes('Nuker') ? 1 : 0);
    if (plan?.tier === 'A') s += 1;
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

function renderHeroes() {
  const list = heroFiltered();
  const hero = state.selectedHero ? DATA.heroes[state.selectedHero] : null;
  return `
  <div class="panel">
    <div class="head row">
      <input class="search" id="heroSearch" placeholder="Поиск героя…" value="${esc(state.heroSearch)}">
      <div class="chips">
        ${['str', 'agi', 'int', 'all'].map((a) => `<button class="chip ${state.attrFilter === a ? 'active' : ''}" data-attr="${a}">${ATTR_RU[a]}</button>`).join('')}
        ${['Carry', 'Nuker', 'Initiator', 'Support', 'Disabler', 'Pusher'].map((r) => `<button class="chip ${state.roleFilter === r ? 'active' : ''}" data-role="${r}">${ROLE_RU[r]}</button>`).join('')}
        <button class="chip ${state.onlyMid ? 'active' : ''}" data-only-mid>только мидовые</button>
      </div>
    </div>
    <p class="small muted">Найдено: ${list.length}${state.heroSearch ? ` по запросу «${esc(state.heroSearch)}»` : ''}</p>
    <div class="pick-grid">
      ${list.map((h) => `<button class="pick" data-hero="${esc(h.slug)}">
        ${DATA.plans[h.slug]?.mid ? '<span class="mid">мид</span>' : ''}
        <div class="avatar">${iconHTML(h.slug)}</div>
        <div class="nm">${esc(h.localized_name)}</div>
      </button>`).join('')}
    </div>
  </div>
  ${hero ? renderHeroCard(hero) : ''}`;
}

function renderHeroCard(h) {
  const plan = DATA.plans[h.slug];
  const s = h.stats;
  const notes = h.notes || [];
  const tags = tagsOf(h.slug);
  const slots = h.slots.filter((x) => x.i <= 5 && !/_empty\d*$/.test(x.key));
  const beats = plan?.beats || [];
  const loses = plan?.loses_to || [];

  return `<div class="panel" id="heroCard">
    <div class="row" style="align-items:flex-start;gap:16px">
      <div style="flex:0 0 220px">
        <div class="avatar">${iconHTML(h.slug)}</div>
        <div class="row tiny muted" style="margin-top:6px">${ATTR_RU[h.primary_attr]} · ${esc(h.attack_type)}</div>
        <div class="row tiny muted">${h.roles.map((r) => ROLE_RU[r] || r).join(' · ')}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn sm gold" data-set-me="${esc(h.slug)}">Поставить себе в драфт</button>
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
        ${plan ? `<div class="row small" style="margin-top:10px"><span class="badge">мидовый план есть</span><span class="muted">${esc(plan.curve || '')}</span></div>` : ''}
      </div>
    </div>

    <h3>Способности</h3>
    <div class="stack">
      ${slots.map((x) => abilityCard(x.key)).join('')}
    </div>
    ${h.extra.length ? (h.extra.length > 2
      ? `<h3>Связанные способности и стойки</h3><div class="stack">${h.extra.map((k) => abilityCard(k)).join('')}</div>`
      : `<h3>Связанные способности и стойки</h3><div class="stack small muted">${h.extra.map((k) => esc(DATA.abilities[k]?.dname || k)).join(' · ')}</div>`) : ''}

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

    ${notes.length ? `<h3>Изменения в патче 7.41</h3><ul class="tight small">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
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

function itemCardHTML([, it]) {
  return `<div class="ability item-card">
    <div class="spread"><div class="nm">${esc(it.dname)}</div><div class="cost" style="color:var(--gold);font-weight:700">${it.cost ?? ''}</div></div>
    <div class="meta">${esc(it.qual || '')}${it.tier ? ` · тир ${esc(it.tier)}` : ''}${it.behavior ? ` · ${esc(it.behavior)}` : ''}</div>
    ${(it.abilities || []).map((a) => `<div class="desc"><b>${esc(a.title)}</b> <span class="muted tiny">(${a.type === 'active' ? 'актив' : 'пассив'})</span><br>${esc(a.description)}</div>`).join('')}
    ${it.notes ? `<div class="tiny muted" style="margin-top:6px">${esc(it.notes)}</div>` : ''}
    ${it.patchNotes && it.patchNotes.length ? `<div class="tiny" style="margin-top:6px;color:var(--gold)">7.41: ${it.patchNotes.slice(0, 2).map(esc).join('; ')}</div>` : ''}
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
      <span class="muted small">${list.length} предметов</span>
    </div>
    <div class="cols-3 grid" id="itemGrid">
      ${list.slice(0, shown).map(itemCardHTML).join('')}
    </div>
    ${itemsPagerHTML(list.length, shown)}
  </div>`;
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

function renderPatch() {
  const versions = Object.keys(DATA.patchnotes).sort();
  const v = state.patch && DATA.patchnotes[state.patch] ? state.patch : versions[versions.length - 1];
  state.patch = v;
  const note = DATA.patchnotes[v] || { general: [], items: {}, heroes: {} };
  const itemEntries = Object.entries(note.items || {});
  const heroEntries = Object.entries(note.heroes || {}).filter(([k]) => DATA.heroes[k]);
  const general = note.general || [];
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
        <ul class="tight">${Object.entries(obj).flatMap(([ab, arr]) => arr.map((c) => `<li><span class="muted">${esc(DATA.abilities[ab]?.dname || ab.replace(/_/g, ' '))}:</span> ${esc(c)}</li>`)).join('')}</ul>
      </div>`).join('')}</div>` : ''}
    ${misc.length ? `<h3>Прочее</h3><div class="stack small">${misc.map(([k, obj]) => `<div><b>${esc(k.replace(/_/g, ' '))}</b><ul class="tight">${Object.values(obj).flat().map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`).join('')}</div>` : ''}
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
      <li><b>Иконки героев</b> — репозиторий <a href="https://github.com/M-Hasan-Ibrahim/Dota2HeroInfoAndIcons" target="_blank" rel="noreferrer">Dota2HeroInfoAndIcons</a>.</li>
      <li><b>Патч</b>: ${esc(DATA.meta.latestPatch)} (от ${esc(String(DATA.meta.latestPatchDate).slice(0, 10))}). Героев: ${DATA.meta.heroes}, предметов: ${DATA.meta.items}.</li>
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
      и провалидирует файлы знаний (все ссылки на героев, способности и предметы). Запуск сайта: <code>python3 -m http.server 8000</code> в корне репозитория.</p>
  </div>`;
}

/* ------------------------------ рендер ------------------------------ */

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const view = $('#view');
  if (state.tab === 'draft') view.innerHTML = renderDraft();
  else if (state.tab === 'shot') { view.innerHTML = renderShot(); mountShot(); }
  else if (state.tab === 'heroes') view.innerHTML = renderHeroes();
  else if (state.tab === 'items') { view.innerHTML = renderItems(); mountItemsLazy(); }
  else if (state.tab === 'patch') view.innerHTML = renderPatch();
  else if (state.tab === 'timers') view.innerHTML = renderTimers();
  else view.innerHTML = renderAbout();
  if (state.tab !== 'items') stopItemsLazy();
  if (state.tab === 'heroes' && state.selectedHero) {
    const card = $('#heroCard');
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

/* ------------------------------ выбор героя ------------------------------ */

function openPicker(target) {
  const { group, idx } = target;
  let q = '';
  let attr = null;
  let onlyMid = group === 'me'; // для врагов и союзников показываем всех героев
  const modal = document.createElement('div');
  modal.className = 'overlay';
  modal.innerHTML = `<div class="modal">
    <div class="head row">
      <input class="search" id="pickerSearch" placeholder="Поиск героя…">
      <div class="chips" id="pickerChips">
        <button class="chip ${onlyMid ? 'active' : ''}" data-mid="1">мидовые</button>
        <button class="chip ${onlyMid ? '' : 'active'}" data-mid="0">все герои</button>
        ${['str', 'agi', 'int', 'all'].map((a) => `<button class="chip" data-attr="${a}">${ATTR_RU[a]}</button>`).join('')}
      </div>
      <button class="btn ghost" data-close>Закрыть</button>
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
      .filter((h) => !q || h.localized_name.toLowerCase().includes(q))
      .sort((a, b) => byName(a.localized_name, b.localized_name));
    $('#pickerGrid', modal).innerHTML = list.map((h) => `<button class="pick" data-choose="${esc(h.slug)}">
      ${DATA.plans[h.slug]?.mid ? '<span class="mid">мид</span>' : ''}
      <div class="avatar">${iconHTML(h.slug)}</div><div class="nm">${esc(h.localized_name)}</div>
    </button>`).join('');
  };
  draw();
  modal.addEventListener('input', (e) => { if (e.target.id === 'pickerSearch') { q = e.target.value.trim().toLowerCase(); draw(); } });
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) { modal.remove(); return; }
    const chip = e.target.closest('.chip');
    if (chip) {
      if (chip.dataset.mid !== undefined) { onlyMid = chip.dataset.mid === '1'; modal.querySelectorAll('[data-mid]').forEach((c) => c.classList.toggle('active', c === chip)); }
      else {
        attr = attr === chip.dataset.attr ? null : chip.dataset.attr;
        modal.querySelectorAll('[data-attr]').forEach((c) => c.classList.toggle('active', attr && c.dataset.attr === attr));
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
      if (group === 'enemies' && !state.enemyMid) state.enemyMid = slug;
      saveDraft();
      modal.remove();
      render();
    }
  });
}

/* ------------------------------ вкладка «Скриншот» ------------------------------ */

/** Строка результата: миниатюра ячейки, список героев и ближайшие альтернативы. */
function shotRowHTML(row) {
  const heroes = Object.values(DATA.heroes).sort((a, b) => byName(a.localized_name, b.localized_name));
  const alts = row.candidates.slice(1, 4)
    .filter((c) => c.slug !== row.slug)
    .map((c) => `<button class="chip" data-shot-alt="${row.index}:${esc(c.slug)}" title="Близость ${c.score}">${esc(DATA.heroes[c.slug]?.localized_name || c.slug)}</button>`)
    .join('');
  const unsure = !row.edited && row.score > 0.26;
  return `<div class="shot-row">
    <canvas class="shot-thumb" data-shot-thumb="${row.index}" width="52" height="52"></canvas>
    <div class="shot-info">
      <select class="shot-pick" data-shot-pick="${row.index}">
        <option value="">— не определён —</option>
        ${heroes.map((h) => `<option value="${h.slug}"${h.slug === row.slug ? ' selected' : ''}>${esc(h.localized_name)}</option>`).join('')}
      </select>
      <div class="small muted">ячейка ${row.index + 1} · близость ${row.score}${row.edited ? ' · правка' : ''}${unsure ? ' · <span class="warn">не уверен</span>' : ''}</div>
      ${alts ? `<div class="chips" style="margin-top:4px">${alts}</div>` : ''}
    </div>
  </div>`;
}

function renderShot() {
  const shot = state.shot;
  const result = shot.result;
  const rows = shotHeroes();
  const found = rows.filter((r) => r.slug).length;
  const gridInfo = result && result.grid
    ? `Сетка ${result.grid.cols}×${result.grid.rows} (${result.grid.meta.colMode}/${result.grid.meta.rowMode})`
      + `${result.confidence === null ? '' : `, уверенность ${Math.round(result.confidence * 100)}%`}`
    : (result ? 'Нарезка задана вручную.' : 'Кадр ещё не распознан.');
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
    : '<div class="shot-empty"><b>Ctrl+V</b> · перетащи файл сюда · <label class="btn sm ghost">выбрать файл<input type="file" id="shotFile" accept="image/*" hidden></label></div>'}
        </div>
        ${shot.image ? `<div class="row small muted" style="margin-top:8px">
          <span>${esc(shot.name || 'скриншот')} · ${shot.image.width}×${shot.image.height}</span>
          <button class="btn sm ghost" data-shot="reset">Другой скриншот</button>
        </div>` : ''}
        ${busy ? '<p class="small">Распознаю карточки…</p>' : ''}
        ${shot.error ? `<p class="small warn">${esc(shot.error)}</p>` : ''}
      </div>
      ${shot.image ? `
      <div class="panel">
        <h2>Сетка карточек</h2>
        <div class="row small">
          <label class="lbl">колонок <input class="num" id="shotCols" type="number" min="1" max="24" value="${shot.cols || 1}"></label>
          <label class="lbl">строк <input class="num" id="shotRows" type="number" min="1" max="24" value="${shot.rows || 1}"></label>
          <button class="btn sm" data-shot="resplit">Нарезать заново</button>
          <button class="btn sm ghost" data-shot="auto">Автопоиск</button>
        </div>
        <div class="row small" style="margin-top:6px">
          <span class="muted">область:</span>
          <label class="lbl">x <input class="num" id="shotX" type="number" min="0" value="${Math.round(shot.region ? shot.region.x : 0)}"></label>
          <label class="lbl">y <input class="num" id="shotY" type="number" min="0" value="${Math.round(shot.region ? shot.region.y : 0)}"></label>
          <label class="lbl">ш <input class="num" id="shotW" type="number" min="1" value="${Math.round(shot.region ? shot.region.w : shot.image.width)}"></label>
          <label class="lbl">в <input class="num" id="shotH" type="number" min="1" value="${Math.round(shot.region ? shot.region.h : shot.image.height)}"></label>
        </div>
        <p class="small muted">${gridInfo}. Если автопоиск ошибся, задай колонки, строки и область вручную —
          удобно нарезать по одному ряду карточек (например, ряд одной команды) и заполнять драфт по частям.</p>
      </div>` : ''}
    </div>
    <div class="stack">
      ${result ? `
      <div class="panel">
        <h2>Распознано героев: ${found} из ${rows.length}</h2>
        <div class="stack" id="shotList">${rows.map((r) => shotRowHTML(r)).join('')}</div>
        <div class="row" style="margin-top:10px">
          <button class="btn sm" data-shot="fill-enemies">В противники</button>
          <button class="btn sm" data-shot="fill-allies">В союзники</button>
          <button class="btn sm ghost" data-shot="open-draft">Открыть драфт</button>
        </div>
        <p class="small muted">Заполняются пустые слоты драфта по порядку ячеек. Любого героя можно
          поправить списком или кнопкой-альтернативой, затем пересобрать драфт кнопкой ещё раз.</p>
      </div>` : `
      <div class="panel">
        <h2>Как это работает</h2>
        <ol class="small" style="margin:0;padding-left:18px">
          <li>Кадр уменьшается до рабочих 32×32 на ячейку и превращается в «подпись»: разностный хеш
            (dHash) и средние цвета.</li>
          <li>Сетка карточек ищется по профилям яркости и градиента, затем фаза сетки подгоняется
            по узнаваемости карточек.</li>
          <li>Каждая ячейка сравнивается с локальными иконками всех героев; в ответе — ближайшие
            кандидаты, так что ошибку видно и легко поправить руками.</li>
        </ol>
      </div>`}
    </div>
  </div>`;
}

/** Рисует предпросмотр: кадр, найденную сетку и миниатюры ячеек. */
function mountShot() {
  const shot = state.shot;
  if (state.tab !== 'shot' || !shot.image) return;
  try {
    const preview = document.getElementById('shotPreview');
    if (preview) {
      const size = shotPreviewSize(shot.image);
      preview.width = size.w;
      preview.height = size.h;
      const ctx = preview.getContext && preview.getContext('2d');
      const src = document.createElement('canvas');
      src.width = shot.image.width;
      src.height = shot.image.height;
      const sctx = src.getContext && src.getContext('2d');
      if (ctx && sctx) {
        sctx.putImageData(new ImageData(new Uint8ClampedArray(shot.image.data), shot.image.width, shot.image.height), 0, 0);
        ctx.drawImage(src, 0, 0, size.w, size.h);
        const rows = shotHeroes();
        ctx.lineWidth = 2;
        for (const row of rows) {
          const r = row.rect;
          ctx.strokeStyle = row.slug ? 'rgba(110, 207, 90, 0.95)' : 'rgba(240, 112, 58, 0.95)';
          ctx.fillStyle = 'rgba(110, 207, 90, 0.12)';
          ctx.fillRect(r.x * size.k, r.y * size.k, r.w * size.k, r.h * size.k);
          ctx.strokeRect(r.x * size.k, r.y * size.k, r.w * size.k, r.h * size.k);
        }
      }
      const thumbs = document.querySelectorAll('[data-shot-thumb]');
      for (const el of thumbs) {
        const row = shotHeroes()[Number(el.dataset.shotThumb)];
        if (!row) continue;
        const tctx = el.getContext && el.getContext('2d');
        if (!tctx) continue;
        const r = row.rect;
        const side = Math.min(r.w, r.h);
        const crop = { x: r.x + (r.w - side) / 2, y: r.y + (r.h - side) / 2, w: side, h: side };
        const sc = document.createElement('canvas');
        sc.width = shot.image.width;
        sc.height = shot.image.height;
        const sctx = sc.getContext && sc.getContext('2d');
        if (!sctx) continue;
        sctx.putImageData(new ImageData(new Uint8ClampedArray(shot.image.data), shot.image.width, shot.image.height), 0, 0);
        tctx.drawImage(sc, crop.x, crop.y, crop.w, crop.h, 0, 0, el.width, el.height);
      }
    }
  } catch { /* нет canvas (jsdom) — предпросмотр просто не рисуется */ }
}

/** Кладёт пиксели кадра в состояние и запускает распознавание. */
function shotUseImage(image, name = 'скриншот') {
  const shot = state.shot;
  shot.image = image;
  shot.name = name;
  shot.result = null;
  shot.picks = {};
  shot.region = null;
  shot.manual = false;
  shot.error = '';
  shotRun();
}

/** Разбор файла/вставки: File → пиксели через canvas. */
async function shotLoadBlob(blob, name) {
  const shot = state.shot;
  try {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('формат изображения не поддержан'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    shotUseImage({ width: data.width, height: data.height, data: new Uint8Array(data.data) }, name);
  } catch (err) {
    shot.error = `Не удалось прочитать изображение: ${err.message}`;
    render();
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
      me: state.me, enemies: state.enemies, enemyMid: state.enemyMid, allies: state.allies, checks: state.checks,
    }));
  } catch { /* приватный режим — просто не сохраняем */ }
}
function loadDraft() {
  try {
    const raw = JSON.parse(localStorage.getItem('dp.draft') || 'null');
    if (!raw) return;
    // Сохранённое состояние могло быть записано другой версией или испорчено —
    // принимаем только известных героев и корректные массивы, иначе рендер упадёт.
    const valid = (s) => (typeof s === 'string' && DATA.heroes[s] ? s : null);
    const arr = (list, n) => {
      const out = (Array.isArray(list) ? list : []).slice(0, n).map(valid);
      while (out.length < n) out.push(null);
      return out;
    };
    state.me = valid(raw.me);
    state.enemies = arr(raw.enemies, 5);
    state.enemyMid = valid(raw.enemyMid);
    state.allies = arr(raw.allies, 4);
    state.checks = raw.checks && typeof raw.checks === 'object' && !Array.isArray(raw.checks) ? raw.checks : {};
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
  const lines = ['=== План на игру (Dota 2, патч ' + DATA.meta.latestPatch + ') ==='];
  if (state.me) lines.push(`Мой герой: ${DATA.heroes[state.me]?.localized_name || state.me}`);
  if (enemies.length) lines.push(`Враги: ${enemies.map((s) => DATA.heroes[s]?.localized_name || s).join(', ')}`);
  if (state.me && enemyMid) {
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
    const plan = buildPlan({ heroSlug: state.me, enemySlugs: enemies, data: DATA });
    lines.push('\nЗАКУП:');
    for (const g of ['start', 'early', 'core', 'situational']) {
      const arr = plan.items[g];
      if (!arr.length) continue;
      lines.push(`  ${g === 'start' ? 'старт' : g === 'early' ? 'ранний' : g === 'core' ? 'ядро' : 'ситуативно'}: ${arr.map((i) => DATA.items[i.key]?.dname || i.key).join(', ')}`);
    }
    if (plan.skills.length) lines.push('\nСПОСОБНОСТИ: ' + plan.skills.map(([k]) => DATA.abilities[k]?.dname || k).join(' → '));
  }
  if (DATA.timings.plan_summary) lines.push('\nТАЙМИНГИ: ' + DATA.timings.plan_summary);
  return lines.join('\n');
}

/* ------------------------------ события ------------------------------ */

function bindEvents() {
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
        state.shot = { ...state.shot, image: null, result: null, picks: {}, region: null, regionEdited: false, error: '' };
        render();
        return;
      }
      if (act === 'auto') { shotRun({ manual: false }); return; }
      if (act === 'resplit') {
        const shot = state.shot;
        shot.cols = Math.max(1, Number($('#shotCols')?.value) || shot.cols || 1);
        shot.rows = Math.max(1, Number($('#shotRows')?.value) || shot.rows || 1);
        if (shot.image) {
          const img = shot.image;
          const px = Number($('#shotX')?.value);
          const py = Number($('#shotY')?.value);
          const pw = Number($('#shotW')?.value);
          const ph = Number($('#shotH')?.value);
          shot.region = {
            x: Math.max(0, Math.min(img.width - 1, Number.isFinite(px) ? px : 0)),
            y: Math.max(0, Math.min(img.height - 1, Number.isFinite(py) ? py : 0)),
            w: Math.max(1, Math.min(img.width, Number.isFinite(pw) && pw > 0 ? pw : img.width)),
            h: Math.max(1, Math.min(img.height, Number.isFinite(ph) && ph > 0 ? ph : img.height)),
          };
          shot.regionEdited = true;
        }
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
      state.shot.picks[Number(idx)] = slug;
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
    if (setMe) { state.me = setMe.dataset.setMe; state.tab = 'draft'; saveDraft(); render(); return; }

    const heroBtn = e.target.closest('[data-hero]');
    if (heroBtn) { state.selectedHero = heroBtn.dataset.hero; render(); return; }

    const gotoHero = e.target.closest('[data-goto-hero]');
    if (gotoHero) { state.selectedHero = gotoHero.dataset.gotoHero; state.tab = 'heroes'; state.heroSearch = ''; state.onlyMid = false; render(); return; }

    const attr = e.target.closest('[data-attr]');
    if (attr && attr.closest('#view')) { state.attrFilter = state.attrFilter === attr.dataset.attr ? null : attr.dataset.attr; render(); return; }
    const role = e.target.closest('[data-role]');
    if (role) { state.roleFilter = state.roleFilter === role.dataset.role ? null : role.dataset.role; render(); return; }
    if (e.target.closest('[data-only-mid]')) { state.onlyMid = !state.onlyMid; render(); return; }

    const timerBtn = e.target.closest('[data-timer]');
    if (timerBtn) {
      const act = timerBtn.dataset.timer;
      if (act === 'start') { state.timer = { running: true, start: Date.now(), offset: state.timer.offset }; }
      else if (act === 'stop') { state.timer = { running: false, start: 0, offset: state.timer.running ? (Date.now() - state.timer.start) / 1000 + state.timer.offset : state.timer.offset }; }
      else state.timer = { running: false, start: 0, offset: 0 };
      render(); return;
    }

    const action = e.target.closest('[data-action]');
    if (action) {
      const a = action.dataset.action;
      if (a === 'reset') { state.me = null; state.enemies = [null, null, null, null, null]; state.enemyMid = null; state.allies = [null, null, null, null]; state.checks = {}; saveDraft(); render(); }
      if (a === 'clear-me') { state.me = null; saveDraft(); render(); }
      if (a === 'copy') {
        const text = planAsText();
        try { await navigator.clipboard.writeText(text); action.textContent = 'Скопировано ✓'; setTimeout(() => render(), 1200); }
        catch { window.prompt('Скопируй план:', text); }
        return;
      }
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
    if (e.target.id === 'heroSearch') { state.heroSearch = e.target.value; const pos = e.target.selectionStart; render(); const inp = $('#heroSearch'); if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); } }
    if (e.target.id === 'itemSearch') {
      state.itemSearch = e.target.value;
      state.itemsShown = ITEM_PAGE; // новый запрос — снова показываем первую порцию
      const pos = e.target.selectionStart;
      render();
      const inp = $('#itemSearch');
      if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-shot-pick]')) {
      const idx = Number(e.target.dataset.shotPick);
      if (e.target.value) state.shot.picks[idx] = e.target.value;
      else delete state.shot.picks[idx];
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
    loadDraft();
    if (pruneChecks()) saveDraft(); // выкинули мусор из старых галочек — сразу фиксируем это в хранилище
    $('#patchBadge').textContent = `патч ${DATA.meta.latestPatch}`;
    $('#metaLine').textContent = `данные от ${String(DATA.meta.latestPatchDate).slice(0, 10)} · ${DATA.meta.heroes} героев · ${DATA.meta.items} предметов`;
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
