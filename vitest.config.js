import { defineConfig } from 'vitest/config';

// Coverage over an extension with no bundler.
//
// The shared source is not imported by the tests — it is read as text and
// evaluated in a `node:vm` context, because that is how the browser loads it
// (plain <script> tags into one global scope, no exports). V8 still records
// coverage for those scripts, but only if each is evaluated under its own
// `file:` URL; tests/load.js does that, and this file is what reads the
// numbers back out.
//
// What is measured is "Intention Chrome" — the variant the tests actually run.
// It is a generated copy of shared/, kept byte-identical by scripts/sync.sh
// (and `sync.sh --check` in CI), so a line covered there is that line in
// shared/. The Firefox and Apple copies are deliberately not counted: the same
// code a second and third time would say nothing new, and the parity tests
// touch only a few of their functions, so their partial numbers would be an
// artefact of the test design rather than a fact about the code.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      // Files with no test at all still appear, at 0% — a new module that
      // nobody covers should move the number, not sit outside it.
      all: true,
      include: ['Intention Chrome/*.js', 'server/src/**/*.js'],
      // The server's entry point: it binds a port and starts listening at
      // import time, so importing it is not a thing a unit test can do. What
      // it wires together (app.js, config.js, store.js) is covered directly.
      exclude: ['server/src/index.js'],
      // Set from what the suite actually reached, a couple of points below, so
      // ordinary refactoring does not fail the build but a real loss of cover
      // does. Raise them when the number rises — they are a floor, not a goal.
      thresholds: {
        statements: 65,
        branches: 77,
        functions: 68,
        lines: 65
      }
    }
  }
});
