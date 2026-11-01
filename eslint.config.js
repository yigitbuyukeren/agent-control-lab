import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'release/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'], defaultProject: 'tsconfig.json' },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js', 'scripts/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['**/*.js', 'scripts/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly' } },
  },
);
