import js from '@eslint/js';
import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
    js.configs.recommended,

    // ---- Backend: Node, CommonJS (server.js, app.js, constants.js, store/) ----
    {
        files: ['server.js', 'app.js', 'constants.js', 'store/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': 'warn',
        },
    },

    // ---- Backend tests: Node, CommonJS + node:test globals ----
    {
        files: ['tests/*.test.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },

    // ---- Frontend: browser, ES modules (js/*.js) ----
    {
        files: ['js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': 'warn',
        },
    },

    // ---- Frontend tests: Node, ESM (tests/*.test.mjs importing js/*.js) ----
    {
        files: ['tests/*.test.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node },
        },
    },

    eslintConfigPrettier,

    {
        ignores: ['node_modules/**', 'coverage/**'],
    },
];
