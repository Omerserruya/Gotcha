import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Lint configuration.
 *
 * The interesting part is `boundaries`. Without an enforced dependency
 * direction, a codebase this size reliably grows cycles - a design-system
 * primitive that imports a feature, an API client that imports a component -
 * and by the time anyone notices, untangling it is a project. Declaring the
 * layering here makes a violation a lint error on the pull request that
 * introduces it, which is the only moment it is cheap to fix.
 *
 * The direction is strictly downward:
 *
 *   app → shell → features → domain → api → config
 *          ↘ design-system (depends on nothing but itself and lib)
 *
 * `design-system` deliberately cannot import i18n. Primitives take already
 * translated strings as props, which keeps them free of product vocabulary and
 * makes them trivially testable.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  {
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['src/**'],
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app/**' },
        { type: 'shell', pattern: 'src/shell/**' },
        { type: 'features', pattern: 'src/features/**' },
        { type: 'domain', pattern: 'src/domain/**' },
        { type: 'api', pattern: 'src/api/**' },
        { type: 'auth', pattern: 'src/auth/**' },
        { type: 'tenant', pattern: 'src/tenant/**' },
        { type: 'permissions', pattern: 'src/permissions/**' },
        { type: 'realtime', pattern: 'src/realtime/**' },
        { type: 'server-state', pattern: 'src/server-state/**' },
        { type: 'forms', pattern: 'src/forms/**' },
        { type: 'url-state', pattern: 'src/url-state/**' },
        { type: 'i18n', pattern: 'src/i18n/**' },
        { type: 'design-system', pattern: 'src/design-system/**' },
        { type: 'observability', pattern: 'src/observability/**' },
        { type: 'config', pattern: 'src/config/**' },
        { type: 'lib', pattern: 'src/lib/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            {
              from: { element: { type: 'app' } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        'app',
                        'shell',
                        'features',
                        'domain',
                        'api',
                        'auth',
                        'tenant',
                        'permissions',
                        'realtime',
                        'server-state',
                        'forms',
                        'url-state',
                        'i18n',
                        'design-system',
                        'observability',
                        'config',
                        'lib',
                      ],
                    },
                  },
                },
              },
            },
            {
              from: { element: { type: 'shell' } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        'shell',
                        'design-system',
                        'i18n',
                        'auth',
                        'tenant',
                        'permissions',
                        'realtime',
                        'server-state',
                        'url-state',
                        'api',
                        'observability',
                        'config',
                        'lib',
                      ],
                    },
                  },
                },
              },
            },
            {
              from: { element: { type: 'features' } },
              allow: {
                to: {
                  element: {
                    types: {
                      anyOf: [
                        'features',
                        'domain',
                        'api',
                        'design-system',
                        'i18n',
                        'permissions',
                        'tenant',
                        'realtime',
                        'server-state',
                        'forms',
                        'url-state',
                        'observability',
                        'lib',
                      ],
                    },
                  },
                },
              },
            },
            {
              from: { element: { type: 'domain' } },
              allow: {
                to: { element: { types: { anyOf: ['domain', 'api', 'permissions', 'lib'] } } },
              },
            },
            {
              from: { element: { type: 'api' } },
              allow: {
                to: {
                  element: {
                    types: { anyOf: ['api', 'auth', 'tenant', 'config', 'observability', 'lib'] },
                  },
                },
              },
            },
            {
              from: { element: { type: 'auth' } },
              allow: {
                to: { element: { types: { anyOf: ['auth', 'config', 'observability', 'lib'] } } },
              },
            },
            {
              from: { element: { type: 'tenant' } },
              allow: { to: { element: { types: { anyOf: ['tenant', 'api', 'config', 'lib'] } } } },
            },
            {
              from: { element: { type: 'permissions' } },
              allow: { to: { element: { types: { anyOf: ['permissions', 'api', 'lib'] } } } },
            },
            {
              from: { element: { type: 'realtime' } },
              allow: {
                to: {
                  element: { types: { anyOf: ['realtime', 'config', 'observability', 'lib'] } },
                },
              },
            },
            {
              from: { element: { type: 'server-state' } },
              allow: {
                to: { element: { types: { anyOf: ['server-state', 'api', 'tenant', 'lib'] } } },
              },
            },
            {
              from: { element: { type: 'forms' } },
              allow: {
                to: {
                  element: { types: { anyOf: ['forms', 'api', 'design-system', 'i18n', 'lib'] } },
                },
              },
            },
            {
              from: { element: { type: 'url-state' } },
              allow: { to: { element: { types: { anyOf: ['url-state', 'i18n', 'lib'] } } } },
            },
            {
              from: { element: { type: 'i18n' } },
              allow: { to: { element: { types: { anyOf: ['i18n', 'lib'] } } } },
            },
            {
              from: { element: { type: 'design-system' } },
              allow: {
                to: {
                  element: { types: { anyOf: ['design-system', 'i18n', 'observability', 'lib'] } },
                },
              },
            },
            {
              from: { element: { type: 'observability' } },
              allow: {
                to: { element: { types: { anyOf: ['observability', 'api', 'config', 'lib'] } } },
              },
            },
            {
              from: { element: { type: 'config' } },
              allow: { to: { element: { types: { anyOf: ['config'] } } } },
            },
            {
              from: { element: { type: 'lib' } },
              allow: { to: { element: { types: { anyOf: ['lib'] } } } },
            },
          ],
        },
      ],
    },
  },

  {
    rules: {
      /* Logging goes through `@/observability/logger`, which redacts and
         reaches Sentry. A stray console.log in production leaks whatever was
         in scope - in this product, that can be a customer's message. */
      'no-console': 'error',
      /* `any` disables exactly the checking that makes a typed API layer
         worth having. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    files: ['**/*.test.{ts,tsx}', 'e2e/**/*.ts'],
    rules: {
      /* A test that renders a bare `<a>` is asserting on the element, not
         navigating. The Next.js link rule has nothing useful to say about it. */
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  {
    /* UI components must never reach the network directly. Every call goes
       through the API layer, so that auth, tenancy, timeouts, cancellation and
       error parsing are applied once rather than re-invented per component. */
    files: [
      'src/design-system/**/*.{ts,tsx}',
      'src/shell/**/*.{ts,tsx}',
      'src/features/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use the API layer (src/api), not fetch, inside UI code.' },
      ],
    },
  },

  /* Formatting is Prettier's job; disable every stylistic rule that fights it. */
  prettier,

  globalIgnores([
    '.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    'next-env.d.ts',
    // The design export: the source of truth for every screen, but a generated
    // artefact from the Claude Design project rather than app code.
    'design/**',
  ]),
]);

export default eslintConfig;
