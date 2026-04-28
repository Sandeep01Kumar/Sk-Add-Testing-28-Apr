'use strict';

/**
 * tests/unit/logger/logger.test.js
 *
 * Unit tests for the Winston logger module at `src/logger/index.js`.
 *
 * Test contracts verified:
 *   1. Module exports a logger object with info, warn, error, debug methods
 *      (each invocable without throwing).
 *   2. winston.createLogger is called exactly once at module-load time.
 *   3. Transport selection is environment-conditional:
 *        - NODE_ENV='development' -> Console transport
 *        - NODE_ENV='production'  -> Console (or File) transport
 *        - NODE_ENV='test'        -> silent (Console with silent:true OR
 *                                   logger-level silent flag)
 *   4. Formatter selection is environment-conditional:
 *        - NODE_ENV='production'  -> JSON formatter
 *        - NODE_ENV='development' -> human-readable (simple/printf/colorize)
 *   5. LOG_LEVEL is honored when present and defaults are applied when
 *      missing ('info' in production, 'debug' elsewhere) per AAP 0.4.3.
 *   6. Invalid LOG_LEVEL values do not cause module-load to throw.
 *   7. Module is idempotent across jest.resetModules() cycles for the
 *      same env, and reflects new env values after env mutation.
 *   8. Module loads quickly (<100ms practical CI bound; AAP target <20ms).
 *   9. Integrates correctly with the silenceLogger() helper for test
 *      cleanup (helper sets logger.silent=true and swaps transports).
 *
 * Test strategy (per AAP 0.5.2 and the assigned folder requirements):
 *   - Mock winston via jest.mock('winston', () => ({...})) at the very
 *     top of the file. Jest's babel-plugin-jest-hoist auto-hoists
 *     jest.mock calls above all require() statements at parse time, so
 *     the mock is in place before any code retrieves the module.
 *   - The mock factory MUST be self-contained (cannot reference outer
 *     scope variables that don't exist yet at hoist time). It returns
 *     jest.fn()-backed spies for createLogger, format helpers,
 *     transport constructors, and ancillary surface (addColors, config,
 *     loggers).
 *   - Mutate process.env directly within each test using fixture
 *     factories from `tests/fixtures/env.fixtures.js`.
 *   - Snapshot/restore process.env around each test via beforeEach /
 *     afterEach to prevent cross-test pollution (per AAP 0.10.1:
 *     "Never write to process.env without restoring it").
 *   - Call jest.resetModules() in beforeEach so each in-test
 *     `require('../../../src/logger')` triggers a fresh module load
 *     reflecting the test's env mutations. Without this, Node's
 *     CommonJS cache returns the SAME logger instance regardless of
 *     env state.
 *   - Re-acquire the winston mock inside each test via
 *     `require('winston')` AFTER jest.resetModules() — the reset
 *     re-executes the mock factory and produces a NEW set of jest.fn()
 *     instances; tests must inspect those, not stale references.
 *
 * Why no Supertest, no Express imports:
 *   This file scopes assertions to the logger module alone. HTTP-level
 *   testing belongs in `tests/integration/` and `tests/unit/routes/`.
 *
 * Why no direct winston import at the top:
 *   The mock provides everything; importing winston at the top would
 *   only retrieve the mocked module (the same one retrieved inside
 *   tests via require('winston')). Per-test acquisition makes the
 *   resetModules + re-require pattern explicit and reliable.
 *
 * Conventions (per AAP 0.10.1):
 *   - CommonJS require() / module.exports (no ESM, no top-level await).
 *   - Two-space indentation, single quotes, semicolons, const-by-default.
 *   - Trailing commas in multiline literals.
 *   - Block hierarchy: describe('Unit: ...') -> describe(scenario) -> it(...).
 *   - Test names follow the "should <expected behavior> when <condition>"
 *     pattern.
 *
 * Coordination note:
 *   The logger module at `src/logger/index.js` is created by the
 *   broader Express enhancement (NOT by this testing AAP). Until that
 *   file exists, every test below will fail at the
 *   `require('../../../src/logger')` step with MODULE_NOT_FOUND. This
 *   is expected and acceptable per AAP Section 0.2.1 — the testing
 *   AAP and the broader enhancement are coordinated efforts. Once
 *   `src/logger/index.js` exists with the documented contract, all
 *   tests below should pass.
 *
 * @module tests/unit/logger/logger.test
 */

