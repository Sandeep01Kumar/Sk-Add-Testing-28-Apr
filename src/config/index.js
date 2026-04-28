'use strict';

/**
 * src/config/index.js
 *
 * Configuration loader for the Express.js application.
 *
 * Reads PORT, HOST, NODE_ENV, and LOG_LEVEL from `process.env`, applies
 * documented defaults for any missing variables, validates the result
 * against the documented value ranges, and exports a frozen
 * configuration object so downstream modules cannot mutate runtime
 * settings inadvertently.
 *
 * Behavior contract (per AAP Section 0.4.3 and the
 * tests/unit/config/config.test.js test suite):
 *
 *   PORT
 *     - Read from process.env.PORT (a string per Node's env-var typing).
 *     - Default: 3000 when missing.
 *     - Coerced to a JavaScript number.
 *     - Validated as an integer in the range [1, 65535] inclusive.
 *     - Throws on non-numeric, negative, zero, or out-of-range values.
 *
 *   HOST
 *     - Read from process.env.HOST.
 *     - Default: '0.0.0.0' when missing.
 *     - Validated as a non-empty string.
 *     - Throws when HOST is the empty string '' (explicit absence is
 *       distinct from "missing entirely" — see test contract).
 *
 *   NODE_ENV
 *     - Read from process.env.NODE_ENV.
 *     - Default: 'development' when missing.
 *     - Pass-through string (no normalization, no validation against an
 *       enumerated set; the runtime accepts any string).
 *
 *   LOG_LEVEL
 *     - Read from process.env.LOG_LEVEL.
 *     - Default: 'info' when NODE_ENV === 'production'.
 *     - Default: 'debug' for any other NODE_ENV (including 'test',
 *       'development', and undefined).
 *     - Pass-through string when explicitly set; this module does NOT
 *       validate the value against Winston's known levels — that is
 *       the logger module's responsibility.
 *
 *   Output
 *     - A frozen plain object with exactly four keys:
 *         { port: number, host: string, nodeEnv: string, logLevel: string }
 *     - Object.isFrozen(config) === true.
 *     - Idempotent across `jest.resetModules()` cycles when the
 *       supplied env is unchanged.
 *     - Cold-load time well under 50ms (per AAP Section 0.4.3 the
 *       performance bound is < 10ms; this loader does no I/O so the
 *       actual time is sub-millisecond).
 *
 * Why this module is module-load synchronous:
 *   The CommonJS loader calls module-body code at the time of the first
 *   `require()`. Reading and validating env vars at module-load time
 *   means downstream consumers receive a fully-validated, frozen
 *   configuration object on import — there is no "loading" state to
 *   handle. Test isolation requires `jest.resetModules()` before the
 *   next `require()` so the module body re-executes with a fresh env.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports (matches package.json's
 *     lack of "type": "module").
 *   - Two-space indentation, single quotes, semicolons, const-by-default.
 *   - Trailing commas in multiline literals.
 *   - 'use strict' at the file head.
 *   - No external dependencies — pure Node + process.env access.
 *
 * @module src/config
 */

// ---------------------------------------------------------------------------
// Constants — TCP port boundaries and environment-aware defaults.
// ---------------------------------------------------------------------------

/**
 * Minimum valid TCP port number for application binding.
 *
 * TCP port 0 is reserved for OS-assigned ephemeral ports, which is
 * incompatible with the application's contract (PM2 process
 * registration, health-check probes, and external load balancers all
 * require a known, deterministic port). The loader rejects any value
 * less than 1.
 *
 * @type {number}
 */
const MIN_PORT = 1;

/**
 * Maximum valid TCP port number (per RFC 793 / the 16-bit port field).
 *
 * Any value above 65535 is invalid because the TCP/IP port field cannot
 * represent it. The loader rejects values above this bound.
 *
 * @type {number}
 */
const MAX_PORT = 65535;

/**
 * Default port when PORT env var is absent.
 *
 * Matches the legacy server.js port (3000) so the modernized server
 * preserves backward-compatible default binding behavior.
 *
 * @type {number}
 */
const DEFAULT_PORT = 3000;

/**
 * Default host when HOST env var is absent.
 *
 * '0.0.0.0' (IPv4 unspecified address) instructs the kernel to bind
 * on every interface — appropriate for production deployments behind
 * load balancers. Tests use 127.0.0.1 (loopback) via the .env.test
 * fixture; the default kicks in only when nothing is supplied.
 *
 * @type {string}
 */
const DEFAULT_HOST = '0.0.0.0';

/**
 * Default Node environment when NODE_ENV env var is absent.
 *
 * 'development' is the most permissive default — any NODE_ENV-aware
 * branches (logger formatter, errorHandler stack gating, etc.) take
 * the verbose / debug-friendly path when this default applies.
 *
 * @type {string}
 */
