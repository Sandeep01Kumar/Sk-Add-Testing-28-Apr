'use strict';

/**
 * tests/unit/config/config.test.js
 *
 * Unit tests for the configuration loader at `src/config/index.js`.
 *
 * Test contracts verified:
 *   1. Reads PORT, HOST, NODE_ENV, LOG_LEVEL from process.env.
 *   2. Applies documented defaults when env vars are missing:
 *        - PORT       -> 3000
 *        - HOST       -> '0.0.0.0'
 *        - NODE_ENV   -> 'development'
 *        - LOG_LEVEL  -> 'info' (NODE_ENV === 'production')
 *                        'debug' (any other NODE_ENV)
 *   3. Validates env values; throws on:
 *        - non-numeric PORT (e.g. 'abc')
 *        - PORT < 1 (e.g. '-1')
 *        - PORT > 65535 (e.g. '70000')
 *        - empty HOST ('')
 *   4. Returns an object frozen via Object.freeze().
 *   5. Is idempotent across jest.resetModules() cycles.
 *
 * Test strategy (per AAP 0.5.2 and the assigned folder requirements):
 *   - Each test mutates `process.env` directly using fixture factories
 *     from `tests/fixtures/env.fixtures.js`.
 *   - `beforeEach` snapshots the pristine `process.env` (shallow copy is
 *     sufficient because env values are always strings) and calls
 *     `jest.resetModules()` so that the next `require('../../../src/config')`
 *     triggers a fresh module load reflecting the test's env mutations.
 *   - `afterEach` restores the snapshotted `process.env` to prevent
 *     mutations from leaking across tests within the same Jest worker
 *     (per AAP 0.10.1: "Never write to process.env without restoring it").
 *   - Each test re-requires the config module AFTER setting up
 *     `process.env`, because `src/config/index.js` reads env vars at
 *     module-load time and freezes the result. Without resetModules +
 *     re-require, the cached config from a prior test would mask the
 *     current test's env state.
 *
 * Why no jest.mock() calls:
 *   The configuration loader is pure: its only inputs are `process.env`
 *   and (optionally) a side-effecting `dotenv.config()` call. Tests
 *   mutate `process.env` directly rather than mocking dotenv — this
 *   tests the loader's CONTRACT in isolation, without coupling the
 *   tests to the choice of env-loading library.
 *
 * Why no Supertest, no Express, no logger imports:
 *   This file scopes assertions to the configuration loader alone.
 *   HTTP-level testing belongs in `tests/integration/` and
 *   `tests/unit/routes/`; logger testing belongs in
 *   `tests/unit/logger/logger.test.js`.
 *
 * Conventions (per AAP 0.10.1):
 *   - CommonJS require()/module.exports (no ESM, no top-level await).
 *   - Two-space indentation, single quotes, semicolons, const-by-default.
 *   - Trailing commas in multiline literals.
 *   - Block hierarchy: describe('Unit: ...') -> describe(scenario) -> it(...).
 *   - Test names follow the "should <behavior> when <condition>" form.
 *
 * Coordination note:
 *   The configuration module at `src/config/index.js` is created by the
 *   broader Express enhancement (NOT by this testing AAP). Until that
 *   file exists, every test below will fail at the
 *   `require('../../../src/config')` call with MODULE_NOT_FOUND. This
 *   is expected and acceptable per AAP Section 0.2.1 — the testing AAP
 *   and the broader enhancement are coordinated efforts. Once the
 *   loader exists with the documented contract, all tests below pass.
 *
 * @module tests/unit/config/config.test
 */

// Fixture factories from tests/fixtures/env.fixtures.js. These return
// fresh plain objects per call (factory pattern, not singletons) so test
// mutations never leak across tests through a shared reference.
//
// Per AAP 0.5.5 cross-file dependencies, all six factories are imported
// here and exercised somewhere in this file:
//   - validEnv()         -> happy path baseline
//   - invalidPortEnv()   -> PORT='abc' for the non-numeric error case
//   - missingHostEnv()   -> HOST omitted for the default-fallback case
//   - productionEnv()    -> NODE_ENV='production' for production-mode cases
//   - developmentEnv()   -> NODE_ENV='development' for dev-mode cases
//   - testEnv()          -> NODE_ENV='test' for test-mode cases
const {
  validEnv,
  invalidPortEnv,
  missingHostEnv,
  productionEnv,
  developmentEnv,
  testEnv,
} = require('../../fixtures/env.fixtures');

