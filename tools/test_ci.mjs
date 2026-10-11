#!/usr/bin/env node
/**
 * test_ci.mjs — проверка политики публикации .github/workflows/pages.yml.
 * Запуск: node tools/test_ci.mjs (входит в npm test)
 *
 * Проверяется поведение, а не текст файла:
 *   - условия `if` job'ов и шагов вычисляются для разных событий (push в main, pull request,
 *     ручной запуск из ветки) — публикация только с main и никогда из PR;
 *   - группы конкурентности: проверка из PR не попадает в группу публикации main;
 *   - права токена: у сборки и тестов только чтение, запись (pages, id-token) — только у деплоя,
 *     который не выполняет код репозитория;
 *   - сторонние действия закреплены полными SHA;
 *   - скрипт «Detect Pages source» прогоняется в bash с поддельным `gh` для всех ответов API
 *     (workflow / legacy / 404 / 403) — ошибка API на push даёт явный сбой, а не тихий пропуск деплоя.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CI_WORKFLOW — путь к другому файлу (например, чтобы убедиться, что старая версия не проходит проверку).
const wf = parse(fs.readFileSync(process.env.CI_WORKFLOW || path.join(ROOT, '.github', 'workflows', 'pages.yml'), 'utf8'));

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};

/* ------------------------- вычисление выражений GitHub ------------------------- */

/**
 * Подмножество языка выражений GitHub Actions, которое используется в workflow:
 * пути контекстов, строки, ==, !=, !, &&, || (возвращает значение операнда), скобки.
 * Сравнение строк, как и в GitHub, без учёта регистра.
 */
function evaluate(expr, ctx) {
  const src = expr.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const tokens = [];
  const re = /\s*(?:('(?:[^']|'')*')|(==|!=|&&|\|\||!|\(|\))|(true|false|null)\b|(-?\d+(?:\.\d+)?)|([A-Za-z_][\w-]*(?:\.[\w-]+)*))/y;
  let m;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new Error(`не разобрать выражение: «${src.slice(pos)}»`);
    }
    pos = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'lit', v: m[1].slice(1, -1).replace(/''/g, "'") });
    else if (m[2] !== undefined) tokens.push({ t: m[2] });
    else if (m[3] !== undefined) tokens.push({ t: 'lit', v: m[3] === 'null' ? null : m[3] === 'true' });
    else if (m[4] !== undefined) tokens.push({ t: 'lit', v: Number(m[4]) });
    else tokens.push({ t: 'path', v: m[5] });
  }
  let i = 0;
  const peek = () => tokens[i] && tokens[i].t;
  const truthy = (v) => !(v === false || v === null || v === undefined || v === 0 || v === '');
  const equal = (a, b) => {
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
    return String(a).toLowerCase() === String(b).toLowerCase();
  };
  const lookup = (p) => p.split('.').reduce((o, k) => (o !== null && o !== undefined && typeof o === 'object' ? o[k] : null), ctx) ?? null;
  function primary() {
    const tok = tokens[i++];
    if (!tok) throw new Error('неожиданный конец выражения');
    if (tok.t === '(') { const v = or(); if (tokens[i++]?.t !== ')') throw new Error('нет закрывающей скобки'); return v; }
    if (tok.t === '!') return !truthy(primary());
    if (tok.t === 'lit') return tok.v;
    if (tok.t === 'path') return lookup(tok.v);
    throw new Error(`неожиданный токен ${tok.t}`);
  }
  function cmp() {
    let v = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = tokens[i++].t;
      const r = primary();
      v = op === '==' ? equal(v, r) : !equal(v, r);
    }
    return v;
  }
  function and() { let v = cmp(); while (peek() === '&&') { i++; const r = cmp(); v = truthy(v) ? r : v; } return v; }
  function or() { let v = and(); while (peek() === '||') { i++; const r = and(); v = truthy(v) ? v : r; } return v; }
  const value = or();
  if (i !== tokens.length) throw new Error(`лишние токены в выражении «${src}»`);
  return value;
}
const isTrue = (expr, ctx) => {
  const v = evaluate(String(expr), ctx);
  return !(v === false || v === null || v === undefined || v === 0 || v === '');
};
/** Строка с подстановками ${{ … }} (например, имя группы конкурентности). */
const template = (str, ctx) => String(str).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => String(evaluate(e, ctx) ?? ''));

const event = (name, ref, extra = {}) => ({ github: { event_name: name, ref, event: extra } });

