#!/usr/bin/env node
/**
 * test_data_updates.mjs — проверка логики tools/check_data_updates.mjs без сети:
 * коды выхода (актуально / есть обновление / ошибка) и машиночитаемый отчёт.
 * Запуск: node tools/test_data_updates.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tools', 'check_data_updates.mjs');

let failed = 0;
const check = (cond, label, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-watch-'));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta.json'), 'utf8'));
const same = path.join(tmp, 'same.json');
const newer = path.join(tmp, 'newer.json');
const bad = path.join(tmp, 'bad.json');
fs.writeFileSync(same, JSON.stringify({ version: meta.constantsVersion }));
fs.writeFileSync(newer, JSON.stringify({ version: '999.0.0' }));
fs.writeFileSync(bad, JSON.stringify({ name: 'без поля version' }));

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT });

console.log('\nПроверка обновлений данных (офлайн-режим --source-file)');
const r1 = run('--source-file', same, '--json');
check(r1.status === 0, `совпадение версий → код 0 (фактически ${r1.status})`);
const j1 = JSON.parse(r1.stdout);
check(j1.result === 'fresh' && j1.current === meta.constantsVersion && j1.remote === meta.constantsVersion,
  'отчёт fresh: current === remote', JSON.stringify(j1));

const r2 = run('--source-file', newer, '--json');
check(r2.status === 3, `новая версия у источника → код 3 (фактически ${r2.status})`);
const j2 = JSON.parse(r2.stdout);
check(j2.result === 'update' && j2.remote === '999.0.0' && j2.current === meta.constantsVersion,
  'отчёт update: названы обе версии', JSON.stringify(j2));

const r3 = run('--source-file', bad, '--json');
check(r3.status === 1, `источник без version → код 1 (фактически ${r3.status})`);
const j3 = JSON.parse(r3.stdout);
check(j3.result === 'error' && !!j3.message, 'отчёт error с сообщением', j3.message);

const r4 = run('--source-file', path.join(tmp, 'нет-такого.json'), '--json');
check(r4.status === 1, `отсутствующий файл источника → код 1 (фактически ${r4.status})`);

const r5 = run('--source-file', newer);
check(r5.status === 3 && /Есть обновление/.test(r5.stdout) && /ничего не меняется/.test(r5.stdout),
  'человекочитаемый вывод объясняет, что автопубликации нет');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? '\nПроверка обновлений данных работает.\n' : `\nПровалено проверок: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
