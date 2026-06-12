/* ESLint config for the PredictFlow frontend (src/).
 *
 * Intentionally lean: the goal is to catch real bugs — Rules of Hooks
 * violations, undefined refs, unsafe patterns — without drowning the build in
 * style/prop-types noise. exhaustive-deps is a warning (much of the codebase
 * trims hook deps deliberately), so it informs without failing CI.
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  settings: { react: { version: 'detect' } },
  plugins: ['react', 'react-hooks'],
  extends: ['eslint:recommended'],
  rules: {
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    'react/jsx-uses-vars': 'error',
    'react/jsx-uses-react': 'off', // new JSX transform — no React import needed
    'react/react-in-jsx-scope': 'off',
    'no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
    'no-empty': ['warn', { allowEmptyCatch: true }],
  },
  overrides: [
    {
      // Vitest injects these as globals (vitest config has globals: true).
      files: ['**/*.test.js', '**/*.test.jsx', 'src/test/**'],
      globals: {
        describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly',
        vi: 'readonly',
      },
    },
  ],
  ignorePatterns: ['dist', 'node_modules', 'worker', 'coverage'],
}
