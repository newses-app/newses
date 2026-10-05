import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import { createNodeResolver, importX } from 'eslint-plugin-import-x';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const server = './server/src';
const layers = (...names: string[]) => names.map((name) => `${server}/${name}`);

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/', '**/cdk.out/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['server/src/**/*.ts'],
    plugins: { 'import-x': importX },
    settings: { 'import-x/resolver-next': [createNodeResolver()] },
    rules: {
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: `${server}/core`,
              from: layers('adapters', 'api', 'entrypoints', 'importer'),
            },
            {
              target: `${server}/db`,
              from: layers('core', 'adapters', 'api', 'entrypoints', 'importer'),
            },
            { target: `${server}/adapters`, from: layers('api', 'entrypoints', 'importer') },
            { target: `${server}/api`, from: layers('adapters', 'entrypoints', 'importer') },
            { target: `${server}/importer`, from: layers('adapters', 'api', 'entrypoints') },
          ],
        },
      ],
    },
  },
  {
    files: ['server/src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['fastify', 'fastify/*', '@fastify/*', 'pg-boss', '@aws-sdk/*'],
              message: 'core must not depend on frameworks or cloud SDKs; use a port.',
            },
          ],
        },
      ],
    },
  },
  ...pluginVue.configs['flat/recommended'],
  // vue-tsc type-checks templates and scripts; type-aware lint rules cover the .ts files.
  { files: ['web/**/*.vue'], ...tseslint.configs.disableTypeChecked },
  {
    files: ['web/**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        projectService: false,
      },
    },
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['web/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
    rules: {
      'vue/multi-word-component-names': ['error', { ignores: ['App'] }],
    },
  },
  prettier,
);
