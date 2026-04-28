'use strict';

/**
 * tests/helpers/loadTestEnv.js
 *
 * Jest setup file that explicitly loads `tests/fixtures/.env.test` into
 * `process.env` BEFORE any test module is required.
 *
 * Why this file exists
 * --------------------
 * The original Jest configuration used `setupFiles: ['dotenv/config']`,
 * relying on dotenv's auto-loaded `node_modules/dotenv/config.js` to
 * populate `process.env`. That entry point loads `.env` from
 * `process.cwd()` by default — it does NOT load
 * `tests/fixtures/.env.test`. The intended effect (deterministic test
 * environment via `.env.test`) was therefore never actually achieved
 * by the original configuration.
 *
 * This setup file replaces that mechanism with an explicit, cross-
 * platform load of `tests/fixtures/.env.test`. Compared to alternative
 * fixes:
 *
 *   - Setting `DOTENV_CONFIG_PATH=tests/fixtures/.env.test` in npm
 *     scripts requires platform-specific syntax (POSIX shells use
 *     `KEY=VALUE cmd`, Windows `cmd.exe` uses `set KEY=VALUE && cmd`,
 *     PowerShell uses `$Env:KEY=...`), which would force adoption of
 *     `cross-env` as an additional dev dependency.
 *
 *   - Calling `dotenv.config({ path: ... })` from a single Node.js
 *     setup file works identically on every platform, requires no
 *     extra dependency, and centralizes the configuration in one
 *     well-commented location.
 *
 * Loading order
 * -------------
 * Jest invokes every entry of `setupFiles` once per worker BEFORE the
 * test framework is initialized — so before any `describe`/`it` blocks
 * register, before any test module is required, and before
 * `beforeAll`/`beforeEach` hooks run. This file's `dotenv.config()`
 * call therefore populates `process.env` for the entire worker
 * lifetime.
 *
 * Per-test mutation pattern still required
 * ----------------------------------------
 * Tests that need a *different* environment than `.env.test` (for
 * example `tests/unit/config/config.test.js` exercising production-
 * mode behavior) must continue to follow the canonical capture-and-
 * restore pattern in their own `beforeEach`/`afterEach` hooks
 * (per AAP Section 0.10.1):
 *
 *   let originalEnv;
 *   beforeEach(() => {
 *     originalEnv = { ...process.env };
 *     jest.resetModules();
 *     process.env = { ...process.env, ...productionEnv() };
 *   });
 *   afterEach(() => {
 *     process.env = originalEnv;
 *   });
 *
 * The `.env.test` values loaded by this setup file act as a
 * deterministic baseline; per-test mutation overrides specific keys
 * for specific scenarios.
 *
 * Override behavior
 * -----------------
 * `dotenv.config()` does NOT overwrite environment variables that
 * already exist in `process.env`. This means values supplied by the
 * host environment (CI runners, developer shells) take precedence
 * over the file. This is intentional — it matches dotenv's documented
 * default behavior and prevents accidental masking of CI-supplied
 * overrides.
 *
 * Tolerant failure mode
 * ---------------------
 * If `tests/fixtures/.env.test` is missing or malformed (e.g., during
 * a partial checkout or while the file is being authored), this setup
 * does NOT throw. Instead it silently skips loading and proceeds with
 * the existing `process.env`. Tests that depend on specific env
 * values mutate `process.env` directly per the canonical pattern, so
 * the absence of the file does not break the suite — it merely
 * removes the deterministic baseline.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS `require()`/`module.exports`
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - No top-level side effects beyond the `dotenv.config()` call,
 *     which is the entire purpose of the file
 *   - Defensive: tolerates missing dotenv, missing .env.test, and
 *     parse errors without throwing
 *   - No dependency on `src/**` modules — pure test infrastructure
 *
 * @module tests/helpers/loadTestEnv
 * @see https://jestjs.io/docs/configuration#setupfiles-array
 * @see https://github.com/motdotla/dotenv#-documentation
 */

const path = require('path');

/**
 * Resolve the absolute path to `tests/fixtures/.env.test`.
 *
 * Using `__dirname` (rather than `process.cwd()` or a relative string)
 * makes this resolution robust to invocation from any working
 * directory — Jest workers may set `cwd` to the repository root, a
 * package subdirectory, or `os.tmpdir()` depending on configuration,
 * so an absolute path computed from `__dirname` is the only reliable
 * approach.
 *
 * Path layout: `<repo>/tests/helpers/loadTestEnv.js` resolves
 * `<repo>/tests/fixtures/.env.test` via one parent traversal
 * (`..`) followed by descent into `fixtures/.env.test`.
 */
const ENV_TEST_PATH = path.resolve(__dirname, '..', 'fixtures', '.env.test');

/**
 * Attempt to load `.env.test`.
 *
 * The require() and config() calls are wrapped in a single try/catch
 * so that any failure mode (dotenv missing from node_modules, file
 * missing, parse error, permissions error) is swallowed and the suite
 * proceeds with the existing `process.env`.
 *
 * The `dotenv.config()` call returns an object with either a
 * `parsed` field (success) or an `error` field (failure). We do NOT
 * inspect that result — silent best-effort loading is the design
 * intent. Tests that REQUIRE specific env values must set them
 * explicitly via the canonical capture-and-restore pattern.
 */
try {
  // eslint-disable-next-line global-require
  const dotenv = require('dotenv');
  dotenv.config({ path: ENV_TEST_PATH });
} catch (err) {
  // Intentionally swallowed. Any of the following are acceptable:
  //   - dotenv not yet installed (e.g., during initial scaffold)
  //   - tests/fixtures/.env.test not yet authored
  //   - dotenv parse error in a malformed .env.test
  //
  // The test suite remains functional because every test that
  // depends on specific env values mutates `process.env` directly.
}
