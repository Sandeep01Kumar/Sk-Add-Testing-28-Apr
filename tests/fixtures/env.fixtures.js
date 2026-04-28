'use strict';

/**
 * tests/fixtures/env.fixtures.js
 *
 * Canonical environment-variable fixtures for configuration-loader and
 * logger unit tests.
 *
 * Each factory function returns a FRESH object representing one
 * environment scenario. Tests merge these into `process.env` at the
 * start of each test (and restore the original env in afterEach) to
 * exercise the configuration loader's branches without cross-test
 * pollution.
 *
 * IMPORTANT: All env-var values are STRINGS because `process.env` only
 * stores strings. The configuration loader (`src/config/index.js`) is
 * responsible for parsing these into typed values. Even when a test
 * directly assigns `process.env.PORT = 3000` (number), Node.js silently
 * coerces the value to `'3000'` (string); the fixtures here are explicit
 * about that contract so tests faithfully exercise the loader's
 * string-to-number coercion logic.
 *
 * Exports (per AAP Section 0.5.2):
 *   - validEnv()         : happy-path baseline with all vars present
 *   - invalidPortEnv()   : malformed PORT value ('abc') for validation tests
 *   - missingHostEnv()   : HOST deliberately omitted for default-fallback tests
 *   - productionEnv()    : NODE_ENV='production' for production-mode tests
 *   - developmentEnv()   : NODE_ENV='development' with debug log level
 *   - testEnv()          : NODE_ENV='test' with silent log level
 *                          (mirrors tests/fixtures/.env.test contents)
 *
 * Consumers (per AAP Section 0.5.5):
 *   - tests/unit/config/config.test.js
 *   - tests/unit/logger/logger.test.js
 *   - tests/integration/server.integration.test.js
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require()/module.exports (matches package.json's lack of
 *     "type": "module")
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline literals
 *   - Factory pattern (not singletons) per AAP 0.4.4 — each call returns
 *     a fresh object so test mutations never leak across calls
 *   - Framework-agnostic plain JavaScript — no Jest API surface
 *   - No dependency on `src/**` modules or third-party packages — pure
 *     data, importable by any test file regardless of installed packages
 *   - No mutation of `process.env` from within this module — fixtures
 *     are pure data; consuming tests perform the actual env mutation in
 *     their own beforeEach/afterEach hooks
 *
 * Usage (canonical pattern from AAP Section 0.6.2):
 *
 *   const { validEnv, invalidPortEnv } = require('../../fixtures/env.fixtures');
 *
 *   let originalEnv;
 *   beforeEach(() => {
 *     originalEnv = { ...process.env };
 *     jest.resetModules();
 *     process.env = { ...process.env, ...validEnv() };
 *   });
 *   afterEach(() => {
 *     process.env = originalEnv;
 *   });
 *
 * @module tests/fixtures/env.fixtures
 */

/**
 * Happy-path env baseline: all required variables present and valid.
 *
 * Used by tests asserting that the configuration loader returns expected
 * values when nothing is missing or malformed. The values chosen here
 * are deliberately neutral and match the AAP-documented defaults so
 * tests using this fixture observe behavior identical to the loader's
 * "all defaults" path while still exercising the explicit-value code
 * branches.
 *
 * Field rationale:
 *   - NODE_ENV='development' : most permissive default; tests can
 *                              override per-case to exercise other modes
 *   - PORT='3000'            : matches the legacy server.js port and the
 *                              loader's documented default (AAP 0.4.3)
 *   - HOST='0.0.0.0'         : matches the loader's documented default
 *                              for missing HOST (AAP 0.4.3)
 *   - LOG_LEVEL='info'       : neutral, valid log level supported by
 *                              every Winston configuration
 *
 * @returns {Object} A fresh object with NODE_ENV, PORT, HOST, LOG_LEVEL.
 */
function validEnv() {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    HOST: '0.0.0.0',
    LOG_LEVEL: 'info',
  };
}

/**
 * Env with a malformed PORT value (non-numeric).
 *
 * Used by tests asserting that the configuration loader throws a
 * validation error when PORT cannot be parsed as a positive integer.
 *
 * Per AAP Section 0.4.3, the loader must reject all of:
 *   - PORT='abc'    (non-numeric)
 *   - PORT='-1'     (out of range — negative)
 *   - PORT='70000'  (out of range — exceeds 65535)
 *
 * This fixture provides the canonical non-numeric case ('abc'). Tests
 * asserting other failure modes (negative, out-of-range) override the
 * PORT field on the returned object after the factory call:
 *
 *   const env = invalidPortEnv();
 *   env.PORT = '-1';   // negative — out of range
 *   // or
 *   env.PORT = '70000'; // exceeds 65535 — out of range
 *
 * Other fields are kept valid so the test isolates the PORT-validation
 * code path; if any other field were also invalid the test could not
 * tell which validation triggered the rejection.
 *
 * @returns {Object} A fresh env object with PORT='abc' and all other
 *   fields set to valid values.
 */
