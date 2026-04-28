'use strict';

/**
 * tests/helpers/silenceLogger.js
 *
 * Winston logger-silencing helper for tests.
 *
 * Winston's default `Console` transport produces noisy output that pollutes
 * Jest's terminal display, making test failures and progress hard to read.
 * This helper neutralizes that output via a belt-and-suspenders strategy:
 *
 *   1. Set `logger.silent = true` — Winston 3.x's native instance-level flag
 *      that disables emission across every configured transport without
 *      modifying the transport list.
 *   2. Replace any configured transports with a single silent `Console`
 *      transport, ensuring no transport-level side effects (file writes,
 *      HTTP shipping, syslog forwarding) occur during tests even if a
 *      future Winston version changes how the `silent` flag is honored.
 *
 * Used by every test file that imports `src/logger/index.js` directly
 * (per AAP Section 0.5.5).
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS `require()`/`module.exports`
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Idempotent: safe to call multiple times within or across test files
 *   - Stateless: does not memoize loggers between calls
 *   - Defensive: tolerates missing `src/logger`, missing `winston`, mocked
 *     plain-object loggers, and `null`/`undefined` arguments without
 *     throwing
 *
 * Usage:
 *   const { silenceLogger } = require('../../helpers/silenceLogger');
 *
 *   // Silence the project's default logger
 *   beforeAll(() => { silenceLogger(); });
 *
 *   // Silence a specific logger instance
 *   const logger = require('../../../src/logger');
 *   silenceLogger(logger);
 *
 * @module tests/helpers/silenceLogger
 */

/**
 * Silence the given Winston logger so it produces no output during tests.
 *
 * The function is intentionally tolerant of partial environments — it
 * never throws, even when the project's logger module hasn't been authored
 * yet, when `winston` is unavailable, or when the supplied logger is a
 * Jest mock (a plain object with `jest.fn()` methods rather than a real
 * Winston Logger instance).
 *
 * @param {Object} [logger] Optional Winston logger instance to silence.
 *   If omitted (or `null`/`undefined`), the project's logger from
 *   `src/logger/index.js` is silenced by default. If that module cannot
 *   be resolved, the helper returns the original argument unchanged.
 * @returns {Object|null|undefined} The silenced logger (the same object
 *   passed in, or the project logger if no argument was provided), or
 *   the original argument if no target could be resolved.
 */
function silenceLogger(logger) {
  // Resolve the target logger. `let` (not `const`) is required here because
  // the binding may be reassigned to the project logger when the caller
  // omits an explicit argument.
  let target = logger;

  // ---------------------------------------------------------------------
  // Default-target resolution
  // ---------------------------------------------------------------------
  // When no logger is supplied, lazy-require the project logger.
  // Lazy-requiring (rather than top-level requiring) ensures that any
  // jest.mock('../../../src/logger', ...) calls in test files are honored
  // — the mock is registered before this require executes at test runtime.
  if (target == null) {
    try {
      // eslint-disable-next-line global-require
      target = require('../../src/logger');
    } catch (err) {
      // src/logger/index.js may not exist yet (e.g., during early test
      // runs before the broader Express enhancement is authored, or in
      // partial-setup states). Fall back to returning the original
      // argument — the caller asked for the default but the default is
      // unavailable, so there is nothing to silence.
      return logger;
    }
  }

  // ---------------------------------------------------------------------
  // Defensive guard
  // ---------------------------------------------------------------------
  // If the resolved target is not a non-null object, there is nothing to
  // silence — return as-is. This handles the case where `src/logger`
  // exists but exports something unexpected (a primitive, a function, a
  // Symbol), which a plain-object check would not catch.
  if (target == null || typeof target !== 'object') {
    return target;
  }

  // ---------------------------------------------------------------------
  // Strategy 1: Set the Winston silent flag
  // ---------------------------------------------------------------------
  // Winston Logger instances honor a `silent` boolean property at the
  // instance level. Setting it to `true` disables emission across every
  // transport without touching transport configuration. This is the
  // canonical "shut up the logger" mechanism in Winston 3.x and applies
  // even when transport replacement (Strategy 2) is skipped.
  target.silent = true;

  // ---------------------------------------------------------------------
  // Strategy 2: Replace transports with a single silent Console transport
  // ---------------------------------------------------------------------
  // This is defense-in-depth: even if `silent` is bypassed by some code
  // path, every remaining transport is itself silent. We lazy-require
  // winston here (rather than at module top-level) so that any
  // jest.mock('winston', ...) calls in test files take effect first.
  // eslint-disable-next-line global-require
  let winston;
  try {
    // eslint-disable-next-line global-require
    winston = require('winston');
  } catch (err) {
    // If `winston` is not installed (e.g., before npm install completes
    // or in a stripped-down environment), the silent flag from Strategy 1
    // is sufficient on its own — return the partially silenced target.
    return target;
  }

  // Guard against partial winston modules (a jest.mock that omits
  // transports.Console, for example). If the Console constructor isn't
  // available, skip transport replacement and rely on Strategy 1.
  if (
    winston == null
    || winston.transports == null
    || typeof winston.transports.Console !== 'function'
  ) {
    return target;
  }

  // Only attempt transport replacement if the target exposes the standard
  // Winston Logger transport-management API (`clear` and `add` methods).
  // Mocked loggers — plain objects produced by
  // jest.mock('../../../src/logger', () => ({info: jest.fn(), ...})) —
  // lack these methods, so we skip transport manipulation gracefully and
  // leave the silent flag from Strategy 1 as the sole effect.
  if (
    typeof target.clear === 'function'
    && typeof target.add === 'function'
  ) {
    // Wrap clear/add in their own try/catch so unexpected failures from
    // exotic logger implementations cannot break a test setup. The
    // helper's contract is "make a best effort to silence" — never throw.
    try {
      target.clear();
      target.add(new winston.transports.Console({ silent: true }));
    } catch (err) {
      // Swallow — Strategy 1's silent flag remains in effect, which is
      // sufficient to suppress output for any well-behaved Winston
      // logger instance.
    }
  }

  return target;
}

module.exports = { silenceLogger };
