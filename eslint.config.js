// Linting, for one reason above all others: `no-undef`.
//
// This config exists because a rename touched two call sites that referenced a variable
// which only existed in a different branch of the same file. It parsed, it built, 115 tests
// passed, and it shipped to a user as "current is not defined" on the sign-in button. No
// amount of unit testing catches that cheaply, because the broken line only runs when
// someone actually signs in — but a linter catches it in milliseconds, every time.
//
// So the rule set is deliberately narrow: things that are wrong, not things that are a
// matter of taste. Style arguments belong in review, not in a build failure.

import globals from 'globals';

const correctness = {
    // The rule this file was added for.
    'no-undef': 'error',

    // A variable assigned and never read is usually half of an edit that was not finished.
    'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrors: 'none',        // `catch { }` with a deliberately ignored error is fine
        ignoreRestSiblings: true,
    }],

    // Genuine mistakes that read as intentional code.
    'no-const-assign': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-duplicate-case': 'error',
    'no-unreachable': 'error',
    'no-self-compare': 'error',
    'no-unsafe-negation': 'error',
    'no-cond-assign': ['error', 'always'],
    'no-constant-condition': ['error', { checkLoops: false }],
    'use-isnan': 'error',
    'valid-typeof': 'error',

    // `await` inside a loop is usually intended; a promise nobody waits for rarely is.
    'require-atomic-updates': 'off',
    'no-async-promise-executor': 'error',
    'no-promise-executor-return': 'error',

    // Shadowing is how a fix gets applied to the wrong variable.
    'no-shadow-restricted-names': 'error',
    eqeqeq: ['error', 'smart'],
};

export default [
    {
        ignores: ['dist/**', 'dist-electron/**', 'release/**', 'node_modules/**'],
    },

    // The renderer: a browser, with the two constants vite substitutes at build time.
    {
        files: ['src/**/*.js', 'dev/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.browser,
                __WEAVE_TARGET__: 'readonly',
                __WEAVE_VERSION__: 'readonly',
            },
        },
        rules: correctness,
    },

    // The desktop shell's main process: Node, ES modules.
    {
        files: ['electron/**/*.js', 'scripts/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
        rules: correctness,
    },

    // The preload is CommonJS by necessity — a sandboxed preload is not an ES module.
    {
        files: ['electron/**/*.cjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: { ...globals.node, ...globals.browser },
        },
        rules: correctness,
    },

    // Tests run in Node but exercise browser code, and install their own DOM shims.
    {
        files: ['test/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.browser,
                __WEAVE_TARGET__: 'readonly',
                __WEAVE_VERSION__: 'readonly',
            },
        },
        rules: correctness,
    },
];
