'use strict';

/**
 * src/middleware/requestLogger.js
 *
 * Express request-logging middleware.
 *
 * Registered as one of the FIRST middlewares in the application's
 * middleware chain so every incoming request (matched route, 404,
 * error path) is observed and logged uniformly. The middleware emits
 * a single `info`-level log entry per request containing the request
 * method and path, then yields control to `next()` so downstream
 * middleware and route handlers run normally.
 *
 * Behavior contract (per AAP Section 0.4.3 and the
 * tests/unit/middleware/requestLogger.test.js test suite):
 *
 *   Function signature
 *     - Arity exactly 3: `(req, res, next)`. Express inspects
 *       `Function.prototype.length` at registration time; arity 4
 *       would cause Express to dispatch this middleware only on
 *       error paths, defeating its purpose.
 *
 *   Logging behavior
 *     - Calls `logger.info(...)` exactly ONCE per request. The log
 *       payload includes both `req.method` and `req.path` so they
 *       appear as recognizable substrings in JSON.stringify(args).
 *     - Does NOT call `logger.warn`, `logger.error`, or
 *       `logger.debug` — those levels are reserved for non-routine
 *       events. Per-request access logs are unconditionally `info`.
 *
 *   Pass-through behavior
 *     - Calls `next()` exactly ONCE with no error argument so the
 *       request continues through the middleware chain. A request
 *       logger is a transparent observer, not a terminal handler.
 *     - Does NOT call `res.json`, `res.send`, or `res.end`. Doing
 *       so would terminate the response chain and prevent route
 *       handlers from executing.
 *     - Does NOT mutate `req.method` or `req.path` so downstream
 *       middleware sees pristine request fields.
 *
 *   Error resilience (CRITICAL)
 *     - If the logger throws (transport crash, disk-full ENOSPC,
 *       network timeout to a syslog host, or any other transient
 *       failure), the middleware MUST still call `next()` so the
 *       user's request continues. A logging failure is NOT an
 *       application error — failing user requests because of a
 *       logging problem would degrade availability unnecessarily.
 *     - The middleware wraps the log emission in `try/catch` and
 *       silently swallows any caught exception. The throw is
 *       neither re-thrown nor passed to `next(err)` — passing it
 *       to `next(err)` would route the user's request through the
 *       error handler, conflating logging failures with
 *       application errors.
 *
 *   Idempotency and statelessness
 *     - No module-level state, no per-request caching, no shared
 *       buffer or counter. Repeated invocations behave identically;
 *       concurrent invocations do not interfere.
 *
 *   Edge cases
 *     - Missing User-Agent / X-Request-ID headers: the middleware
 *       logs whatever metadata it has and calls `next()` without
 *       throwing.
 *     - Long paths (2000+ chars) and special-character paths: the
 *       middleware logs them verbatim without throwing.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline literals
 *   - 'use strict' at the file head
 *
 * @module src/middleware/requestLogger
 */

// Lazy-require the logger inside the function would force a module
// resolution per request — prohibitively slow on a hot path. Top-level
// require resolves once at module-load time and reuses the resulting
// logger instance for every invocation. The require is safe at the
// top level because the logger module's behavior is determined by
// `process.env` at the time of FIRST require — not at every call.
const logger = require('../logger');

/**
 * Express request-logging middleware.
 *
 * Logs the request's HTTP method and path at `info` level, then calls
 * `next()` to continue the middleware chain. The logger emission is
 * wrapped in `try/catch` so a logger failure (transport crash, disk
 * full, etc.) cannot break the request flow.
 *
 * The function intentionally accepts `next` as its third parameter
 * (giving it Express-recognized arity 3). The parameter IS invoked
 * (unlike the unused `next` in `notFoundHandler`) — once per
 * invocation, with no arguments, so Express continues dispatching the
 * request to subsequent middleware.
 *
 * @param {import('express').Request} req The Express request object.
 *   Reads `req.method` and `req.path` only; no other fields are
 *   consumed.
 * @param {import('express').Response} res The Express response object.
 *   Not used by this middleware (a request logger is a transparent
 *   observer).
 * @param {import('express').NextFunction} next The Express `next`
 *   callback. Called exactly once with no arguments.
 * @returns {void}
 */
function requestLogger(req, res, next) {
  // Wrap the logger emission in try/catch per the error-resilience
  // contract. Logger failures must NOT interrupt the request flow:
  //   - A throw here without try/catch would propagate to Express,
  //     which would route the request to the error handler — turning
  //     a logging issue into a 500 response visible to the user.
  //   - Passing the caught error to next(err) would have the same
  //     effect via a different code path.
  // The correct behavior is silent swallow: the request continues,
  // the user gets their normal response, and the operator can detect
  // the logging problem via other channels (e.g., transport-level
  // monitoring or alerting).
  try {
    // Compose the log payload as a structured object so consumers
    // (log aggregators, querying tools) can filter on individual
    // fields. The first positional argument is a human-readable
    // message; the second is the structured metadata. JSON.stringify
    // applied to the call args (in tests) finds both `req.method`
    // and `req.path` regardless of which positional slot they
    // occupy, so this format is robust against test-format changes.
    logger.info('request', {
      method: req.method,
      path: req.path,
    });
  } catch (loggerError) {
    // Silent swallow — see the contract description above. The
    // catch parameter is intentionally unused (the error is not
    // logged via console.error to avoid recursive failure modes
    // when the logger itself is the failing transport).
  }

  // Yield control to the next middleware. Calling `next()` with no
  // arguments tells Express "no error, continue normal dispatch".
  // This call is OUTSIDE the try/catch above so a failure in
  // `next()` itself (extremely unlikely — it's just a function
  // pointer) propagates up the stack as a real application error.
  // The contract specifies that next() is called even when the
  // logger throws; this structure satisfies that contract because
  // the catch block above completes normally before this line runs.
  next();
}

module.exports = requestLogger;
