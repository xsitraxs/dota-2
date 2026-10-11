/**
 * eslint.config.js — базовые правила для кодовой базы без сборщика.
 * Запуск: npm run lint  (правила: recommended + no-unused-vars/eqeqeq/no-var/prefer-const).
 */
import js from '@eslint/js';
import globals from 'globals';

/** Одинаковые правила для браузерного кода (assets/) и скриптов (tools/). */
const rules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  eqeqeq: ['error', 'smart'],
  'no-var': 'error',
  'prefer-const': 'error',
};

export default [
  { ignores: ['_site/**', 'node_modules/**'] },
  {
    files: ['assets/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules,
  },
  {
    files: ['tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules,
  },
];