function invalidPortEnv() {
  return {
    NODE_ENV: 'development',
    PORT: 'abc',
    HOST: '0.0.0.0',
    LOG_LEVEL: 'info',
  };
}

/**
 * Env with HOST deliberately omitted.
 *
 * Used by tests asserting the default-fallback behavior of the
 * configuration loader. Per AAP Section 0.4.3, the loader must default
 * a missing HOST to '0.0.0.0'.
 *
 * The HOST property is genuinely absent from the returned object — not
 * set to `undefined`, not set to an empty string. The distinction
 * matters when tests merge this fixture into `process.env` via spread
 * (`{ ...process.env, ...missingHostEnv() }`) because:
 *
 *   - `{ HOST: undefined }` would assign the literal value `undefined`
 *     and shadow any pre-existing HOST in process.env after spread
 *     (Node coerces it back to the string `'undefined'` on read)
 *   - `{ HOST: '' }` would explicitly set HOST to the empty string,
 *     which AAP 0.4.3 mandates the loader REJECT as a validation error
 *   - Genuine omission lets the loader's "missing key" branch fire,
 *     which is the path under test
 *
 * Consuming tests should also `delete process.env.HOST` BEFORE merging
 * to guarantee absence even when the host shell happens to export HOST.
 *
 * @returns {Object} A fresh env object WITHOUT a HOST key.
 */
function missingHostEnv() {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    LOG_LEVEL: 'info',
  };
}

/**
 * Production-mode env.
 *
 * Used by tests asserting production-only behaviors:
 *   - logger uses JSON formatter (per AAP 0.4.3)
 *   - errorHandler suppresses err.stack in responses (per AAP 0.4.3)
 *   - any future production-only branches the loader/logger introduce
 *
 * LOG_LEVEL='info' matches the AAP-documented production default
 * ('info in production, debug elsewhere' per AAP 0.4.3).
 *
 * @returns {Object} A fresh env object with NODE_ENV='production'.
 */
function productionEnv() {
  return {
    NODE_ENV: 'production',
    PORT: '3000',
    HOST: '0.0.0.0',
    LOG_LEVEL: 'info',
  };
}

/**
 * Development-mode env.
 *
 * Used by tests asserting development-only behaviors:
 *   - logger uses pretty-print formatter (per AAP 0.4.3)
 *   - errorHandler exposes err.stack in responses (per AAP 0.4.3)
 *   - any future development-only branches the loader/logger introduce
 *
 * LOG_LEVEL='debug' matches the AAP-documented non-production default
 * ('info in production, debug elsewhere' per AAP 0.4.3) and ensures
 * tests using this fixture observe the verbose logging path.
 *
 * @returns {Object} A fresh env object with NODE_ENV='development' and
 *   LOG_LEVEL='debug'.
 */
function developmentEnv() {
  return {
    NODE_ENV: 'development',
    PORT: '3000',
    HOST: '0.0.0.0',
    LOG_LEVEL: 'debug',
  };
}

/**
 * Test-mode env.
 *
 * Mirrors the contents of `tests/fixtures/.env.test` exactly so that
 * tests asserting against the .env.test loader behavior have a
 * runtime-equivalent fixture. Keeping the two in sync prevents subtle
 * test-vs-runtime-config divergences when one path is updated and the
 * other is forgotten.
 *
 * Per AAP Section 0.4.4 and the dotenv file fixture description:
 *   NODE_ENV=test, PORT=3000, HOST=127.0.0.1, LOG_LEVEL=silent
 *
 * Field rationale:
 *   - NODE_ENV='test'      : signals to src/logger/index.js that the
 *                            silent transport (or Console with
 *                            silent: true) should be selected
 *   - PORT='3000'          : matches the legacy server.js port; never
 *                            actually bound during tests (Supertest
 *                            uses in-process injection)
 *   - HOST='127.0.0.1'     : loopback address — matches the legacy
 *                            server's hardcoded hostname
 *   - LOG_LEVEL='silent'   : explicit instruction to suppress all log
 *                            output during the test run, complementing
 *                            the NODE_ENV='test' transport selection
 *
 * @returns {Object} A fresh env object matching tests/fixtures/.env.test.
 */
function testEnv() {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
  };
}

module.exports = {
  validEnv,
  invalidPortEnv,
  missingHostEnv,
  productionEnv,
  developmentEnv,
  testEnv,
};
