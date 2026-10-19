/**
 * eslint.config.js — базовые правила для кодовой базы без сборщика.
 * Запуск: npm run lint  (правила: recommended + no-unused-vars/eqeqeq/no-var/prefer-const).
 */
import js from '@eslint/js';
import globals from 'globals';

/** Базовые правила — без сборщика, с жёстким eqeqeq и без var. */
const baseRules = {
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
    // В браузере console.log — мусор в проде, оставляем только console.error для видимой ошибки рендера.
    rules: { ...baseRules, 'no-console': ['error', { allow: ['error', 'warn'] }] },
  },
  {
    files: ['tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: baseRules,
  },
];
