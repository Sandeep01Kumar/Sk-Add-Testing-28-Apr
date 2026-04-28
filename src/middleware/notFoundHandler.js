'use strict';

/**
 * src/middleware/notFoundHandler.js
 *
 * Express 404 fall-through middleware.
 *
 * Registered as the LAST regular (3-arg) middleware in the application's
 * middleware chain — AFTER every router and middleware that may legitimately
 * match a request, and BEFORE the 4-arg error handler. Express dispatches
 * unmatched requests through every registered 3-arg middleware in order;
 * the 404 handler is positioned to be the final matcher and produces a
 * structured 404 JSON response for any request that no earlier handler
 * claimed.
 *
 * Behavior contract (per AAP Section 0.4.3 and the
 * tests/unit/middleware/notFoundHandler.test.js test suite):
 *
 *   Function signature
 *     - Arity exactly 3: `(req, res, next)`. Express inspects
 *       `Function.prototype.length` at registration time; arity 4 would
 *       cause Express to treat this as an error handler and skip it on
 *       normal requests.
 *
 *   Response shape
 *     - HTTP status: 404 (Not Found).
 *     - Content-Type: `application/json` (set automatically by `res.json`).
 *     - Body: `{ error: 'Not Found', path: req.path }` — exactly two
 *       fields. The body is a fresh object on every invocation; no
 *       singleton or cached body is shared across requests.
 *
 *   Method coverage
 *     - Catches every HTTP method (GET, POST, PUT, DELETE, PATCH,
 *       OPTIONS, HEAD, etc.) — there is no per-method branching. The
 *       middleware is registered with `app.use(notFoundHandler)`, not
 *       `app.get('*', notFoundHandler)`, so every method falls through.
 *
 *   Path coverage
 *     - Catches every unmatched path — there is no per-path branching.
 *       The `path` field of the response body echoes `req.path` verbatim
 *       (no normalization, no trailing-slash stripping). Echoing helps
 *       programmatic API consumers determine which path was rejected
 *       without parsing free-form text.
 *
 *   Terminal contract
 *     - Does NOT call `next()` (neither `next()` nor `next(err)`). The
 *       middleware produces the final response itself; forwarding to
 *       `next()` would either invoke a non-existent next middleware or
 *       — when invoked with an Error — route a routing failure through
 *       the error handler, conflating "not found" with "server error".
 *
 *   Idempotency
 *     - Pure function of `req.path` -> response. Holds no internal state
 *       (no counter, cache, or singleton). Repeated invocations with the
 *       same path produce identical responses; concurrent invocations
 *       with different paths do not share state.
 *
 *   Logging
 *     - Does NOT log the 404 as an application error. A 404 reflects a
 *       client-side mistake (typo, stale link, etc.) — not an
 *       application error worth alerting on. Operators who want to
 *       monitor 404 rates should aggregate access logs from the
 *       `requestLogger` middleware (which logs every request) rather
 *       than relying on this handler to emit warning-level events.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline literals
 *   - 'use strict' at the file head
 *
 * @module src/middleware/notFoundHandler
 */

/**
 * The canonical error message returned in the 404 JSON body.
 *
 * Held in a constant rather than inlined so future internationalization
 * efforts (or a switch to error-code-only responses) can update one
 * source of truth. The literal value is dictated by the AAP and the
 * test contract: the body MUST contain `error: 'Not Found'`.
 *
 * @type {string}
 */
const ERROR_NOT_FOUND = 'Not Found';

/**
 * The HTTP status code for unmatched routes.
 *
 * Held in a constant for the same reason as `ERROR_NOT_FOUND` — single
 * source of truth, easy refactor target.
 *
 * @type {number}
 */
const STATUS_NOT_FOUND = 404;

/**
 * Express 404 fall-through middleware.
 *
 * Sends a 404 JSON response containing the error string and the
 * requested path. Does NOT invoke `next()` — the response is terminal.
 *
 * The function intentionally accepts `next` as its third parameter
 * (giving it Express-recognized arity 3) even though the parameter
 * is never invoked. Removing the parameter would change the function's
 * `.length` to 2, which Express still dispatches as regular middleware
 * but is a less idiomatic signature and might confuse future
 * maintainers reading the registration call.
 *
 * The body object is constructed fresh per call (object literal) so
 * each response carries its own object reference — preventing any
 * downstream mutation from polluting subsequent responses.
 *
 * @param {import('express').Request} req The Express request object.
 *   Only `req.path` is read; no other fields are consumed.
 * @param {import('express').Response} res The Express response object.
 *   The middleware calls `res.status(404).json({...})`.
 * @param {import('express').NextFunction} next The Express `next`
 *   callback. Intentionally NOT invoked — the middleware is terminal.
 * @returns {void}
 */
function notFoundHandler(req, res, next) {
  // Compose the response body from a literal so each call produces a
  // distinct object reference. Echoing `req.path` (rather than
  // `req.url` or `req.originalUrl`) matches the AAP contract: `path`
  // is the part of the URL after the host and before the query
  // string, which is the most useful field for clients debugging
  // routing mismatches.
  const body = {
    error: ERROR_NOT_FOUND,
    path: req.path,
  };

  // Chain `res.status(404).json(body)` is the canonical Express idiom
  // for a structured error response: `status` returns `res` so the
  // chain stays fluent, and `json` serializes the body and sets the
  // Content-Type header to `application/json`. The chain produces a
  // single network frame on a real Express response.
  res.status(STATUS_NOT_FOUND).json(body);

  // Deliberately omit `next()`. The middleware is terminal — the
  // response has been sent and there is no downstream middleware
  // that should run for this request. The `next` parameter exists
  // solely to give the function arity 3 for Express's middleware
  // dispatcher.
}

module.exports = notFoundHandler;
