import tseslint from 'typescript-eslint';

// Lint scope is packages/*/src only, deliberately: driver-rn-cpp/e2e, the
// doc-check scripts, and examples have no project service and join later
// if wanted (#53). The gate is `pnpm lint`, which allows no warnings at
// all: the two rules that were ratchets during the #53 cleanup are now
// errors like the rest.
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
      // Cleared in #53 phase 2 and held at error since: every remaining
      // cast and `!` in packages/*/src carries an eslint-disable line
      // saying why it is safe. Adding one means writing that line.
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
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
