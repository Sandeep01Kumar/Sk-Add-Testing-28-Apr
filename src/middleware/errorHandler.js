'use strict';

/**
 * src/middleware/errorHandler.js
 *
 * Express 4-argument error-handling middleware.
 *
 * Registered as the LAST middleware in the application's middleware
 * chain so Express dispatches every thrown / rejected / next(err)-
 * forwarded error here. The handler converts the error into a JSON
 * 500 response of canonical shape and logs the error via the project
 * logger. Stack-trace exposure is gated on `NODE_ENV` per the AAP
 * security contract: production responses NEVER include the stack;
 * non-production responses include it for local debugging and CI
 * triage.
 *
 * Behavior contract (per AAP Section 0.4.3 and the
 * tests/unit/middleware/errorHandler.test.js test suite):
 *
 *   Function signature
 *     - Arity exactly 4: `(err, req, res, next)`. Express's error-
 *       handler detection is purely syntactic — it counts the
 *       parameters declared on the function. Arity 4 is the ONLY
 *       value that registers the function as an error handler;
 *       arity 3 would cause Express to dispatch the function on
 *       every request as regular middleware and SKIP it on error
 *       propagation.
 *
 *   Status code resolution
 *     - When `err.statusCode` is a valid HTTP status integer (100-599),
 *       respond with that exact code. Examples: 400 (Bad Request),
 *       401 (Unauthorized), 403 (Forbidden), 404 (Not Found),
 *       422 (Unprocessable Entity), 503 (Service Unavailable).
 *     - When `err.statusCode` is missing, undefined, non-integer, or
 *       out of the documented HTTP range, fall back to 500 (Internal
 *       Server Error). The strict `Number.isInteger` + range check
 *       protects against accidental string codes (e.g., '422'),
 *       NaN, Infinity, and negative integers.
 *
 *   Body shape
 *     - JSON body of shape `{ error: { code, message } }` with an
 *       OPTIONAL `stack` field at `body.error.stack` in non-production
 *       environments. The body is constructed fresh on every
 *       invocation; no singleton or cached body is shared across
 *       requests.
 *     - `code` is a canonical SCREAMING_SNAKE_CASE string derived
 *       from the resolved status code (e.g., `INTERNAL_SERVER_ERROR`
 *       for 500, `BAD_REQUEST` for 400). Unknown codes fall back to
 *       `INTERNAL_SERVER_ERROR`.
 *     - `message` preserves the original `err.message` verbatim when
 *       it is a non-empty string. When the message is empty, missing,
 *       or the err is not an object with a string `message` field,
 *       the handler substitutes the canonical fallback string
 *       'Internal Server Error' so clients always receive a
 *       non-empty, human-readable explanation.
 *
 *   Stack-trace gating (security-sensitive)
 *     - `NODE_ENV === 'production'` → `err.stack` is OMITTED from the
 *       response body at every nested location. Leaking stacks in
 *       production exposes internal file paths, library versions,
 *       and call-graph information that aid attacker reconnaissance.
 *     - `NODE_ENV !== 'production'` (development, test, undefined,
 *       empty, staging, etc.) → `err.stack` IS included at
 *       `body.error.stack` to aid local debugging. The handler uses
 *       a strict `=== 'production'` comparison rather than a
 *       whitelist; only the exact string 'production' suppresses
 *       the stack.
 *     - Stack inclusion is conditional on the stack actually being
 *       a string. Plain-object errors with no stack and string
 *       errors are handled gracefully — no stack is added in those
 *       cases (the response still carries code + message + correct
 *       status).
 *
 *   Logging behavior
 *     - Calls `logger.error(err)` exactly ONCE per invocation,
 *       passing the error itself so structured loggers can extract
 *       the message, stack, and any custom properties. Logging
 *       happens BEFORE the response is sent so a downstream
 *       res.status / res.json failure cannot suppress the log.
 *     - Logging is INDEPENDENT of stack-trace gating. Even in
 *       production (where the response body excludes the stack),
 *       the logger.error call still fires so operators retain full
 *       server-side observability via Winston transports.
 *     - Does NOT call `logger.info`, `logger.warn`, or
 *       `logger.debug`. Routing errors to a non-error level would
 *       bypass alerting based on log severity.
 *
 *   Defensive behavior
 *     - Does NOT throw for any input — Error instance, plain object,
 *       string, undefined, null, missing properties, or non-numeric
 *       statusCode all produce a clean response.
 *     - Does NOT mutate `req.method`, `req.path`, or any other
 *       request property. Mutations could surprise downstream
 *       observers (request loggers, telemetry, audit middleware)
 *       reading req after the response is sent.
 *     - Does NOT call `next(err)` or `next()` — the handler is
 *       TERMINAL. Forwarding to next would route the request to
 *       Express's default error handler (which strips the JSON
 *       formatting we just produced).
 *     - Idempotent: repeated invocations with the same error
 *       produce identical body shape; body objects are fresh
 *       references on every call so concurrent requests cannot
 *       share state via the body.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline literals
 *   - 'use strict' at the file head
 *
 * @module src/middleware/errorHandler
 */

