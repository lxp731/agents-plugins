// ESLint flat config — minimal, pragmatic: catch real errors, don't bikeshed.
// `lib/` is hand-written source in this package (no build step), so it is linted.
import js from '@eslint/js'

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        Date: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
]