describe('Unit: src/config/index.js', () => {
  // `let` is used here (not `const`) because `originalEnv` is reassigned
  // in every `beforeEach`. Per AAP 0.10.1 conventions, `let` is reserved
  // for bindings that genuinely need mutation — this is one of them.
  let originalEnv;

  beforeEach(() => {
    // Snapshot the pristine env before any test-driven mutation. A
    // shallow copy is sufficient because process.env values are always
    // strings (Node coerces non-strings on assignment) and strings are
    // immutable — there is no nested state to deep-clone.
    //
    // The snapshot includes every env var inherited from the host
    // process (PATH, HOME, JEST_WORKER_ID, etc.) plus anything dotenv
    // loaded via `setupFiles: ['dotenv/config']`. Capturing all of it
    // means afterEach can restore the exact pre-test state.
    originalEnv = { ...process.env };

    // Force the next `require('../../../src/config')` to trigger a
    // fresh module load. Without this, Node's CommonJS cache would
    // return the SAME frozen object on every require(), regardless of
    // what process.env looks like at the time of the call. The config
    // module reads env vars at module-load time and freezes the result,
    // so a fresh load is the only way to observe the current env state.
    //
    // jest.resetModules() is the canonical Jest API for this purpose
    // (alternatives like `decache` or `delete require.cache[...]` are
    // less reliable across Jest versions and don't reset Jest's
    // internal module wrappers).
    jest.resetModules();
  });

  afterEach(() => {
    // Restore the pristine env so this test's mutations don't leak into
    // the next test (within the same worker) or into other test files
    // that share the worker's process. clearMocks/restoreMocks in
    // jest.config.js do NOT touch process.env, so explicit restoration
    // is mandatory per AAP 0.10.1.
    process.env = originalEnv;
  });

  // ------------------------------------------------------------------
  // Happy path
  // ------------------------------------------------------------------
  // With every documented env var present and valid, the loader must
  // return a config object that:
  //   - Exposes the canonical camelCase keys (port, host, nodeEnv, logLevel).
  //   - Has the correct value type for each key (number for port, strings
  //     for the rest).
  //   - Is frozen via Object.freeze() so callers cannot mutate it.
  //
  // These tests cover AAP 0.4.3's "Happy path" category for the config
  // module and exercise the loader's read-and-coerce code paths.
  describe('Happy path', () => {
    it('should return a config object with port, host, nodeEnv, and logLevel when all env vars are present', () => {
      // Spread-merge the fixture's values onto the existing process.env.
      // Spread (rather than assignment) preserves inherited vars like
      // PATH and HOME that downstream code may need. The fixture's
      // values overwrite the four config-relevant keys (NODE_ENV, PORT,
      // HOST, LOG_LEVEL) so the loader sees a known, deterministic env.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');

      // toMatchObject verifies that the listed keys exist with values
      // matching the asymmetric matchers (any Number / any String).
      // Using `expect.any(...)` rather than literal values keeps this
      // baseline test focused on the SHAPE/TYPE contract; subsequent
      // tests assert specific values for each key.
      expect(config).toMatchObject({
        port: expect.any(Number),
        host: expect.any(String),
        nodeEnv: expect.any(String),
        logLevel: expect.any(String),
      });
    });

    it('should return a frozen config object', () => {
      // Frozen-ness is part of the contract: callers must not be able
      // to mutate the configuration after loading. This test pairs with
      // the dedicated "Frozen-ness" describe block below; we duplicate
      // the most fundamental Object.isFrozen() assertion here so the
      // happy-path block reads as a complete contract summary.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(Object.isFrozen(config)).toBe(true);
    });

    it('should coerce PORT string to a number', () => {
      // process.env values are ALWAYS strings (Node coerces non-strings
      // to strings on assignment). The loader's contract is to coerce
      // the PORT string into a JavaScript number. We pick '8080' here
      // (a non-default value) so that the test would fail if the loader
      // accidentally hard-coded the default 3000 instead of reading the
      // env var.
      process.env = { ...process.env, ...validEnv() };
      process.env.PORT = '8080';
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(typeof config.port).toBe('number');
      expect(config.port).toBe(8080);
    });

    it('should preserve HOST as a string', () => {
      // HOST has no coercion contract — it's a string in the env and a
      // string on the config object. We pick a non-default value
      // (192.168.1.1) so the test fails if the loader were to ignore
      // the env var and hard-code '0.0.0.0'.
      process.env = { ...process.env, ...validEnv() };
      process.env.HOST = '192.168.1.1';
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(typeof config.host).toBe('string');
      expect(config.host).toBe('192.168.1.1');
    });

    it('should preserve NODE_ENV as a string', () => {
      // The loader's NODE_ENV pass-through is critical because many
      // downstream modules (logger, errorHandler, etc.) branch on its
      // value. We assert both type and value to catch a hypothetical
      // bug where the loader normalizes NODE_ENV (e.g., lowercases it
      // or strips whitespace).
      process.env = { ...process.env, ...validEnv() };
      process.env.NODE_ENV = 'production';
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(typeof config.nodeEnv).toBe('string');
      expect(config.nodeEnv).toBe('production');
    });

    it('should preserve LOG_LEVEL as a string', () => {
      // 'warn' is a valid Winston log level and not the default for any
      // NODE_ENV in this project (production defaults to 'info',
      // everything else defaults to 'debug'). Using 'warn' guarantees
      // the test detects accidental default-substitution bugs.
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'warn';
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(typeof config.logLevel).toBe('string');
      expect(config.logLevel).toBe('warn');
    });
  });

  // ------------------------------------------------------------------
  // Defaults applied when env vars are missing
  // ------------------------------------------------------------------
  // Per AAP 0.4.3, the loader applies these defaults when the
  // corresponding env var is absent:
  //   - PORT      -> 3000
  //   - HOST      -> '0.0.0.0'
  //   - NODE_ENV  -> 'development'
  //   - LOG_LEVEL -> 'info' (production) or 'debug' (anything else)
  //
  // Each test starts from a known-good env (so no other validation
  // fires), `delete`s the env var under test, then re-requires the
  // config module and asserts the documented default. We use `delete`
  // (not `process.env.X = undefined`, which Node coerces to the string
  // 'undefined') to guarantee the key is genuinely absent.
  describe('Defaults applied when env vars are missing', () => {
    it('should default PORT to 3000 when PORT is missing', () => {
      process.env = { ...process.env, ...validEnv() };
      delete process.env.PORT;
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(config.port).toBe(3000);
    });

    it('should default HOST to "0.0.0.0" when HOST is missing', () => {
      // missingHostEnv() returns an env object with HOST genuinely
      // omitted (not set to undefined or ''). After spread-merge, the
      // resulting process.env may still carry an inherited HOST from
      // the parent shell or from dotenv. We `delete` after merging to
      // guarantee absence regardless of host environment.
      process.env = { ...process.env, ...missingHostEnv() };
      delete process.env.HOST;
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(config.host).toBe('0.0.0.0');
    });

    it('should default NODE_ENV to "development" when NODE_ENV is missing', () => {
      process.env = { ...process.env, ...validEnv() };
      delete process.env.NODE_ENV;
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(config.nodeEnv).toBe('development');
    });

    it('should default LOG_LEVEL to "info" when NODE_ENV is "production" and LOG_LEVEL is missing', () => {
      // productionEnv() sets NODE_ENV='production' AND LOG_LEVEL='info'.
      // Deleting LOG_LEVEL exercises the loader's "missing LOG_LEVEL +
      // production NODE_ENV" branch which should default to 'info'.
      process.env = { ...process.env, ...productionEnv() };
      delete process.env.LOG_LEVEL;
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(config.logLevel).toBe('info');
    });

    it('should default LOG_LEVEL to "debug" when NODE_ENV is "development" and LOG_LEVEL is missing', () => {
      // developmentEnv() sets NODE_ENV='development' AND LOG_LEVEL='debug'.
      // Deleting LOG_LEVEL exercises the loader's "missing LOG_LEVEL +
      // non-production NODE_ENV" branch which should default to 'debug'.
      process.env = { ...process.env, ...developmentEnv() };
      delete process.env.LOG_LEVEL;
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(config.logLevel).toBe('debug');
    });

    it('should default LOG_LEVEL to "debug" when NODE_ENV is "test" and LOG_LEVEL is missing', () => {
      // testEnv() sets NODE_ENV='test' AND LOG_LEVEL='silent'. Deleting
      // LOG_LEVEL exercises the loader's "missing LOG_LEVEL +
      // non-production NODE_ENV" branch (test counts as non-production
      // for this purpose). Per AAP 0.4.3 the default is 'debug'.
      process.env = { ...process.env, ...testEnv() };
      delete process.env.LOG_LEVEL;
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(config.logLevel).toBe('debug');
    });
  });

  // ------------------------------------------------------------------
  // Validation errors
  // ------------------------------------------------------------------
  // Per AAP 0.4.3, the loader must REJECT and throw on:
  //   - PORT='abc'    (non-numeric)
  //   - PORT='-1'     (negative — out of range)
  //   - PORT='70000'  (above 65535 — out of range)
  //   - HOST=''       (empty string)
  //
  // We assert the FACT of throwing (via expect(...).toThrow()) without
  // coupling to a specific Error subclass, because the broader Express
  // enhancement may use Error, TypeError, ValidationError, or a custom
  // class. AAP 0.10.1 explicitly notes "the test asserts on the FACT of
  // throwing, not specific error types" for forward compatibility.
  //
  // The require() call is wrapped in a thunk because expect(...).toThrow()
  // requires a function, not a value. Calling require() directly inside
  // expect() would throw before Jest could intercept it.
  describe('Validation errors', () => {
    it('should throw when PORT is non-numeric (PORT="abc")', () => {
      // invalidPortEnv() sets PORT='abc' explicitly. Other fields stay
      // valid (HOST='0.0.0.0', NODE_ENV='development', LOG_LEVEL='info')
      // so the test isolates the PORT-validation path — if any other
      // field were also invalid we couldn't tell which validation fired.
      process.env = { ...process.env, ...invalidPortEnv() };
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../src/config');
      }).toThrow();
    });

    it('should throw when PORT is negative (PORT="-1")', () => {
      // Start from validEnv() (all fields valid) and override only PORT.
      // This isolates the negative-PORT path the same way invalidPortEnv()
      // isolates the non-numeric path — only one bad value at a time.
      process.env = { ...process.env, ...validEnv() };
      process.env.PORT = '-1';
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../src/config');
      }).toThrow();
    });

    it('should throw when PORT is out of range above max (PORT="70000")', () => {
      // 70000 exceeds the maximum TCP port number (65535). The loader
      // must reject any value > 65535. We pick 70000 because it is
      // distinctly above the cap and matches AAP 0.4.3's exact wording.
      process.env = { ...process.env, ...validEnv() };
      process.env.PORT = '70000';
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../src/config');
      }).toThrow();
    });

    it('should throw when HOST is an empty string', () => {
      // Empty HOST is a malformed configuration: there is no sensible
      // default for "HOST is explicitly set to nothing", and binding to
      // '' is platform-dependent (in some Node versions it would default
      // to all interfaces; in others it would throw). The loader must
      // treat HOST='' as a hard validation error.
      process.env = { ...process.env, ...validEnv() };
      process.env.HOST = '';
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../src/config');
      }).toThrow();
    });
  });

  // ------------------------------------------------------------------
  // Frozen-ness
  // ------------------------------------------------------------------
  // The configuration object must be frozen via Object.freeze() so that
  // application code cannot accidentally (or deliberately) mutate it at
  // runtime. Frozen-ness is asserted four ways:
  //   1. Object.isFrozen(config) returns true.
  //   2. Reassignment of an existing property leaves the value unchanged.
  //   3. Adding a new property is rejected (the property remains undefined).
  //   4. Deleting an existing property is rejected (the property persists).
  //
  // Behavior under strict mode vs non-strict mode differs:
  //   - Strict mode (Jest's default for files with 'use strict';):
  //     Mutation attempts throw TypeError.
  //   - Non-strict mode: Mutation attempts are silently ignored.
  // The try/catch wrapper handles both modes transparently — we assert
  // the EFFECT (value is unchanged / new property never appears /
  // existing property persists) regardless of which mode is active.
  describe('Frozen-ness', () => {
    it('should return an object frozen via Object.freeze()', () => {
      // The most direct assertion: Object.isFrozen() returns true on a
      // frozen object and false on a non-frozen one. This single check
      // verifies the loader's freeze() call without depending on any
      // mutation-attempt behavior.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(Object.isFrozen(config)).toBe(true);
    });

    it('should preserve top-level property values when assignment is attempted on a frozen object', () => {
      // Capture the original port value, attempt to reassign it, then
      // verify the value is unchanged. The try/catch swallows the
      // TypeError that strict mode throws on frozen-object assignment;
      // the post-attempt assertion is what actually verifies frozen-ness.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      const originalPort = config.port;
      try {
        config.port = 9999;
      } catch (err) {
        // Strict-mode TypeError on frozen-object assignment — expected;
        // intentionally swallowed because the value-preservation
        // assertion below is the real test.
      }
      expect(config.port).toBe(originalPort);
    });

    it('should not allow adding new properties to the config object', () => {
      // Attempting to add a property to a frozen object throws in
      // strict mode and is silently ignored in non-strict mode. Either
      // way, the new property must NOT exist on the config afterward.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      try {
        config.someNewProperty = 'should-not-stick';
      } catch (err) {
        // Strict-mode TypeError on add-to-frozen-object — expected.
      }
      expect(config.someNewProperty).toBeUndefined();
    });

    it('should not allow deleting existing properties from the config object', () => {
      // Attempting to delete a property from a frozen object throws in
      // strict mode and is silently ignored in non-strict mode. Either
      // way, the property must persist with its original value.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      const originalPort = config.port;
      try {
        delete config.port;
      } catch (err) {
        // Strict-mode TypeError on delete-from-frozen-object — expected.
      }
      expect(config.port).toBe(originalPort);
    });
  });

  // ------------------------------------------------------------------
  // Idempotency across jest.resetModules() cycles
  // ------------------------------------------------------------------
  // The configuration loader's behavior must be deterministic: the same
  // env always produces the same config, and a NEW env (after
  // resetModules) produces a new config reflecting the new env.
  //
  // These tests verify that:
  //   1. With unchanged env, two loads produce equal config values
  //      (same port, host, nodeEnv, logLevel).
  //   2. With env mutated between loads, the second load reflects the
  //      mutation — proving that resetModules() actually invalidates
  //      Node's CommonJS cache.
  describe('Idempotency across jest.resetModules() cycles', () => {
    it('should return consistent values for the same env across resetModules + re-require', () => {
      process.env = { ...process.env, ...validEnv() };
      // First load — capture each top-level field.
      // eslint-disable-next-line global-require
      const config1 = require('../../../src/config');
      const port1 = config1.port;
      const host1 = config1.host;
      const nodeEnv1 = config1.nodeEnv;
      const logLevel1 = config1.logLevel;

      // Force a fresh module load with the SAME env. If the loader is
      // deterministic, every field on the new config should equal the
      // original. (We compare values, not object identity, because
      // resetModules + re-require produces a NEW object instance.)
      jest.resetModules();
      // eslint-disable-next-line global-require
      const config2 = require('../../../src/config');

      expect(config2.port).toBe(port1);
      expect(config2.host).toBe(host1);
      expect(config2.nodeEnv).toBe(nodeEnv1);
      expect(config2.logLevel).toBe(logLevel1);
    });

    it('should reflect new env values after resetModules + env mutation + re-require', () => {
      // First load with PORT='4000'. Verify the loader picked it up.
      process.env = { ...process.env, ...validEnv() };
      process.env.PORT = '4000';
      // eslint-disable-next-line global-require
      const config1 = require('../../../src/config');
      expect(config1.port).toBe(4000);

      // Reset modules, mutate env, re-load. The new config must
      // reflect the new PORT — proving the cache was actually
      // invalidated and the loader re-read process.env.
      jest.resetModules();
      process.env.PORT = '5000';
      // eslint-disable-next-line global-require
      const config2 = require('../../../src/config');
      expect(config2.port).toBe(5000);
    });
  });

  // ------------------------------------------------------------------
  // Performance
  // ------------------------------------------------------------------
  // The loader has no external I/O contract: it must complete its work
  // synchronously by reading process.env, applying defaults, validating
  // values, and freezing the result. Network calls, large filesystem
  // reads, or long-running computation would violate this contract.
  //
  // AAP 0.4.3's aspirational target is "< 10ms". On real CI runners,
  // cold module load can take 15-40ms due to filesystem I/O for the
  // module file itself, JIT compilation, and Node's module-resolution
  // overhead. We use 50ms as a CI-stable upper bound that still catches
  // pathological regressions (e.g., an accidental synchronous network
  // call that takes hundreds of ms).
  describe('Performance', () => {
    it('should load the config module quickly (no external I/O)', () => {
      process.env = { ...process.env, ...validEnv() };
      // Force a cold load by resetting modules in addition to the
      // beforeEach reset. Without this, the require() call could be a
      // cache hit (~0ms) and the test would pass even if the cold load
      // were catastrophically slow.
      jest.resetModules();
      const start = Date.now();
      // eslint-disable-next-line global-require
      require('../../../src/config');
      const elapsed = Date.now() - start;

      // 50ms is the CI-safe bound; the AAP target of <10ms is an
      // aspirational ideal but not a CI requirement. A loader that
      // takes >50ms almost certainly has accidental synchronous I/O.
      expect(elapsed).toBeLessThan(50);
    });
  });

  // ------------------------------------------------------------------
  // Mode-specific configuration variants
  // ------------------------------------------------------------------
  // The three NODE_ENV modes (production, development, test) drive
  // logger transport selection, errorHandler stack-trace gating, and
  // potentially other env-aware behavior in downstream modules. These
  // tests verify that each fixture produces a config matching its
  // documented values, end-to-end through the loader.
  //
  // These tests serve as integration anchors: if the fixture or the
  // loader contract diverge, these tests will fail and pinpoint the
  // mismatch.
  describe('Mode-specific configuration variants', () => {
    it('should accept productionEnv() and return matching config', () => {
      // productionEnv() returns:
      //   NODE_ENV='production', PORT='3000', HOST='0.0.0.0', LOG_LEVEL='info'
      // The loader should pass these through to the config object with
      // PORT coerced to the number 3000.
      process.env = { ...process.env, ...productionEnv() };
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(config.nodeEnv).toBe('production');
      expect(config.port).toBe(3000);
      expect(config.host).toBe('0.0.0.0');
      expect(config.logLevel).toBe('info');
    });

    it('should accept developmentEnv() and return matching config', () => {
      // developmentEnv() returns:
      //   NODE_ENV='development', PORT='3000', HOST='0.0.0.0', LOG_LEVEL='debug'
      // Note that LOG_LEVEL='debug' here matches the AAP-documented
      // non-production default ('info' in production, 'debug' elsewhere)
      // but the fixture sets it explicitly so we verify it's preserved
      // rather than re-derived from NODE_ENV.
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(config.nodeEnv).toBe('development');
      expect(config.port).toBe(3000);
      expect(config.host).toBe('0.0.0.0');
      expect(config.logLevel).toBe('debug');
    });

    it('should accept testEnv() and return matching config', () => {
      // testEnv() returns:
      //   NODE_ENV='test', PORT='3000', HOST='127.0.0.1', LOG_LEVEL='silent'
      // The HOST='127.0.0.1' (loopback) matches the legacy server.js
      // hardcoded hostname. LOG_LEVEL='silent' instructs the logger to
      // suppress all output during the test run; this is verified
      // separately in tests/unit/logger/logger.test.js but the loader
      // must preserve the value here.
      process.env = { ...process.env, ...testEnv() };
      // eslint-disable-next-line global-require
      const config = require('../../../src/config');
      expect(config.nodeEnv).toBe('test');
      expect(config.port).toBe(3000);
      expect(config.host).toBe('127.0.0.1');
      expect(config.logLevel).toBe('silent');
    });
  });
});