console.log('\n1. Триггеры');
const on = wf.on || wf[true]; // «on» в YAML 1.1 может прочитаться как true — yaml 2 читает строкой
ok(Array.isArray(on.push?.branches) && on.push.branches.length === 1 && on.push.branches[0] === 'main', 'push — только в main');
ok('pull_request' in on && 'workflow_dispatch' in on, 'проверки на pull request и ручной запуск есть');
ok(!['pull_request_target', 'workflow_run', 'issue_comment'].some((k) => k in on),
  'нет триггеров, исполняющих чужой код с правами репозитория (pull_request_target, workflow_run, issue_comment)');

console.log('\n2. Права токена');
const perms = (p) => (p && typeof p === 'object' ? p : {});
const writes = (p) => Object.entries(perms(p)).filter(([, v]) => v === 'write').map(([k]) => k);
ok(wf.permissions !== undefined && writes(wf.permissions).length === 0 && wf.permissions !== 'write-all',
  'на уровне workflow прав на запись нет', JSON.stringify(wf.permissions));
const { build, deploy } = wf.jobs;
ok(build && deploy, 'есть job build и job deploy');
const buildPerms = perms(build.permissions);
ok(Object.keys(buildPerms).length > 0 && Object.values(buildPerms).every((v) => v === 'read')
  && Object.keys(buildPerms).every((k) => ['contents', 'pages'].includes(k)),
  'build (код репозитория и зависимостей): только чтение contents и pages', JSON.stringify(buildPerms));
const deployPerms = perms(deploy.permissions);
ok(JSON.stringify(Object.entries(deployPerms).sort()) === JSON.stringify([['id-token', 'write'], ['pages', 'write']]),
  'deploy: ровно pages: write и id-token: write', JSON.stringify(deployPerms));
for (const [name, job] of Object.entries(wf.jobs)) {
  if (name === 'deploy') continue;
  ok(writes(job.permissions).length === 0, `job ${name} не получает прав на запись`);
}
ok((deploy.steps || []).every((s) => !s.run && /^actions\/deploy-pages@/.test(s.uses || '')),
  'deploy не выполняет код репозитория: единственный шаг — actions/deploy-pages');
ok([].concat(deploy.needs || []).includes('build'), 'deploy ждёт успешной сборки и тестов (needs: build)');
ok((deploy.environment?.name || deploy.environment) === 'github-pages', 'деплой идёт через окружение github-pages');

console.log('\n3. Закрепление сторонних действий');
const uses = Object.values(wf.jobs).flatMap((j) => (j.steps || []).map((s) => s.uses).filter(Boolean));
ok(uses.length >= 4, `действий в workflow: ${uses.length}`);
for (const u of uses) ok(/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/.test(u), `закреплено полным SHA: ${u.split('@')[0]}`);

console.log('\n4. Условия публикации');
const scenarios = [
  ['push в main, режим workflow', event('push', 'refs/heads/main'), { deploy: 'true', pages_mode: 'workflow' }, true],
  ['ручной запуск в main', event('workflow_dispatch', 'refs/heads/main'), { deploy: 'true', pages_mode: 'workflow' }, true],
  ['pull request (даже если build сообщил deploy=true)', event('pull_request', 'refs/pull/7/merge', { pull_request: { number: 7 } }), { deploy: 'true', pages_mode: 'workflow' }, false],
  ['ручной запуск из другой ветки', event('workflow_dispatch', 'refs/heads/feature'), { deploy: 'true', pages_mode: 'workflow' }, false],
  ['push в main, Source: Deploy from a branch', event('push', 'refs/heads/main'), { deploy: 'false', pages_mode: 'legacy' }, false],
  ['push в main, Pages не включён', event('push', 'refs/heads/main'), { deploy: 'false', pages_mode: 'none' }, false],
];
for (const [label, ctx, outputs, expected] of scenarios) {
  const run = isTrue(deploy.if, { ...ctx, needs: { build: { outputs } } });
  ok(run === expected, `deploy ${expected ? 'запускается' : 'не запускается'}: ${label}`);
}
const stepIf = (name) => (build.steps.find((s) => s.name === name) || {}).if;
for (const name of ['Stage site', 'Configure Pages', 'Upload artifact']) {
  const on1 = isTrue(stepIf(name), { steps: { pages_mode: { outputs: { deploy: 'true' } } } });
  const off = isTrue(stepIf(name), { steps: { pages_mode: { outputs: { deploy: 'false' } } } });
  ok(on1 && !off, `шаг «${name}» выполняется только когда будет публикация`);
}
ok(!isTrue(stepIf('Note'), { steps: { pages_mode: { outputs: { deploy: 'true' } } } })
  && isTrue(stepIf('Note'), { steps: { pages_mode: { outputs: { deploy: 'false' } } } }), 'пояснение «Note» — в прогонах без публикации');

