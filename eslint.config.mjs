import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        // Root-level config files are not part of tsconfig; lint them with defaults.
        projectService: { allowDefaultProject: ['*.mjs', '*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Money and FX rates are bigint / decimal strings. A float creeping in
      // through Number() or parseFloat() would silently break every amount.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: 'parseFloat is forbidden: money and rates must never be JS numbers.',
        },
      ],
    },
  },
);
