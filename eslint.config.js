import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-electron/**',
      'release/**',
      'coverage/**',
      '.tools/**',
      '.local/**',
      'test-results/**',
      'playwright-report/**',
      'blob-report/**',
      'apps/server/src/generated/**',
    ],
  },

  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
      'no-var': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    files: [
      'apps/server/**/*.ts',
      'apps/desktop/**/*.ts',
      'packages/shared/**/*.ts',
      'e2e/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: globals.browser },
  },

  {
    files: ['apps/web/public/tunnel-sw.js'],
    languageOptions: { globals: { self: 'readonly' } },
  },

  {
    files: ['apps/server/src/http/gateway-address.ts', 'apps/server/src/http/middleware.ts'],
    rules: {
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
    },
  },

  {
    files: [
      'apps/server/src/media/attachments.ts',
      'packages/shared/src/schemas.ts',
      'packages/shared/src/tunnel.ts',
    ],
    rules: { 'no-control-regex': 'off' },
  },

  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