const DEFAULT_NODE_ENV = 'development';

/**
 * Default log level when LOG_LEVEL env var is absent and NODE_ENV is
 * 'production'.
 *
 * 'info' is the least-verbose level that still surfaces operational
 * events — appropriate for production where debug-level output would
 * flood log aggregators and incur unnecessary cost.
 *
 * @type {string}
 */
const DEFAULT_LOG_LEVEL_PRODUCTION = 'info';

/**
 * Default log level when LOG_LEVEL env var is absent and NODE_ENV is
 * NOT 'production' (development, test, staging, or undefined).
 *
 * 'debug' surfaces fine-grained development diagnostics. Tests using
 * NODE_ENV='test' typically override LOG_LEVEL='silent' via .env.test
 * to suppress log output during the test run; this default kicks in
 * only when LOG_LEVEL is absent entirely.
 *
 * @type {string}
 */
const DEFAULT_LOG_LEVEL_NON_PRODUCTION = 'debug';

/**
 * String literal that signals production-mode behavior across the
 * application stack (Express, Winston, errorHandler, etc.).
 *
 * Centralized here so any future rename of the production marker (an
 * unlikely but non-zero possibility) can propagate from a single
 * source-of-truth constant.
 *
 * @type {string}
 */
const NODE_ENV_PRODUCTION = 'production';

// ---------------------------------------------------------------------------
// Internal helpers — small, side-effect-free predicates and parsers.
// ---------------------------------------------------------------------------

/**
 * Parse and validate the PORT env-var value.
 *
 * Accepts a raw env-var value (which is always a string when present
 * in `process.env`, or `undefined` when absent), applies the documented
 * default when absent, coerces the result to a Number, and validates
 * the integer / range constraints. Throws a `RangeError` with a
 * descriptive message for any invalid input — the test suite asserts
 * the FACT of throwing without coupling to a specific Error subclass,
 * so `RangeError` (semantically appropriate for out-of-range numeric
 * values) is the natural choice.
 *
 * Validation rules (in order):
 *   1. Absent (undefined) -> apply DEFAULT_PORT (3000).
 *   2. Present but cannot be parsed as a finite number -> throw.
 *   3. Parsed value is not an integer (e.g., '3.14') -> throw.
 *   4. Parsed value < MIN_PORT (1) -> throw.
 *   5. Parsed value > MAX_PORT (65535) -> throw.
 *   6. Otherwise -> return the parsed integer.
 *
 * Note: The `Number(value)` coercion handles whitespace and leading
 * '+' signs the same way `parseInt` does NOT (`parseInt('3.14')` would
 * silently return 3). Using `Number()` plus explicit `Number.isInteger`
 * rejects '3.14' as expected per the test contract.
 *
 * @param {string|undefined} rawValue The value of process.env.PORT.
 * @returns {number} The validated PORT as a positive integer.
 * @throws {RangeError} When the value cannot be coerced to a valid
 *   integer in the [MIN_PORT, MAX_PORT] range.
 */
function parsePort(rawValue) {
  // Handle the absent case first — undefined env vars get the default.
  // Empty string is treated as "present but invalid" by the next branch
  // because Number('') === 0, which the range check correctly rejects.
  if (rawValue === undefined) {
    return DEFAULT_PORT;
  }

  // Coerce to number. Number('abc') yields NaN; Number('') yields 0;
  // Number('-1') yields -1; Number('70000') yields 70000. Each of those
  // outcomes is exercised by a dedicated test in config.test.js.
  const parsed = Number(rawValue);

  // NaN check first because NaN fails every other comparison silently.
  // Number.isFinite excludes NaN, +Infinity, and -Infinity in one call.
  if (!Number.isFinite(parsed)) {
    throw new RangeError(
      `Invalid PORT: "${rawValue}" is not a valid number.`,
    );
  }

  // Reject non-integer values like '3.14' explicitly. Number.isInteger
  // returns false for non-integer numbers, NaN, and any non-Number.
  // Combined with the isFinite check above, this guards the integer
  // contract robustly.
  if (!Number.isInteger(parsed)) {
    throw new RangeError(
      `Invalid PORT: "${rawValue}" is not an integer.`,
    );
  }

  // Range check: TCP ports outside [1, 65535] are not valid for binding.
  // Port 0 (OS-assigned ephemeral) is intentionally excluded — see the
  // MIN_PORT comment for rationale.
  if (parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new RangeError(
      `Invalid PORT: ${parsed} is outside the allowed range `
        + `[${MIN_PORT}, ${MAX_PORT}].`,
    );
  }

  return parsed;
}