console.log('\n5. Конкурентность');
const prCtx = event('pull_request', 'refs/pull/7/merge', { pull_request: { number: 7 } });
const mainCtx = event('push', 'refs/heads/main');
const prGroup = template(wf.concurrency.group, prCtx);
const mainGroup = template(wf.concurrency.group, mainCtx);
ok(prGroup !== mainGroup, `проверки PR и прогоны main в разных группах (${prGroup} / ${mainGroup})`);
ok(isTrue(String(wf.concurrency['cancel-in-progress']), prCtx) && !isTrue(String(wf.concurrency['cancel-in-progress']), mainCtx),
  'новый коммит в PR отменяет устаревшую проверку, прогон main не прерывается');
const deployGroup = template(deploy.concurrency?.group || '', mainCtx);
ok(deployGroup && deployGroup !== prGroup && deploy.concurrency['cancel-in-progress'] === false,
  `деплой сериализован своей группой «${deployGroup}» и не прерывается`);

console.log('\n6. Шаги сборки');
const runs = build.steps.map((s) => s.run || '').join('\n');
const checkout = build.steps.find((s) => /^actions\/checkout@/.test(s.uses || ''));
ok(checkout?.with?.['persist-credentials'] === false, 'checkout не сохраняет токен в .git/config');
ok(/npm ci --ignore-scripts/.test(runs), 'зависимости ставятся по lock-файлу без install-скриптов');
for (const cmd of ['npm run lint', 'npm test', 'npm run test:recognize', 'npm run test:ui']) {
  ok(runs.includes(cmd), `перед публикацией выполняется ${cmd}`);
}
const order = (name) => build.steps.findIndex((s) => s.name === name);
ok(order('Detect Pages source') > order('Test UI on shipped data') && order('Upload artifact') > order('Detect Pages source'),
  'артефакт загружается только после всех проверок');

console.log('\n7. Скрипт «Detect Pages source» (bash, поддельный gh)');
const detect = build.steps.find((s) => s.id === 'pages_mode');
const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
if (bash.status !== 0) {
  ok(false, 'для проверки скрипта нужен bash');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-'));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash
case "$FAKE_GH" in
  workflow|legacy) echo "$FAKE_GH" ;;
  404) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  403) echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const runDetect = (fake, eventName, ref) => {
    const out = path.join(tmp, `out-${fake}-${eventName}`);
    fs.writeFileSync(out, '');
    const res = spawnSync('bash', ['-e', '-c', detect.run], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH: fake,
        GITHUB_OUTPUT: out, GITHUB_EVENT_NAME: eventName, GITHUB_REF: ref, GITHUB_REPOSITORY: 'owner/repo', RUNNER_TEMP: tmp,
      },
    });
    const vars = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
    return { status: res.status, ...vars, stdout: res.stdout, stderr: res.stderr };
  };
  const cases = [
    ['workflow', 'push', 'refs/heads/main', 0, 'workflow', 'true'],
    ['workflow', 'workflow_dispatch', 'refs/heads/main', 0, 'workflow', 'true'],
    ['workflow', 'pull_request', 'refs/pull/7/merge', 0, 'workflow', 'false'],
    ['workflow', 'workflow_dispatch', 'refs/heads/feature', 0, 'workflow', 'false'],
    ['legacy', 'push', 'refs/heads/main', 0, 'legacy', 'false'],
    ['404', 'push', 'refs/heads/main', 0, 'none', 'false'],
    ['403', 'pull_request', 'refs/pull/7/merge', 0, 'unknown', 'false'],
  ];
  for (const [fake, ev, ref, status, mode, dep] of cases) {
    const r = runDetect(fake, ev, ref);
    ok(r.status === status && r.mode === mode && r.deploy === dep,
      `API: ${fake}, ${ev} ${ref} → mode=${r.mode}, deploy=${r.deploy}`, r.status === status ? '' : `код выхода ${r.status}: ${r.stderr.trim()}`);
  }
  const denied = runDetect('403', 'push', 'refs/heads/main');
  // Аннотации ::error:: GitHub читает из stdout шага.
  ok(denied.status !== 0 && /::error::.*pages: read/.test(denied.stdout) && denied.deploy === undefined,
    'нет доступа к API на push в main → явная ошибка с подсказкой, а не тихий пропуск публикации');
  const note = build.steps.find((s) => s.name === 'Note');
  for (const mode of ['legacy', 'workflow', 'none', 'unknown', '']) {
    const res = spawnSync('bash', ['-e', '-c', note.run], { encoding: 'utf8', env: { ...process.env, MODE: mode } });
    ok(res.status === 0 && res.stdout.trim().length > 0, `пояснение для режима «${mode || 'пусто'}»: ${res.stdout.split('\n')[0]}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\n✗ Провалено проверок: ${failed}` : '\nПолитика CI соблюдена.');
process.exit(failed ? 1 : 0);
