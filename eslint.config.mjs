import tseslint from 'typescript-eslint';

// Lint scope is packages/*/src only, deliberately: driver-rn-cpp/e2e, the
// doc-check scripts, and examples have no project service and join later
// if wanted (#53). The gate is `pnpm lint`, which enforces a warning
// ceiling; the two warn-level rules below are ratchets, lowered package
// by package in the #53 cleanup, not permanent allowances.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/e2e/**', 'scripts/**'],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Drivers and conformance suites implement async interfaces with
      // synchronous bodies; the interface's shape is the contract, an
      // empty await would be noise.
      '@typescript-eslint/require-await': 'off',
      // Numbers in error messages and ids are fine to interpolate.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      // Ratchets (#53 phase 2): each package's cleanup turns its casts
      // into narrows or reasoned disables, then the CI warning ceiling
      // drops. `!` is the sanctioned escape for noUncheckedIndexedAccess,
      // so each one is a judgment call, not a mechanical fix.
      '@typescript-eslint/no-unsafe-type-assertion': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },
  {
    // Tests keep the unsafe-any family: they are nearly clean and should
    // stay that way. Mock construction legitimately casts
    // (`as unknown as SqliteDriver`) and references unbound vi.fn methods.
    files: ['packages/*/src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
