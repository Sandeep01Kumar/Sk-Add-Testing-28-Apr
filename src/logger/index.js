'use strict';

/**
 * src/logger/index.js
 *
 * Winston-based application logger.
 *
 * Exposes a singleton Winston Logger instance configured from the
 * application's environment-derived `config` object (`src/config`).
 * The logger is instantiated synchronously at module-load time so
 * downstream consumers (`src/middleware/requestLogger.js`,
 * `src/middleware/errorHandler.js`, and any future handler) receive a
 * fully ready-to-use logger on import — no asynchronous wait, no
 * "loading" state.
 *
 * Behavior contract (per AAP Section 0.4.3 and the
 * tests/unit/logger/logger.test.js test suite):
 *
 *   Module exports
 *     - The Winston logger instance is exported directly via
 *       `module.exports = logger`. The instance exposes the standard
 *       Winston log-level methods (`info`, `warn`, `error`, `debug`,
 *       plus `verbose`, `silly`, `log`) AND the transport-management
 *       API (`add`, `remove`, `clear`, `close`, `configure`) used by
 *       `tests/helpers/silenceLogger.js`.
 *
 *   winston.createLogger invocation
 *     - Called exactly ONCE at module-load time.
 *     - Receives a single options object as the first argument.
 *
 *   Transport selection (NODE_ENV-conditional)
 *     - `production`  -> Console transport (PM2/Docker capture stdout
 *                        for log aggregation; no File transport is
 *                        registered to keep the deployment artifact
 *                        free of disk-I/O surprises).
 *     - `development` -> Console transport (human-readable terminal
 *                        output).
 *     - `test`        -> Console transport with `silent: true` so
 *                        Jest's terminal output is not polluted by
 *                        application logs.
 *
 *   Formatter selection (NODE_ENV-conditional)
 *     - `production`  -> combine(timestamp(), json()) — machine-
 *                        parseable JSON with timestamps for log
 *                        aggregators.
 *     - non-production -> combine(timestamp(), colorize(), simple())
 *                        — human-readable level-colored single-line
 *                        output.
 *     - The development branch does NOT call `winston.format.json` —
 *       mixing JSON output into a developer terminal is a documented
 *       anti-pattern and the test suite enforces this constraint.
 *
 *   LOG_LEVEL handling
 *     - When `config.logLevel` is one of Winston's recognized levels
 *       (`error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`,
 *       `silent`), it is passed through verbatim to
 *       `winston.createLogger({ level: ... })`.
 *     - When `config.logLevel` is unrecognized (e.g., '', 'INFO',
 *       'invalid', 'inffo', 'gibberish'), the loader gracefully falls
 *       back to a NODE_ENV-derived default (`info` for production,
 *       `debug` otherwise) — never throws. This degrades gracefully
 *       for misconfigured deployments rather than crashing at startup.
 *     - When `config.logLevel === 'silent'` OR `config.nodeEnv ===
 *       'test'`, the logger is also configured with `silent: true` at
 *       the top level (defense-in-depth: silences the logger even if
 *       a future Winston version changes how `level: 'silent'` is
 *       honored).
 *
 *   Idempotency
 *     - Each `require('../config')` resolution is itself idempotent
 *       (CommonJS module cache), so the logger module's configuration
 *       depends solely on `process.env` at the time of FIRST module
 *       load. Tests defeat this caching via `jest.resetModules()` to
 *       observe per-test env mutations.
 *
 *   Performance
 *     - Module load is synchronous and performs no I/O. Cold load
 *       benchmarks well under the 100ms CI bound (AAP's aspirational
 *       target is <20ms).
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline literals
 *   - 'use strict' at the file head
 *
 * @module src/logger
 */

const winston = require('winston');
const config = require('../config');

// ---------------------------------------------------------------------------
// Constants — Winston level vocabulary, environment markers, and defaults.
// ---------------------------------------------------------------------------

/**
 * Winston's recognized log-level vocabulary plus the special `silent`
 * level. Values OUTSIDE this set are treated as misconfiguration and
 * trigger the graceful-fallback path inside `resolveLogLevel`.
 *
 * The list matches Winston's `config.npm.levels` keys (in priority
 * order from highest-priority to lowest) plus `silent`. Any value
 * Winston itself would not recognize is rejected here.
 *
 * @type {readonly string[]}
 */
