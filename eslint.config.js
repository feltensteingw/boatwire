// Lint rules for BoatWire. Run with `npm run lint`; CI fails on any error.
//
// The aim is to catch real mistakes (React hook misuse, unused code, unsafe patterns), not to
// police style. Formatting is left to Prettier (`npm run format`).
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dist-e2e', 'node_modules', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // `void expr` is used on purpose for one-line mutating callbacks: (p) => void (p.name = v)
      'no-void': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Tests poke at loosely-typed saved data on purpose.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['*.config.{js,ts}', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
