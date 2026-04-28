/**
 * Jest configuration for the Express + Node.js test suite.
 *
 * Test discovery, environment setup, coverage collection, and coverage thresholds
 * are all defined here per the testing Agent Action Plan (Sections 0.5.4 and 0.7.1).
 *
 * Coverage targets:
 *   global  — branches 80, functions 90, lines 85, statements 85
 *   src/middleware/, src/config/, src/routes/ — branches 85, functions 100,
 *                                                lines 90, statements 90
 *
 * src/server.js is excluded from coverage because it only invokes app.listen()
 * per AAP 0.1.4 (the standard Express + Supertest separation pattern).
 *
 * Mock isolation is enforced automatically via clearMocks + restoreMocks so test
 * files do not need explicit jest.clearAllMocks()/jest.restoreAllMocks() in
 * afterEach hooks (per AAP 0.10.1).
 *
 * setupFiles loads dotenv/config which populates process.env from a .env file
 * before any test module is required (per AAP 0.5.4 and the canonical pattern
 * documented in AAP 0.2.2).
 *
 * @see https://jestjs.io/docs/configuration
 */
module.exports = {
  // -------------------------------------------------------------------------
  // Test environment
  // -------------------------------------------------------------------------
  // Node-only — the application is a server-side Express app; jsdom is not
  // required and would slow tests unnecessarily.
  testEnvironment: 'node',

  // -------------------------------------------------------------------------
  // Test discovery
  // -------------------------------------------------------------------------
  // Match every *.test.js file anywhere under a tests/ directory. Fixtures
  // (tests/fixtures/*.js) and helpers (tests/helpers/*.js) are intentionally
  // NOT matched because they lack the .test.js suffix.
  testMatch: ['**/tests/**/*.test.js'],

  // -------------------------------------------------------------------------
  // Setup and teardown
  // -------------------------------------------------------------------------
  // dotenv/config is invoked once per worker BEFORE the test framework boots,
  // so process.env is populated from .env (or DOTENV_CONFIG_PATH-overridden
  // .env.test) for every subsequent require().
  setupFiles: ['dotenv/config'],

  // -------------------------------------------------------------------------
  // Coverage collection
  // -------------------------------------------------------------------------
  // Collect coverage from every source module and the PM2 ecosystem manifest.
  // Exclude src/server.js (bootstrap-only, runs app.listen()) and node_modules.
  collectCoverageFrom: [
    'src/**/*.js',
    'ecosystem.config.js',
    '!src/server.js',
    '!**/node_modules/**'
  ],

  coverageDirectory: 'coverage',

  // text/text-summary print to stdout for terminal/CI logs; lcov produces
  // coverage/lcov.info for upload to coverage services; html produces a
  // human-readable browser at coverage/lcov-report/index.html.
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],

  // Path-based exclusions stack with the negative globs in collectCoverageFrom.
  // Keeps node_modules, coverage output, the test directory itself, and the
  // server bootstrap out of every coverage report.
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/coverage/',
    '/tests/',
    '/src/server.js'
  ],

  // -------------------------------------------------------------------------
  // Coverage thresholds (build gates)
  // -------------------------------------------------------------------------
  // Global thresholds apply to the union of all collected files. Per-path
  // thresholds apply IN ADDITION to the global thresholds — both must pass.
  // When a per-path directory does not yet contain any source files, Jest
  // emits a warning but does not fail the run; the threshold activates
  // automatically once files appear under that path.
  coverageThreshold: {
    global: { branches: 80, functions: 90, lines: 85, statements: 85 },
    './src/middleware/': { branches: 85, functions: 100, lines: 90, statements: 90 },
    './src/config/': { branches: 85, functions: 100, lines: 90, statements: 90 },
    './src/routes/': { branches: 85, functions: 100, lines: 90, statements: 90 }
  },

  // -------------------------------------------------------------------------
  // Mock cleanup (test isolation)
  // -------------------------------------------------------------------------
  // clearMocks: jest.clearAllMocks() between tests — clears mock.calls,
  //             mock.results, mock.instances, mock.contexts.
  // restoreMocks: jest.restoreAllMocks() between tests — restores any
  //               jest.spyOn() target back to its original implementation.
  clearMocks: true,
  restoreMocks: true,

  // -------------------------------------------------------------------------
  // Output and timing
  // -------------------------------------------------------------------------
  // verbose prints each individual test name during the run (useful for
  // debugging and self-documenting suites).
  verbose: true,

  // 10 seconds is generous for unit tests (which complete in <100ms) but
  // defensive against accidental real I/O or hung promises.
  testTimeout: 10000
};