// Top-level require resolves once at module-load time. The logger is
// reused for every invocation. The require is safe at the top level
// because the logger module's behavior is fully determined at FIRST
// require — not at every call. Importantly, `logger` here is whatever
// `src/logger/index.js` exports: the real Winston Logger at runtime,
// or the jest.fn-backed mock object during unit tests (because
// `jest.mock('../../../src/logger', ...)` in the test file replaces
// this resolution at parse time).
const logger = require('../logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Holding magic values in named constants makes the code self-documenting
// and creates a single source of truth for refactor / i18n work later.

/**
 * Canonical fallback message when `err.message` is empty, missing, or
 * the err is not an object with a string message field. Per the AAP
 * test contract, clients MUST always receive a non-empty,
 * human-readable message.
 *
 * @type {string}
 */
const FALLBACK_MESSAGE = 'Internal Server Error';

/**
 * Default HTTP status code for unhandled errors. Used when
 * `err.statusCode` is missing or invalid.
 *
 * @type {number}
 */
const STATUS_INTERNAL_SERVER_ERROR = 500;

/**
 * Inclusive lower bound for valid HTTP status codes. Codes below 100
 * are not allowed by RFC 7230. The handler rejects out-of-range codes
 * to avoid emitting nonsensical statuses (which Node's http module
 * accepts but real clients reject).
 *
 * @type {number}
 */
const STATUS_CODE_MIN = 100;

/**
 * Inclusive upper bound for valid HTTP status codes. Codes above 599
 * are not registered by IANA. Per the same reasoning as
 * STATUS_CODE_MIN, the handler rejects them.
 *
 * @type {number}
 */
const STATUS_CODE_MAX = 599;

/**
 * The exact string value of `NODE_ENV` that suppresses stack-trace
 * exposure in the response body. The handler uses strict equality so
 * any other value (development, test, staging, undefined, '') falls
 * through to the "include stack" branch.
 *
 * @type {string}
 */
const NODE_ENV_PRODUCTION = 'production';

/**
 * Canonical error code string for the 500 status code. Used both as
 * the body-level `code` for default 500 responses and as the fallback
 * code for any HTTP status not in the lookup table below.
 *
 * @type {string}
 */
const ERROR_CODE_INTERNAL = 'INTERNAL_SERVER_ERROR';

/**
 * Lookup table mapping HTTP status codes to their canonical
 * SCREAMING_SNAKE_CASE error code names. The mapping is exhaustive for
 * the 4xx and 5xx ranges per IANA assignments. Codes not present in
 * the table fall back to ERROR_CODE_INTERNAL (e.g., a custom 599 or
 * non-standard 4xx code).
 *
 * Object.freeze prevents accidental mutation at runtime; the mapping
 * is a constant and should never change after module load.
 *
 * @type {Readonly<Object<number, string>>}
 */
const STATUS_CODE_TO_ERROR_CODE = Object.freeze({
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  407: 'PROXY_AUTHENTICATION_REQUIRED',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  410: 'GONE',
  411: 'LENGTH_REQUIRED',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  414: 'URI_TOO_LONG',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  416: 'RANGE_NOT_SATISFIABLE',
  417: 'EXPECTATION_FAILED',
  418: 'I_AM_A_TEAPOT',
  421: 'MISDIRECTED_REQUEST',
  422: 'UNPROCESSABLE_ENTITY',
  423: 'LOCKED',
  424: 'FAILED_DEPENDENCY',
  425: 'TOO_EARLY',
  426: 'UPGRADE_REQUIRED',
  428: 'PRECONDITION_REQUIRED',
  429: 'TOO_MANY_REQUESTS',
  431: 'REQUEST_HEADER_FIELDS_TOO_LARGE',
  451: 'UNAVAILABLE_FOR_LEGAL_REASONS',
  500: ERROR_CODE_INTERNAL,
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
  505: 'HTTP_VERSION_NOT_SUPPORTED',
  506: 'VARIANT_ALSO_NEGOTIATES',
  507: 'INSUFFICIENT_STORAGE',
  508: 'LOOP_DETECTED',
  510: 'NOT_EXTENDED',
  511: 'NETWORK_AUTHENTICATION_REQUIRED',
});

// ---------------------------------------------------------------------------
// Internal resolver helpers
// ---------------------------------------------------------------------------
// Each resolver isolates a single piece of decision logic so the main
// errorHandler function stays linear and readable. The resolvers are
// not exported; they are implementation details that may evolve
// without breaking the handler's public contract.

/**
 * Resolve the HTTP status code for the response body.
 *
 * Honors `err.statusCode` when it is a valid HTTP status integer
 * (in [100, 599]). Falls back to 500 (Internal Server Error) when the
 * value is missing, undefined, non-integer, or out of range. The
 * strict `Number.isInteger` + range check is intentional: it rejects
 * NaN, Infinity, negative integers, and floating-point values which
 * would otherwise sneak past a naive truthy check.
 *
 * Why strict over coercion: an err.statusCode of '422' (string) is
 * almost certainly a programming error in the producing code, not an
 * intentional type. Coercing it would silently mask the bug; falling
 * back to 500 makes the bug visible in monitoring (the dashboard
 * shows a 500 instead of the expected 422) without crashing the
 * handler itself.
 *
 * @param {*} err The error object passed to the middleware. May be
 *   any value: Error instance, plain object, string, null, undefined.
 * @returns {number} A valid HTTP status code in [100, 599].
 */
function resolveStatusCode(err) {
  // Defensive null/non-object check: only objects can carry a
  // statusCode property. Strings, numbers, null, and undefined fall
  // through to the default.
  if (err && typeof err === 'object') {
    const candidate = err.statusCode;
    if (
      Number.isInteger(candidate)
      && candidate >= STATUS_CODE_MIN
      && candidate <= STATUS_CODE_MAX
    ) {
      return candidate;
    }
  }
  return STATUS_INTERNAL_SERVER_ERROR;
}

/**
 * Resolve the canonical error code string for the body.
 *
 * Looks up the status code in the STATUS_CODE_TO_ERROR_CODE table.
 * Unknown codes fall back to `INTERNAL_SERVER_ERROR` so the body
 * always has a non-empty, predictable code string.
 *
 * @param {number} statusCode A valid HTTP status code.
 * @returns {string} A SCREAMING_SNAKE_CASE error code (e.g.,
 *   'INTERNAL_SERVER_ERROR', 'BAD_REQUEST').
 */
function resolveErrorCode(statusCode) {
  return STATUS_CODE_TO_ERROR_CODE[statusCode] || ERROR_CODE_INTERNAL;
}

/**
 * Resolve the human-readable message for the body.
 *
 * Honors `err.message` when it is a non-empty string. Falls back to
 * the canonical 'Internal Server Error' string when the message is:
 *   - Empty string (`new Error('')`)
 *   - Undefined or deleted (`delete err.message`)
 *   - Not a string (e.g., `err.message = { nested: '...' }`)
 *   - The err itself is not an object (string err, null, undefined)
 *
 * The contract is "always non-empty human-readable string" so API
 * clients never see empty messages, undefined, or null in the
 * `error.message` field.
 *
 * @param {*} err The error object. May be any value.
 * @returns {string} A non-empty human-readable message.
 */
function resolveMessage(err) {
  if (
    err
    && typeof err === 'object'
    && typeof err.message === 'string'
    && err.message.length > 0
  ) {
    return err.message;
  }
  return FALLBACK_MESSAGE;
}

/**
 * Detect whether the current process is running in production.
 *
 * Strict equality against the literal string 'production'. Any other
 * value (development, test, staging, undefined, '', 'PRODUCTION'
 * — note the case sensitivity) returns false, and the handler treats
 * such values as non-production for stack-exposure purposes.
 *
 * Reading `process.env.NODE_ENV` per-call (rather than caching it at
 * module load) supports tests that mutate NODE_ENV in beforeEach to
 * exercise both branches. Caching at module load would lock the
 * handler into whatever value was set at first require, breaking
 * the per-test branch tests.
 *
 * @returns {boolean} true iff `process.env.NODE_ENV === 'production'`.
 */
function isProductionEnv() {
  return process.env.NODE_ENV === NODE_ENV_PRODUCTION;
}

/**
 * Extract the stack string from the error, if present.
 *
 * Returns the stack only when the error is an object and its `stack`
 * property is a non-empty string. Returns undefined otherwise so the
 * caller can use a simple `if (typeof stack === 'string')` check
 * before adding the field to the body.
 *
 * @param {*} err The error object.
 * @returns {string|undefined} The stack string, or undefined when no
 *   stack is available on the input.
 */
function resolveStack(err) {
  if (err && typeof err === 'object' && typeof err.stack === 'string') {
    return err.stack;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// errorHandler middleware
// ---------------------------------------------------------------------------

/**
 * Express 4-argument error-handling middleware.
 *
 * The function intentionally accepts FOUR parameters (giving it
 * Express-recognized arity 4 via Function.prototype.length). Express
 * uses arity to distinguish error handlers from regular middleware;
 * removing or adding parameters here would silently break error
 * dispatch.
 *
 * The `next` parameter is declared but NEVER invoked: the handler is
 * terminal and produces the final response itself. Calling next(err)
 * would forward the error to Express's default error handler, which
 * strips the JSON formatting we just produced and emits an HTML
 * response instead.
 *
 * Execution order per invocation:
 *   1. Log the error via logger.error (server-side observability).
 *   2. Resolve the response status code from err.statusCode (or 500).
 *   3. Resolve the canonical error code string from the status.
 *   4. Resolve the human-readable message from err.message (or fallback).
 *   5. Build a fresh body object literal — never reuse a singleton.
 *   6. In non-production, attach the stack string to body.error.stack.
 *   7. Send the response: res.status(code).json(body).
 *
 * @param {*} err The error to handle. May be an Error instance, a
 *   plain object, a string, or any other value. The handler is
 *   defensive against malformed input.
 * @param {import('express').Request} _req The Express request object.
 *   Not consumed by this handler — the underscore prefix signals
 *   intentional non-use without triggering linter warnings about
 *   unused parameters.
 * @param {import('express').Response} res The Express response
 *   object. The handler calls `res.status(code).json(body)` exactly
 *   once.
 * @param {import('express').NextFunction} _next The Express `next`
 *   callback. Intentionally NOT invoked — the underscore prefix
 *   documents the design choice. The parameter exists solely to give
 *   the function arity 4 for Express's middleware dispatcher.
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  // Step 1: Log the error first. Operators need a server-side record
  // of every error regardless of what response we ultimately send,
  // so logging is the very first thing we do — before any branching
  // that could mask the log under a defensive guard. Per the AAP
  // contract, exactly ONE logger.error call per invocation.
  //
  // Passing `err` itself (rather than `err.message` or a string
  // representation) lets structured loggers extract the message,
  // stack, and any custom properties via the logger's own
  // serialization rules. The mocked logger in unit tests records
  // the call args verbatim and asserts on them via call-args
  // matchers.
  logger.error(err);

  // Step 2-4: Resolve response details from the error. Each resolver
  // is defensive against malformed input and always returns a
  // sensible default — so the handler can never produce a
  // half-formed response.
  const statusCode = resolveStatusCode(err);
  const code = resolveErrorCode(statusCode);
  const message = resolveMessage(err);

  // Step 5: Build a FRESH body literal. The literal syntax produces a
  // new object reference on every invocation, so concurrent requests
  // cannot share state via the body. Tests assert this explicitly:
  // `expect(body1).not.toBe(body2)` for two distinct invocations.
  const body = {
    error: {
      code: code,
      message: message,
    },
  };

  // Step 6: Stack-trace gating. In non-production environments, the
  // stack is included at body.error.stack to aid local debugging and
  // CI test triage. In production, the stack is OMITTED to avoid
  // leaking internal file paths, library versions, and call-graph
  // information that could aid attacker reconnaissance.
  //
  // The stack is only added when:
  //   (a) NODE_ENV !== 'production', AND
  //   (b) err is an object with a string-typed .stack property.
  // Both conditions guard against runtime surprises (string err,
  // plain-object err with no stack, etc.).
  if (!isProductionEnv()) {
    const stack = resolveStack(err);
    if (typeof stack === 'string') {
      body.error.stack = stack;
    }
  }

  // Step 7: Send the response. Express's idiomatic chained call sets
  // both the HTTP status and the application/json Content-Type in
  // one frame. res.status returns res so the chain stays fluent;
  // res.json serializes the body and marks the response as
  // headersSent.
  //
  // The chain produces exactly ONE res.status invocation and ONE
  // res.json invocation — verified by the test contract
  // `expect(res.status).toHaveBeenCalledTimes(1)` and the
  // corresponding assertion on res.json.
  res.status(statusCode).json(body);
}

module.exports = errorHandler;
