#!/usr/bin/env node
/**
 * check_data_updates.mjs — периодическая сверка собранных данных с их источником.
 *
 * Сравнивает data/meta.json (constantsVersion — версия odota/dotaconstants, из которой
 * собран data/) с текущей версией package.json источника на GitHub. Ничего не скачивает,
 * не обновляет и не публикует: только сообщает. Обновление данных — отдельное действие
 * с прогоном всех тестов (см. CONTRIBUTING), автоматически ничего не мержится.
 *
 * Коды выхода: 0 — данные актуальны; 3 — у источника новая версия; 1 — проверить не удалось.
 * Режим --json: машиночитаемый отчёт для workflow (.github/workflows/data-watch.yml).
 *
 * Запуск: node tools/check_data_updates.mjs [--json] [--source-file путь.json]
 * --source-file читает версию из локального package.json вместо сети — режим для теста
 * логики сравнения и для прогона без доступа к GitHub.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsonMode = process.argv.includes('--json');
const srcIdx = process.argv.indexOf('--source-file');
const sourceFile = srcIdx >= 0 ? process.argv[srcIdx + 1] : null;
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta.json'), 'utf8'));
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

async function ghApi(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'dota-2-data-watch',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} для ${url}`);
  return res.text();
}

const report = {
  result: 'error',
  current: meta.constantsVersion ?? null,
  remote: null,
  commit: null,
  commitDate: null,
  repo: 'https://github.com/odota/dotaconstants',
};

try {
  if (sourceFile) {
    const pkg = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    report.remote = pkg.version || null;
  } else {
    const pkg = JSON.parse(await ghApi('https://api.github.com/repos/odota/dotaconstants/contents/package.json'));
    report.remote = pkg.version || null;
    try {
      const commits = JSON.parse(await ghApi('https://api.github.com/repos/odota/dotaconstants/commits?path=package.json&per_page=1'));
      report.commit = commits[0]?.sha?.slice(0, 12) ?? null;
      report.commitDate = commits[0]?.commit?.committer?.date ?? null;
    } catch {
      /* история коммитов — вспомогательная строка, её отсутствие не роняет проверку */
    }
  }
  if (!report.remote) throw new Error('в источнике нет поля version');
  report.result = report.remote === report.current ? 'fresh' : 'update';
} catch (err) {
  report.message = err.message;
}

const exitCode = report.result === 'fresh' ? 0 : report.result === 'update' ? 3 : 1;
if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else if (report.result === 'fresh') {
  console.log(`Данные актуальны: constantsVersion ${report.current} совпадает с источником (последний коммит package.json: ${report.commitDate || '—'}, ${report.commit || '—'}).`);
} else if (report.result === 'update') {
  console.log(`Есть обновление данных: в репозитории ${report.current}, у источника ${report.remote}.`);
  console.log(`Источник: ${report.repo} (коммит package.json: ${report.commitDate || '—'}, ${report.commit || '—'}).`);
  console.log('Автоматически ничего не меняется — обновление вручную: node tools/build_data.mjs && node tools/build_templates.mjs, затем все тесты (см. CONTRIBUTING).');
} else {
  console.error(`Проверить источник не удалось: ${report.message}`);
}
process.exit(exitCode);
