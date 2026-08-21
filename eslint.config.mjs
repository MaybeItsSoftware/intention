// ESLint, configured around the one thing this codebase cannot check any other
// way: which globals a file is actually allowed to reference.
//
// There is no bundler here. shared/ is a set of classic scripts loaded into
// four separate global scopes, and each scope loads a different subset. A
// function called from the wrong context is not a build error — it is a
// TypeError on a user's machine, in the overlay, at the impulse moment. The
// per-file globals below are derived from the shipped manifests and pages
// (scripts/script-contexts.mjs), so `no-undef` enforces the real subsetting:
// call something the manifest does not load alongside you and the lint fails.
//
// Deliberately not a style config. Formatting is left alone; every rule here
// is one that catches a mistake.

import globals from 'globals';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { crossFileGlobals } from './scripts/script-contexts.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SHARED = join(ROOT, 'shared');

// Rules that catch a real mistake, in rough order of how much damage the
// mistake does here.
const CORRECTNESS = {
  // The whole point of the exercise.
  'no-undef': 'error',
  // A dead binding is usually a rename that missed a spot, or a call that
  // silently stopped happening. Args are noisy in this codebase's callback
  // style, so only flag ones after the last used parameter. In shared/ this
  // gets a per-file varsIgnorePattern covering the names siblings pick up off
  // the global scope — see below.
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    caughtErrors: 'none',
    varsIgnorePattern: '^_'
  }],
  // The accidental `if (x = 1)`. The deliberate form — `while ((m = re.exec()))`,
  // which page_context.js leans on — stays legal by its parentheses.
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  // Two functions of the same name in one file: the second wins, silently.
  'no-func-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  // A class referenced above its declaration throws, always. Functions and
  // `let`/`const` are left alone: this code is written top-down, and a handler
  // defined early that names a placeholder declared later is the normal shape
  // here, not a bug — it only runs once everything has loaded.
  'no-use-before-define': ['error', { functions: false, classes: true, variables: false }],
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-sparse-arrays': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  // An async function whose result nobody awaits, in a promise executor.
  'no-async-promise-executor': 'error',
  'no-await-in-loop': 'off',
  'require-atomic-updates': 'off',
  // Assigning to a `const` or to a function parameter's binding.
  'no-const-assign': 'error',
  'no-class-assign': 'error',
  'no-import-assign': 'error',
  // Silent no-ops.
  'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  // A leaked implicit global is exactly the cross-context bug this config
  // exists to catch, from the other direction.
  'no-implicit-globals': 'off',
  'no-undef-init': 'off'
};

export default [
  {
    ignores: [
      'node_modules/**',
      'build/**',
      // istanbul's own report assets, rewritten on every coverage run.
      'coverage/**',
      // Generated copies of shared/ — linting them would report every finding
      // four times, and sync.sh --check already guarantees they match.
      'Intention Chrome/**',
      'Intention Firefox/**',
      'Intention Apple/**',
      'Intention Android/**',
      'tests/harness/**'
    ]
  },

  // ---- shared/: classic scripts, one config block per file ----------------
  //
  // Each file may reference what its own context-mates declare, and nothing
  // else. The lists come from the manifests, so they cannot drift.
  ...[...crossFileGlobals(SHARED)].map(([file, { globals: visible, used }]) => ({
    files: [`shared/${file}`],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        // Service-worker globals: background.js runs as one in Chrome.
        self: 'readonly',
        importScripts: 'readonly',
        // Firefox and Safari expose the promise-based namespace alongside
        // `chrome`; the shared code feature-detects it.
        browser: 'readonly',
        // The native bridges the app WebViews inject.
        AndroidInterface: 'readonly',
        webkit: 'readonly',
        ...Object.fromEntries([...visible].map(name => [name, 'readonly']))
      }
    },
    rules: {
      ...CORRECTNESS,
      // This file's public surface: the top-level names a sibling script in
      // one of its contexts actually reads back off the global scope. Anything
      // else unused really is dead.
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        varsIgnorePattern: used.size
          ? `^(?:_|${[...used].join('|')})$`
          : '^_'
      }]
    }
  })),

  // ---- server/: real ES modules on Node ------------------------------------
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: CORRECTNESS
  },

  // ---- smoke tests: Node outside, the extension page inside ----------------
  //
  // Everything in a page.evaluate() callback runs in the browser, against the
  // real options/gate page, so those callbacks reference `chrome` and the
  // page's own functions. ESLint sees one file and cannot tell the two halves
  // apart — so the union is what it gets. That is still worth having: a smoke
  // test calling a page function that no longer exists now fails the lint
  // rather than the run.
  {
    files: ['tests/smoke/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.webextensions,
        ...Object.fromEntries(
          [...new Set([...crossFileGlobals(SHARED).values()].flatMap(e => [...e.globals]))]
            .map(name => [name, 'readonly'])
        )
      }
    },
    rules: {
      ...CORRECTNESS,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }]
    }
  },

  // ---- tests and tooling ---------------------------------------------------
  {
    files: ['tests/**/*.js', 'tests/**/*.mjs', 'scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      ...CORRECTNESS,
      // Test files legitimately declare fixtures they only use in some cases.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['commitlint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    rules: CORRECTNESS
  }
];