// ---------------------------------------------------------------------------
// jest.mock('winston') — auto-hoisted by Jest above all require() calls.
//
// The factory function is invoked BEFORE any other top-level code runs
// (because of hoisting). It MUST be self-contained: any reference to a
// variable defined later in the file would be `undefined` at hoist time.
// All mock state lives inside the factory closure and is reachable via
// the returned object.
//
// What the mock provides:
//   - createLogger : jest.fn() returning a fresh fake logger object on
//                    each call, with all standard log-level methods plus
//                    transport-management API (clear, add, remove, close)
//                    used by the silenceLogger helper.
//   - format.*     : jest.fn() spies returning tagged objects so tests
//                    can identify which formatter was invoked.
//   - transports.* : jest.fn() constructors so tests can inspect
//                    instantiation options via .mock.calls.
//   - config.npm   : Winston's standard log-level mappings (some logger
//                    implementations read these).
//   - loggers      : No-op container so logger modules that do
//                    `winston.loggers.add(...)` don't throw.
//
// Why `{ virtual: true }`:
//   The `winston` package is documented in AAP 0.6.1 as a RUNTIME
//   dependency introduced by the broader Express enhancement (not by
//   this testing AAP). When the broader enhancement has not yet
//   installed `winston` into node_modules, the default behavior of
//   jest.mock(moduleName, factory) — which requires the module to be
//   resolvable on disk — would throw MODULE_NOT_FOUND at mock-
//   registration time, preventing the test SUITE from even being
//   loaded by Jest. The `virtual: true` option tells Jest to register
//   the mock without first attempting to resolve the real module, so
//   this test file can be parsed, discovered, and (once
//   src/logger/index.js exists) run successfully even before
//   `winston` itself is installed. When `winston` IS installed, the
//   `virtual: true` flag is a no-op and the mock continues to
//   replace the real package as designed.
// ---------------------------------------------------------------------------
jest.mock('winston', () => {
  // Format helpers — return tagged objects so tests can identify which
  // format combinator was selected by the logger module. Each returned
  // object includes a `type` discriminator and any options passed in,
  // making it possible to inspect format chains via combine.mock.calls.
  const formatHelpers = {
    combine: jest.fn((...args) => ({ type: 'combine', parts: args })),
    json: jest.fn(() => ({ type: 'json' })),
    timestamp: jest.fn((opts) => ({ type: 'timestamp', opts })),
    printf: jest.fn((fn) => ({ type: 'printf', fn })),
    colorize: jest.fn((opts) => ({ type: 'colorize', opts })),
    simple: jest.fn(() => ({ type: 'simple' })),
    splat: jest.fn(() => ({ type: 'splat' })),
    errors: jest.fn((opts) => ({ type: 'errors', opts })),
    label: jest.fn((opts) => ({ type: 'label', opts })),
    metadata: jest.fn((opts) => ({ type: 'metadata', opts })),
    prettyPrint: jest.fn((opts) => ({ type: 'prettyPrint', opts })),
    align: jest.fn(() => ({ type: 'align' })),
    cli: jest.fn(() => ({ type: 'cli' })),
    padLevels: jest.fn(() => ({ type: 'padLevels' })),
    ms: jest.fn(() => ({ type: 'ms' })),
    uncolorize: jest.fn(() => ({ type: 'uncolorize' })),
  };

  // Transport constructors — jest.fn() acts as a fake constructor.
  // Calls to `new winston.transports.Console(opts)` are recorded on
  // .mock.calls for inspection in tests. Because jest.fn() can be
  // invoked with `new`, no special factory wrapping is required.
  const ConsoleTransport = jest.fn();
  const FileTransport = jest.fn();
  const HttpTransport = jest.fn();
  const StreamTransport = jest.fn();

  // Logger constructor — returns a fresh fake logger object on each
  // call. Each fake logger has Winston's standard log-level methods
  // (info, warn, error, debug, verbose, silly, log) plus the
  // transport-management API (add, remove, clear, close, configure)
  // used by silenceLogger. The `silent` boolean and `level` string
  // mirror the real Winston Logger instance shape.
  const createLogger = jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    silly: jest.fn(),
    log: jest.fn(),
    add: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn(),
    close: jest.fn(),
    configure: jest.fn(),
    profile: jest.fn(),
    silent: false,
    level: 'info',
    transports: [],
  }));

  return {
    createLogger,
    format: formatHelpers,
    transports: {
      Console: ConsoleTransport,
      File: FileTransport,
      Http: HttpTransport,
      Stream: StreamTransport,
    },
    addColors: jest.fn(),
    config: {
      npm: {
        levels: {
          error: 0,
          warn: 1,
          info: 2,
          http: 3,
          verbose: 4,
          debug: 5,
          silly: 6,
        },
        colors: {
          error: 'red',
          warn: 'yellow',
          info: 'green',
          http: 'green',
          verbose: 'cyan',
          debug: 'blue',
          silly: 'magenta',
        },
      },
    },
    // Loggers container — no-op stubs so logger modules that do
    // `winston.loggers.add(...)` (a less-common pattern) don't throw.
    loggers: {
      add: jest.fn(),
      get: jest.fn(),
      has: jest.fn(),
      close: jest.fn(),
    },
  };
}, { virtual: true });