/**
 * Parse and validate the HOST env-var value.
 *
 * Accepts a raw env-var value, applies the documented default when
 * absent, and validates the explicit-empty-string failure mode.
 *
 * Rules:
 *   - Absent (undefined) -> apply DEFAULT_HOST ('0.0.0.0').
 *   - Empty string ('') -> throw RangeError (explicit absence is
 *     distinct from "missing entirely").
 *   - Any other string -> return verbatim.
 *
 * The loader does NOT validate the host string's format (IPv4 dotted
 * quad, IPv6 bracketed address, hostname, etc.) because Node's
 * http.Server accepts any of those formats and applying our own
 * parser here would risk rejecting valid hosts.
 *
 * @param {string|undefined} rawValue The value of process.env.HOST.
 * @returns {string} The validated HOST string.
 * @throws {RangeError} When HOST is explicitly the empty string.
 */
function parseHost(rawValue) {
  // Absent -> default. The test contract distinguishes this case from
  // explicit-empty: missingHostEnv() omits HOST entirely (default kicks
  // in) while validEnv() with HOST='' triggers the throw below.
  if (rawValue === undefined) {
    return DEFAULT_HOST;
  }

  // Explicit empty string is malformed configuration and must be
  // rejected per AAP 0.4.3.
  if (rawValue === '') {
    throw new RangeError('Invalid HOST: empty string is not allowed.');
  }

  return rawValue;
}

/**
 * Parse the NODE_ENV env-var value.
 *
 * Pure pass-through with default fallback. The loader does not
 * validate NODE_ENV against an enumerated list because the runtime
 * accepts any string — downstream modules (logger, errorHandler) make
 * their own decisions based on the value.
 *
 * @param {string|undefined} rawValue The value of process.env.NODE_ENV.
 * @returns {string} The NODE_ENV string (default 'development' when
 *   absent).
 */
function parseNodeEnv(rawValue) {
  if (rawValue === undefined) {
    return DEFAULT_NODE_ENV;
  }
  return rawValue;
}

/**
 * Parse the LOG_LEVEL env-var value, applying NODE_ENV-aware defaults.
 *
 * Rules:
 *   - Present (any string) -> return verbatim.
 *   - Absent and NODE_ENV === 'production' -> 'info'.
 *   - Absent and NODE_ENV !== 'production' -> 'debug'.
 *
 * The pass-through behavior for an explicit value is intentional: the
 * logger module is responsible for handling unknown / invalid log
 * levels (its own tests verify graceful degradation). Any validation
 * here would create a duplicate-validation problem and risk diverging
 * from the logger's tolerance contract.
 *
 * @param {string|undefined} rawValue The value of process.env.LOG_LEVEL.
 * @param {string} nodeEnv The previously parsed NODE_ENV (used to
 *   select the appropriate default).
 * @returns {string} The LOG_LEVEL string.
 */
function parseLogLevel(rawValue, nodeEnv) {
  if (rawValue !== undefined) {
    return rawValue;
  }
  return nodeEnv === NODE_ENV_PRODUCTION
    ? DEFAULT_LOG_LEVEL_PRODUCTION
    : DEFAULT_LOG_LEVEL_NON_PRODUCTION;
}

// ---------------------------------------------------------------------------
// Module body: load, validate, freeze, export.
// ---------------------------------------------------------------------------
// Executed once per `require()` cycle. CommonJS caches the result, so
// subsequent `require()` calls return the same frozen object until
// `jest.resetModules()` (or equivalent) invalidates the cache.

// Parse NODE_ENV first because LOG_LEVEL's default depends on it.
const nodeEnv = parseNodeEnv(process.env.NODE_ENV);

// Parse PORT and HOST. These may throw — and that is intentional. A
// misconfigured server should fail FAST at startup with a clear error
// rather than booting into a broken state and failing later under load.
const port = parsePort(process.env.PORT);
const host = parseHost(process.env.HOST);

// Parse LOG_LEVEL after NODE_ENV is known.
const logLevel = parseLogLevel(process.env.LOG_LEVEL, nodeEnv);

// ---------------------------------------------------------------------------
// Build and freeze the configuration object.
// ---------------------------------------------------------------------------
// Object.freeze() at the top level is sufficient because every value is
// a primitive (number / string). No nested objects exist that would
// require deep freezing. The frozen object satisfies:
//
//   - Object.isFrozen(config) === true
//   - Reassignment of properties is rejected
//   - Adding new properties is rejected
//   - Deletion of properties is rejected
//
// Strict mode (active per `'use strict'` at the file head and
// inherited by every consumer that imports this module) ensures
// mutation attempts throw TypeError; non-strict consumers see silent
// rejection. Either way, the frozen object's values are stable.

const config = Object.freeze({
  port,
  host,
  nodeEnv,
  logLevel,
});

module.exports = config;
