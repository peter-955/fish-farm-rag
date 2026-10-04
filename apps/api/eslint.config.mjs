import base from '@ffr/config/eslint';

export default [
  ...base,
  {
    // Nest DI relies on runtime class references, so type-only import enforcement must not touch them.
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
];