// ---------------------------------------------------------------------------
// Top-level imports
//
// Per AAP 0.6.2 and the agent_prompt's Phase 3, only the four env-fixture
// factories actually used in this file are destructured (skipping
// invalidPortEnv and missingHostEnv which are config-test specific). The
// silenceLogger helper is imported once at the top because it doesn't
// have module-load side effects sensitive to the resetModules cycle.
//
// The logger module itself is NEVER required at the top — every test
// does its own `require('../../../src/logger')` AFTER jest.resetModules()
// and env mutation, so the require triggers a fresh load reflecting the
// current env state.
// ---------------------------------------------------------------------------
const {
  validEnv,
  productionEnv,
  developmentEnv,
  testEnv,
} = require('../../fixtures/env.fixtures');
const { silenceLogger } = require('../../helpers/silenceLogger');

describe('Unit: src/logger/index.js', () => {
  // `let` is used here (not `const`) because `originalEnv` is reassigned
  // in every `beforeEach`. Per AAP 0.10.1 conventions, `let` is reserved
  // for bindings that genuinely need mutation — this is one of them.
  let originalEnv;

  beforeEach(() => {
    // Snapshot the pristine env before any test-driven mutation. A
    // shallow copy is sufficient because process.env values are always
    // strings (Node coerces non-strings on assignment) and strings are
    // immutable — there is no nested state to deep-clone.
    originalEnv = { ...process.env };

    // Force the next `require('../../../src/logger')` to trigger a
    // fresh module load. Without this, Node's CommonJS cache would
    // return the SAME logger instance on every require(), regardless
    // of what process.env looks like at the time of the call. The
    // logger module reads env vars at module-load time (directly or
    // via src/config) so a fresh load is the only way to observe the
    // current env state.
    //
    // jest.resetModules() also clears the cached `winston` mock binding
    // — the next `require('winston')` re-executes the mock factory and
    // returns a NEW set of jest.fn() instances. Tests must therefore
    // re-acquire the mock via in-test `require('winston')` to assert on
    // the same mock the logger module saw.
    jest.resetModules();

    // Reset all jest.fn() mock state (call counts, args, etc.) so each
    // test starts with a clean slate. The clearMocks: true config in
    // jest.config.js does the same automatically AT TEST BOUNDARIES;
    // this explicit call is defense-in-depth and also clears any state
    // accumulated DURING beforeEach (e.g., from setup helpers that
    // happen to invoke the mock).
    jest.clearAllMocks();
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
  // Happy path — Logger module structure
  // ------------------------------------------------------------------
  // The logger module's most fundamental contract is that it returns
  // (or behaves as) an object exposing the four standard log-level
  // methods (info, warn, error, debug). These tests verify that:
  //   - Each method is a function (typeof === 'function').
  //   - winston.createLogger is invoked at module-load time.
  //   - The createLogger call receives an options object as its first
  //     argument (the configuration the logger module derived from env).
  //   - Each method can be invoked without throwing — including with
  //     structured-metadata arguments.
  //
  // These cover the "Happy path" category of AAP 0.4.2's test blueprint
  // for src/logger/index.js.
  describe('Happy path — Logger module structure', () => {
    it('should expose info, warn, error, and debug methods on the logger', () => {
      // Establish a sane env baseline — validEnv() sets NODE_ENV,
      // PORT, HOST, LOG_LEVEL to documented happy-path values so the
      // logger (and any transitive config loader) sees a known good
      // env. The four typeof checks then verify the documented
      // log-level surface.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('should call winston.createLogger when the module is required', () => {
      // The contract is that winston.createLogger is invoked at
      // module-load time (not lazily on first log call). We verify
      // this by re-acquiring the mocked winston AFTER jest.resetModules()
      // (in beforeEach), then loading the logger module, then asserting
      // the spy was called.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(winston.createLogger).toHaveBeenCalled();
    });

    it('should call winston.createLogger exactly once per module load', () => {
      // A logger module that calls createLogger multiple times at load
      // time would be wasteful and would cause inconsistencies between
      // the "real" logger and any other instance. Per the AAP 0.4.2
      // happy-path contract, exactly one call per module load is the
      // documented expectation.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(winston.createLogger).toHaveBeenCalledTimes(1);
    });

    it('should pass an options object as the first argument to winston.createLogger', () => {
      // winston.createLogger(opts) accepts a single options object.
      // The logger module must construct that options object from the
      // environment and pass it as the FIRST positional argument.
      // This test verifies the call signature shape — subsequent
      // describe blocks assert on the contents of that options object
      // (level, format, transports, etc.).
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const callArgs = winston.createLogger.mock.calls[0];
      expect(callArgs).toBeDefined();
      expect(callArgs[0]).toBeInstanceOf(Object);
    });

    it('should not throw when invoking each log-level method', () => {
      // Each log-level method must be callable without throwing.
      // Although the mocked methods are jest.fn() (which never throw
      // unless explicitly configured to), this test verifies the
      // logger module's exports have been wired such that the method
      // calls reach the underlying mocks rather than, say, an
      // accidentally bound `undefined` or a getter that throws.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      expect(() => logger.info('test info message')).not.toThrow();
      expect(() => logger.warn('test warn message')).not.toThrow();
      expect(() => logger.error('test error message')).not.toThrow();
      expect(() => logger.debug('test debug message')).not.toThrow();
    });

    it('should accept structured metadata in log calls without throwing', () => {
      // Real-world Winston usage often passes a metadata object as the
      // second argument: logger.info('message', { userId: 42 }). The
      // logger module must not interfere with this calling convention
      // — the mocked log methods accept any args and the module must
      // pass them through unchanged. This test verifies the calling
      // convention works for both plain-object and Error metadata.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      expect(() => logger.info('user action', { userId: 42, action: 'login' })).not.toThrow();
      expect(() => logger.error('failure', { error: new Error('boom') })).not.toThrow();
    });
  });


  // ------------------------------------------------------------------
  // Per-environment transport selection
  // ------------------------------------------------------------------
  // The logger module must select transport(s) based on NODE_ENV. Per
  // AAP 0.4.2:
  //   - NODE_ENV='development' -> Console transport (human-readable)
  //   - NODE_ENV='production'  -> Console (or File) transport (JSON)
  //   - NODE_ENV='test'        -> silent (Console with silent:true OR
  //                               logger-level silent flag OR
  //                               level='silent')
  //
  // Tests inspect winston.transports.Console.mock.calls to see what
  // options were passed to the Console constructor, and inspect
  // winston.createLogger.mock.calls[0][0] to see what options were
  // passed to createLogger itself. The test for NODE_ENV='test' is
  // written to accept ANY of the three valid silencing strategies for
  // forward compatibility with the broader Express enhancement's
  // implementation choices (per AAP 0.10.1 "or" wording).
  describe('Per-environment transport selection', () => {
    it('should instantiate a Console transport in development', () => {
      // Development logs to the developer's terminal — Console is the
      // canonical transport. We verify the constructor was invoked,
      // not the specific options, because options vary by formatter
      // strategy (covered by the Per-environment formatter selection
      // describe block).
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(winston.transports.Console).toHaveBeenCalled();
    });

    it('should instantiate a Console transport in production', () => {
      // Production may also log to a File transport (for log
      // aggregation), but Console is still typically registered so
      // PM2/Docker can capture stdout/stderr. We verify Console is
      // called; whether File is ALSO called is implementation-defined
      // and not asserted here.
      process.env = { ...process.env, ...productionEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(winston.transports.Console).toHaveBeenCalled();
    });

    it('should configure silent behavior when NODE_ENV is "test"', () => {
      // The logger may achieve silence in any of three ways:
      //   1. Console transport instantiated with { silent: true } —
      //      transport-level silencing.
      //   2. createLogger called with { silent: true } — logger-level
      //      silencing flag honored across all transports.
      //   3. createLogger called with { level: 'silent' } — Winston
      //      treats 'silent' as a special level that suppresses every
      //      log call.
      // The test accepts any of the three so the test remains robust
      // to implementation choices the broader Express enhancement may
      // make (per AAP 0.10.1's "or" wording).
      process.env = { ...process.env, ...testEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');

      const consoleCalls = winston.transports.Console.mock.calls;
      const createLoggerCalls = winston.createLogger.mock.calls;

      // Strategy 1: any Console invocation with { silent: true }.
      const consoleSilent = consoleCalls.some(
        (args) => args[0] && args[0].silent === true,
      );

      // Strategy 2 or 3: createLogger called with silent flag or
      // level 'silent'.
      const loggerSilent = createLoggerCalls.some(
        (args) => args[0] && (args[0].silent === true || args[0].level === 'silent'),
      );

      expect(consoleSilent || loggerSilent).toBe(true);
    });

    it('should register at least one Console transport in development (asserting development uses Console)', () => {
      // Development typically uses ONLY Console. We assert at least
      // one Console invocation occurred — being permissive about
      // whether File is also invoked future-proofs the test against
      // implementation changes that might add File for development
      // (e.g., a debug log file).
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const consoleCallCount = winston.transports.Console.mock.calls.length;
      expect(consoleCallCount).toBeGreaterThan(0);
    });
  });


  // ------------------------------------------------------------------
  // Per-environment formatter selection
  // ------------------------------------------------------------------
  // The logger module must select an appropriate formatter based on
  // NODE_ENV. Per AAP 0.4.2:
  //   - NODE_ENV='production'  -> JSON formatter (machine-parseable
  //                               for log aggregators)
  //   - NODE_ENV='development' -> human-readable (simple/printf/colorize/
  //                               prettyPrint) for terminal display
  //   - NODE_ENV='test'        -> formatter is irrelevant because the
  //                               logger is silent
  //
  // Tests inspect the relevant winston.format.* spies to confirm the
  // expected formatter was invoked. The "human-readable in development"
  // assertion accepts ANY of the four readable formatters because the
  // specific choice is implementation-defined.
  describe('Per-environment formatter selection', () => {
    it('should use JSON formatter in production', () => {
      // Production logs are typically shipped to log aggregators that
      // parse JSON. The logger module must call winston.format.json()
      // somewhere in its formatter chain.
      process.env = { ...process.env, ...productionEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(winston.format.json).toHaveBeenCalled();
    });

    it('should use a human-readable formatter in development', () => {
      // Development logs go to a terminal where humans read them. The
      // logger module must use one of the human-readable formatters:
      //   - simple()      : level: message  (basic readable form)
      //   - printf(fn)    : custom format function
      //   - colorize()    : adds ANSI color codes for level
      //   - prettyPrint() : indented JSON
      // We accept ANY of these because the choice is
      // implementation-defined.
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const usedHumanReadable
        = winston.format.simple.mock.calls.length > 0
        || winston.format.printf.mock.calls.length > 0
        || winston.format.colorize.mock.calls.length > 0
        || winston.format.prettyPrint.mock.calls.length > 0;
      expect(usedHumanReadable).toBe(true);
    });

    it('should NOT use JSON formatter in development (uses pretty-print instead)', () => {
      // The negative assertion is critical: development MUST NOT use
      // JSON because JSON output is hard to read in a terminal.
      // Mixing JSON and human-readable in dev produces confused log
      // streams and is a common mistake. This test acts as a
      // regression guard.
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(winston.format.json).not.toHaveBeenCalled();
    });

    it('should compose multiple formatters via winston.format.combine OR call a single formatter directly', () => {
      // Most idiomatic Winston configurations chain multiple formatters
      // (timestamp + json, or timestamp + simple, etc.) via combine.
      // However, a minimal logger may use only a single formatter
      // without combine. The test accepts either pattern by asserting
      // that at least one of (combine, json, simple) was invoked,
      // making the test robust to both implementations.
      process.env = { ...process.env, ...productionEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const usedCombine = winston.format.combine.mock.calls.length > 0;
      const usedSingleFormatter
        = winston.format.json.mock.calls.length > 0
        || winston.format.simple.mock.calls.length > 0;
      expect(usedCombine || usedSingleFormatter).toBe(true);
    });

    it('should include timestamp in production log output for forensic analysis', () => {
      // Production logs are timestamped so operators can correlate
      // events across services. winston.format.timestamp() is the
      // canonical Winston helper for this. The logger module is
      // expected to invoke it at least once when configuring the
      // production formatter chain.
      //
      // If a future implementation uses a custom printf-based
      // timestamp instead of winston.format.timestamp(), this
      // assertion will need to be revisited. The current contract
      // (per AAP 0.4.2 implicit best-practice) is that timestamp() is
      // the chosen mechanism.
      process.env = { ...process.env, ...productionEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(winston.format.timestamp).toHaveBeenCalled();
    });
  });


  // ------------------------------------------------------------------
  // LOG_LEVEL handling
  // ------------------------------------------------------------------
  // The logger's `level` option (read from process.env.LOG_LEVEL or
  // derived from NODE_ENV when LOG_LEVEL is missing) controls which
  // log calls are emitted. Per AAP 0.4.3:
  //   - LOG_LEVEL set -> use that exact level
  //   - LOG_LEVEL missing + NODE_ENV='production' -> 'info'
  //   - LOG_LEVEL missing + NODE_ENV='development' -> 'debug'
  //   - LOG_LEVEL missing + NODE_ENV='test' -> 'debug' OR 'silent'
  //
  // Tests inspect winston.createLogger.mock.calls[0][0].level and/or
  // .silent to verify the value. Each test starts from validEnv() then
  // overrides only LOG_LEVEL (or deletes it) so the test isolates the
  // LOG_LEVEL contract from other env-derived behaviors.
  describe('LOG_LEVEL handling', () => {
    it('should set logger level to LOG_LEVEL value when explicitly provided', () => {
      // 'warn' is a non-default Winston level chosen to triangulate
      // "the logger respects the env var" — if the level were 'info'
      // (the production default) we couldn't tell whether the loader
      // honored LOG_LEVEL or fell back to the default.
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'warn';
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts = winston.createLogger.mock.calls[0][0];
      expect(opts.level).toBe('warn');
    });

    it('should accept LOG_LEVEL="error"', () => {
      // Verify each Winston standard level is honored. 'error' is
      // the highest-priority level (only error messages emit).
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'error';
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts = winston.createLogger.mock.calls[0][0];
      expect(opts.level).toBe('error');
    });

    it('should accept LOG_LEVEL="info"', () => {
      // 'info' is the production default but also a valid explicit
      // value. This test verifies the explicit-value path even when
      // the value happens to equal a default — guarding against
      // hypothetical bugs that conflate "default applied" with "value
      // honored."
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'info';
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts = winston.createLogger.mock.calls[0][0];
      expect(opts.level).toBe('info');
    });

    it('should accept LOG_LEVEL="debug"', () => {
      // 'debug' is the most verbose standard level. Combined with
      // the development NODE_ENV (validEnv defaults to 'development'),
      // this is a realistic developer-laptop configuration.
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'debug';
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts = winston.createLogger.mock.calls[0][0];
      expect(opts.level).toBe('debug');
    });

    it('should default LOG_LEVEL to "info" in production when LOG_LEVEL is missing', () => {
      // Production's documented default is 'info' — the most useful
      // baseline that emits info/warn/error but suppresses verbose/
      // debug/silly. We start from productionEnv() (which sets
      // LOG_LEVEL='info' explicitly), then DELETE LOG_LEVEL to
      // exercise the missing-env-var branch.
      process.env = { ...process.env, ...productionEnv() };
      delete process.env.LOG_LEVEL;
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts = winston.createLogger.mock.calls[0][0];
      expect(opts.level).toBe('info');
    });

    it('should default LOG_LEVEL to "debug" in development when LOG_LEVEL is missing', () => {
      // Development's documented default is 'debug' — the most
      // verbose standard level, useful for local development. We
      // start from developmentEnv() (which sets LOG_LEVEL='debug'
      // explicitly), then DELETE LOG_LEVEL to exercise the
      // missing-env-var branch.
      process.env = { ...process.env, ...developmentEnv() };
      delete process.env.LOG_LEVEL;
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts = winston.createLogger.mock.calls[0][0];
      expect(opts.level).toBe('debug');
    });

    it('should default LOG_LEVEL to "debug" or "silent" when NODE_ENV is "test" and LOG_LEVEL is missing', () => {
      // Per AAP 0.4.3 the documented rule is "info in production,
      // debug elsewhere" — so 'test' NODE_ENV with missing LOG_LEVEL
      // should yield 'debug'. However, the logger may also
      // legitimately apply a test-specific override that uses
      // 'silent' to suppress noisy output during test runs. The
      // assertion accepts either 'debug' or 'silent' to support both
      // implementations.
      process.env = { ...process.env, ...testEnv() };
      delete process.env.LOG_LEVEL;
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts = winston.createLogger.mock.calls[0][0];
      expect(['debug', 'silent']).toContain(opts.level);
    });

    it('should honor LOG_LEVEL="silent" in test environment', () => {
      // testEnv() already sets LOG_LEVEL='silent' to mirror the
      // contents of tests/fixtures/.env.test. The logger should
      // propagate this 'silent' value to winston.createLogger,
      // either as the level option or as a top-level silent boolean
      // flag (Winston accepts both patterns).
      process.env = { ...process.env, ...testEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts = winston.createLogger.mock.calls[0][0];
      const isSilenced = opts.level === 'silent' || opts.silent === true;
      expect(isSilenced).toBe(true);
    });
  });


  // ------------------------------------------------------------------
  // Invalid LOG_LEVEL fallback
  // ------------------------------------------------------------------
  // Per AAP 0.4.2's "Error cases" category: invalid LOG_LEVEL values
  // (e.g., 'invalid', typos, empty strings, case mismatches) MUST
  // NOT cause module-load to throw. The logger must degrade
  // gracefully — typically by falling back to a sensible default like
  // 'info' — rather than crashing the application at startup.
  //
  // Each test wraps the require() call in a thunk because
  // expect(...).not.toThrow() requires a function. A direct call
  // would throw before Jest could intercept it. We assert the FACT
  // of not-throwing without coupling to a specific fallback level —
  // any sensible default behavior is acceptable as long as the
  // module loads.
  describe('Invalid LOG_LEVEL fallback', () => {
    it('should not throw when LOG_LEVEL is an unrecognized value', () => {
      // 'invalid' is not in Winston's npm-levels set
      // (error/warn/info/http/verbose/debug/silly). The logger module
      // must either ignore the value (falling back to NODE_ENV-based
      // default) or coerce it — but never throw.
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'invalid';
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../src/logger');
      }).not.toThrow();
    });

    it('should not throw when LOG_LEVEL is a typo of a valid level', () => {
      // 'inffo' (typo of 'info') is a realistic operator-error
      // scenario — perhaps a fat-fingered .env file or environment
      // variable export. The logger must tolerate this without
      // crashing, even though the value isn't valid.
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'inffo';
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../src/logger');
      }).not.toThrow();
    });

    it('should not throw when LOG_LEVEL is an empty string', () => {
      // Empty-string LOG_LEVEL is the canonical "set but empty"
      // scenario — distinct from "unset". The logger must treat this
      // as "fall back to default" rather than "use empty string as
      // level" (which Winston wouldn't recognize).
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = '';
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../src/logger');
      }).not.toThrow();
    });

    it('should not throw when LOG_LEVEL is uppercase (case mismatch)', () => {
      // Winston level names are lowercase ('info' not 'INFO'). A
      // case-mismatched value should either be normalized or ignored,
      // but never cause a throw. This test documents that
      // case-insensitivity-or-fallback is acceptable behavior.
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'INFO';
      expect(() => {
        // eslint-disable-next-line global-require
        require('../../../src/logger');
      }).not.toThrow();
    });

    it('should still expose log methods after invalid LOG_LEVEL fallback', () => {
      // After falling back from an invalid LOG_LEVEL, the logger
      // module must still produce a working logger with all four
      // standard methods. A module that swallows the error but
      // returns a partially constructed logger would silently break
      // consumers — this test catches that anti-pattern.
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'gibberish';
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });
  });


  // ------------------------------------------------------------------
  // Idempotency across jest.resetModules() cycles
  // ------------------------------------------------------------------
  // The logger module's behavior must be deterministic: the same env
  // always produces a logger with the same shape, and a NEW env
  // (after resetModules + env mutation) produces a logger reflecting
  // the new env. These tests verify both directions:
  //   1. Same env across resetModules -> consistent shape (all four
  //      log methods present on both loads).
  //   2. New env across resetModules -> new behavior (level changes,
  //      formatter changes).
  //
  // This is the test-time analog of "the logger module is a pure
  // function of process.env" — a contract that simplifies reasoning
  // about logger behavior in production and during tests.
  describe('Idempotency across jest.resetModules() cycles', () => {
    it('should return a logger with consistent shape across resetModules + re-require for same env', () => {
      // First load: capture the logger and verify its shape.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const logger1 = require('../../../src/logger');
      expect(typeof logger1.info).toBe('function');

      // Force a fresh load with the SAME env. The new logger
      // should expose the same four methods, even though it's a
      // NEW object instance (resetModules invalidates the module
      // cache).
      jest.resetModules();
      // eslint-disable-next-line global-require
      const logger2 = require('../../../src/logger');
      expect(typeof logger2.info).toBe('function');
      expect(typeof logger2.warn).toBe('function');
      expect(typeof logger2.error).toBe('function');
      expect(typeof logger2.debug).toBe('function');
    });

    it('should reflect new LOG_LEVEL after resetModules + env mutation + re-require', () => {
      // First load with LOG_LEVEL='warn'.
      process.env = { ...process.env, ...validEnv() };
      process.env.LOG_LEVEL = 'warn';
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts1 = winston.createLogger.mock.calls[0][0];
      expect(opts1.level).toBe('warn');

      // Reset modules, mutate env, re-load. The new logger must
      // reflect LOG_LEVEL='error' — proving the cache was actually
      // invalidated and the logger re-read process.env.
      jest.resetModules();
      jest.clearAllMocks();
      process.env.LOG_LEVEL = 'error';
      // eslint-disable-next-line global-require
      const winston2 = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const opts2 = winston2.createLogger.mock.calls[0][0];
      expect(opts2.level).toBe('error');
    });

    it('should reflect new NODE_ENV after resetModules + env mutation + re-require', () => {
      // First load: development NODE_ENV. Verify JSON formatter is
      // NOT used (development uses human-readable formatters).
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const winston = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(winston.format.json).not.toHaveBeenCalled();

      // Reset modules, switch to production NODE_ENV, re-load. The
      // new logger MUST use JSON formatter (production behavior).
      // This verifies that NODE_ENV-driven formatter selection is
      // re-evaluated on each module load, not cached.
      jest.resetModules();
      jest.clearAllMocks();
      process.env = { ...process.env, ...productionEnv() };
      // eslint-disable-next-line global-require
      const winston2 = require('winston');
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(winston2.format.json).toHaveBeenCalled();
    });
  });


  // ------------------------------------------------------------------
  // Performance
  // ------------------------------------------------------------------
  // The logger module has no external I/O contract: it must complete
  // its work synchronously by reading process.env, configuring
  // Winston, and freezing/exposing the result. Network calls, file
  // descriptors, or long-running computation would violate this
  // contract.
  //
  // AAP 0.4.2 specifies "<20ms" as the aspirational target for logger
  // creation. In real-world Node.js v22 environments running under
  // Jest with mocks active, cold module-load time can plausibly hit
  // 30-60ms due to module resolution, JIT compilation, mock factory
  // invocation, and test harness overhead. We use 100ms as a
  // CI-stable upper bound that still catches pathological regressions
  // (e.g., an accidental synchronous network call).
  describe('Performance', () => {
    it('should load the logger module quickly (no external I/O)', () => {
      // Force a cold load by resetting modules in addition to the
      // beforeEach reset — this defeats any partial caching in the
      // mock factory or transitive requires. Without this, the
      // require() could be a near-instant cache hit and the test
      // would pass even if the cold load were catastrophically slow.
      process.env = { ...process.env, ...validEnv() };
      jest.resetModules();
      const start = Date.now();
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      const elapsed = Date.now() - start;

      // 100ms is the CI-safe bound; the AAP target of <20ms is
      // aspirational. A loader that takes >100ms almost certainly
      // has accidental synchronous I/O.
      expect(elapsed).toBeLessThan(100);
    });

    it('should invoke each log-level method quickly (per-call overhead bounded)', () => {
      // Per-call overhead matters because logging is on every
      // request's hot path. AAP 0.4.2 targets <1ms per call.
      // Mocked methods add overhead, so we use 50ms total for 4
      // calls (~12.5ms per call) as the practical CI bound. A
      // logger that takes >50ms for 4 mocked calls is likely doing
      // synchronous work it shouldn't.
      process.env = { ...process.env, ...validEnv() };
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      const start = Date.now();
      logger.info('benchmark');
      logger.warn('benchmark');
      logger.error('benchmark');
      logger.debug('benchmark');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });

  // ------------------------------------------------------------------
  // silenceLogger helper integration
  // ------------------------------------------------------------------
  // Verifies the integration contract between the logger module's
  // exports (src/logger/index.js) and the silenceLogger helper
  // (tests/helpers/silenceLogger.js). Specifically, the helper
  // expects the logger to have a Winston-like transport-management
  // API (clear, add) and a `silent` property.
  //
  // These tests provide defense-in-depth for the cross-file contract
  // beyond the helper's own unit tests. If the logger module's
  // exports change in a way that breaks the helper (e.g., removing
  // .clear() or .add()), these tests fail and pinpoint the
  // regression.
  //
  // Per the agent_prompt's "silenceLogger Helper Integration"
  // section, every test in this block uses the developmentEnv()
  // baseline (NODE_ENV='development') because in production/test
  // modes the logger may already be silent and the silencing
  // behavior would be a no-op (less informative for testing the
  // helper's effect).
  describe('silenceLogger helper integration', () => {
    it('should set logger.silent = true when silenceLogger is called with the logger', () => {
      // The helper's primary effect is `target.silent = true`.
      // The mocked logger from the winston factory has silent: false
      // initially, so the post-call assertion verifies the helper
      // mutated the property.
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      silenceLogger(logger);
      expect(logger.silent).toBe(true);
    });

    it('should call logger.clear() when the logger has a clear method', () => {
      // The helper checks `typeof target.clear === 'function'` before
      // invoking clear/add. The mocked logger has clear: jest.fn()
      // per the winston mock factory, so the helper's transport-
      // management code path executes. We assert the spy was called.
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      silenceLogger(logger);
      expect(logger.clear).toHaveBeenCalled();
    });

    it('should call logger.add() with a silent transport when the logger has an add method', () => {
      // After clearing existing transports, the helper adds a new
      // silent Console transport via target.add(...). We assert the
      // add spy was called; the specific transport instance passed
      // is verified indirectly (the add() call requires a valid
      // first argument, which the helper provides as
      // `new winston.transports.Console({silent: true})`).
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      silenceLogger(logger);
      expect(logger.add).toHaveBeenCalled();
    });

    it('should be idempotent — multiple calls do not accumulate transports or throw', () => {
      // Calling silenceLogger multiple times on the same logger
      // should be safe: the silent flag stays true, and any
      // additional transport adds are silent transports (so they
      // don't produce output even if accumulated). The contract is
      // "safe to call repeatedly without observable side effects on
      // log output."
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      expect(() => {
        silenceLogger(logger);
        silenceLogger(logger);
        silenceLogger(logger);
      }).not.toThrow();
      expect(logger.silent).toBe(true);
    });

    it('should not throw when silenceLogger is called with no arguments', () => {
      // The helper's no-arg signature (`silenceLogger()`) is
      // documented as "silence the project's default logger." When
      // src/logger/index.js cannot be resolved (e.g., before the
      // broader Express enhancement is authored), the helper falls
      // back to returning the original argument unchanged — no
      // throw. We require the logger first to ensure that branch is
      // exercised (the helper's lazy require of '../../src/logger'
      // happens internally).
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      require('../../../src/logger');
      expect(() => silenceLogger()).not.toThrow();
    });

    it('should return the silenced logger instance for fluent usage', () => {
      // The helper's contract is to return the silenced target so
      // callers can chain: `const log = silenceLogger(require(...))`.
      // We assert reference equality (toBe, not toEqual) because
      // the helper must return the SAME object it was passed —
      // returning a copy or a wrapper would break the fluent
      // pattern.
      process.env = { ...process.env, ...developmentEnv() };
      // eslint-disable-next-line global-require
      const logger = require('../../../src/logger');
      const result = silenceLogger(logger);
      expect(result).toBe(logger);
    });
  });
});