const VALID_LOG_LEVELS = Object.freeze([
  'error',
  'warn',
  'info',
  'http',
  'verbose',
  'debug',
  'silly',
  'silent',
]);

/**
 * String literal that signals production-mode behavior. Matches the
 * value used in `src/config/index.js`. Centralized here so future
 * renames propagate from one source-of-truth constant.
 *
 * @type {string}
 */
const NODE_ENV_PRODUCTION = 'production';

/**
 * String literal that signals test-mode behavior — used for transport
 * silencing during Jest runs.
 *
 * @type {string}
 */
const NODE_ENV_TEST = 'test';

/**
 * The special Winston level that suppresses every emission.
 *
 * @type {string}
 */
const LEVEL_SILENT = 'silent';

/**
 * Default level applied when `config.logLevel` is unrecognized AND
 * NODE_ENV === 'production'. Mirrors the documented production default
 * from `src/config/index.js`.
 *
 * @type {string}
 */
const FALLBACK_LEVEL_PRODUCTION = 'info';

/**
 * Default level applied when `config.logLevel` is unrecognized AND
 * NODE_ENV !== 'production'. Mirrors the documented non-production
 * default from `src/config/index.js`.
 *
 * @type {string}
 */
const FALLBACK_LEVEL_NON_PRODUCTION = 'debug';

// ---------------------------------------------------------------------------
// Internal helpers — small, side-effect-free predicates and builders.
// ---------------------------------------------------------------------------

/**
 * Resolve the effective log level for `winston.createLogger`.
 *
 * Validates the supplied level string against Winston's recognized
 * vocabulary. When the value is unrecognized (the empty string,
 * uppercase variants, typos, or arbitrary strings), the function
 * returns a NODE_ENV-derived sensible default rather than propagating
 * the bad value. This insulates the application against misconfigured
 * `LOG_LEVEL` env vars without crashing at startup.
 *
 * @param {string|undefined} rawLevel The candidate log level (typically
 *   sourced from `config.logLevel`). May be any string or `undefined`.
 * @param {string} nodeEnv The active NODE_ENV value, used to select a
 *   fallback when `rawLevel` is unrecognized.
 * @returns {string} A recognized Winston log level — guaranteed to be
 *   present in `VALID_LOG_LEVELS`.
 */
function resolveLogLevel(rawLevel, nodeEnv) {
  // Strict membership check. We deliberately do NOT lowercase rawLevel
  // before comparing because Winston's level names are canonically
  // lowercase — an uppercase or mixed-case value indicates operator
  // error and should hit the fallback path so the logger uses a
  // known-good level instead of a value Winston wouldn't recognize at
  // emission time.
  if (typeof rawLevel === 'string' && VALID_LOG_LEVELS.includes(rawLevel)) {
    return rawLevel;
  }

  // Fall back to NODE_ENV-derived default. Production defaults to
  // `info` (the least-verbose level that surfaces operational
  // events); every other environment defaults to `debug` (most
  // verbose, useful for development and test diagnostics).
  return nodeEnv === NODE_ENV_PRODUCTION
    ? FALLBACK_LEVEL_PRODUCTION
    : FALLBACK_LEVEL_NON_PRODUCTION;
}

/**
 * Build the formatter chain for the active environment.
 *
 * Production uses a machine-parseable format chain (timestamp + JSON)
 * suitable for ingestion by log aggregators (Splunk, Datadog,
 * CloudWatch, etc.). Non-production uses a human-readable chain
 * (timestamp + colorize + simple) that is easy to scan in a developer
 * terminal.
 *
 * The development branch deliberately omits `winston.format.json()` —
 * mixing JSON into a terminal log stream produces unreadable output
 * and is a regression the test suite explicitly guards against.
 *
 * @param {string} nodeEnv The active NODE_ENV value.
 * @returns {object} An opaque Winston format chain produced by
 *   `winston.format.combine`. The chain is consumed by
 *   `winston.createLogger` and applied to every emitted log record.
 */
function buildFormat(nodeEnv) {
  const { combine, timestamp, json, colorize, simple } = winston.format;

  if (nodeEnv === NODE_ENV_PRODUCTION) {
    // Production: stable JSON serialization with ISO-8601 timestamps.
    // Consumers (log aggregators) parse the JSON to extract structured
    // metadata; the timestamp field is essential for cross-service
    // event correlation during incident investigations.
    return combine(timestamp(), json());
  }

  // Non-production (development, test, staging, custom envs): human
  // readable. `colorize()` adds ANSI level coloring (red for error,
  // yellow for warn, green for info, etc.) and `simple()` formats
  // each record as `level: message` followed by JSON-stringified
  // metadata. Combined with `timestamp()` this yields lines like:
  //   2024-01-15T12:34:56.789Z info: server started {"port":3000}
  return combine(timestamp(), colorize(), simple());
}

/**
 * Build the transports array for the active environment.
 *
 * Every environment registers exactly one Console transport. In test
 * mode, the transport is configured with `silent: true` so log records
 * are accepted but never written anywhere — keeping Jest's terminal
 * output clean. In all other environments the transport writes to
 * stdout (PM2 and Docker capture stdout for log aggregation, so a
 * Console transport is sufficient for production).
 *
 * @param {string} nodeEnv The active NODE_ENV value.
 * @returns {object[]} An array containing exactly one Winston
 *   transport instance — never an empty array (a logger with zero
 *   transports emits a `[winston] no transports` warning to stderr,
 *   which would defeat the test-mode silence guarantee).
 */
function buildTransports(nodeEnv) {
  // `silent: true` on the Console transport is the test-mode
  // silencing strategy: the transport accepts log records but writes
  // nothing. This is independent of (and complementary to) the
  // top-level `silent` flag passed to `createLogger` below.
  const isTestMode = nodeEnv === NODE_ENV_TEST;

  return [
    new winston.transports.Console({
      silent: isTestMode,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Module body: resolve effective options, build the logger, export it.
// ---------------------------------------------------------------------------
// CommonJS executes the body once per `require()` cycle (the result
// is cached by Node's module loader). `jest.resetModules()` defeats
// the cache for tests that need a fresh module load reflecting new
// process.env values.
//
// Order of operations:
//   1. Read `config.nodeEnv` and `config.logLevel` (config validates
//      these at its own load time).
//   2. Resolve the effective log level — graceful fallback for
//      unrecognized values.
//   3. Determine whether the logger should be silent at the
//      instance level (test mode OR explicit 'silent' level).
//   4. Build the format chain and transports for the active env.
//   5. Hand the assembled options to `winston.createLogger` ONCE.
//   6. Export the resulting logger instance.

const effectiveLevel = resolveLogLevel(config.logLevel, config.nodeEnv);

// Top-level silencing covers two scenarios:
//   - LOG_LEVEL='silent' was explicitly set (resolved to 'silent').
//   - NODE_ENV='test' (defense-in-depth — even if LOG_LEVEL is 'debug',
//     test runs should be quiet).
// Either condition triggers `silent: true` so the logger guarantees
// no emission. The Console transport is also silent in test mode
// (see `buildTransports`), but doubling up here insulates against
// future Winston changes that might decouple the two flags.
const instanceSilent
  = effectiveLevel === LEVEL_SILENT || config.nodeEnv === NODE_ENV_TEST;

/**
 * Options object passed to `winston.createLogger`. Constructed once
 * per module load and never mutated thereafter.
 *
 * @type {{level: string, silent: boolean, format: object,
 *         transports: object[]}}
 */
const loggerOptions = {
  level: effectiveLevel,
  silent: instanceSilent,
  format: buildFormat(config.nodeEnv),
  transports: buildTransports(config.nodeEnv),
};

// Single point of Winston instantiation. Per the test contract,
// `createLogger` must be invoked exactly once per module load.
// Subsequent log calls operate on the returned logger without any
// re-construction.
const logger = winston.createLogger(loggerOptions);

// Direct logger export. The test suite (and runtime consumers) treat
// the module as the logger itself — `logger.info(...)`, `logger.warn(...)`,
// etc. — rather than as a factory. The defensive resolution pattern
// `(loggerModule && loggerModule.foo) || loggerModule` used by some
// tests still works because winston's logger object exposes named
// methods directly.
module.exports = logger;
