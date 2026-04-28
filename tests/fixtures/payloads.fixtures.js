'use strict';

/**
 * tests/fixtures/payloads.fixtures.js
 *
 * Canonical response-payload fixtures for route Supertest assertions and
 * integration tests. This module is the single "source of truth" for what
 * each Express endpoint and error handler should return, enabling
 * consistent assertions across `tests/unit/routes/*.test.js`,
 * `tests/unit/middleware/*.test.js`, and
 * `tests/integration/server.integration.test.js`.
 *
 * Why a fixture module instead of inline literals?
 *   - Centralizes the definition of canonical response shapes so that
 *     when the broader Express enhancement evolves (for example,
 *     reformatting the 404 body or adding a new field to /health), only
 *     this file needs updating instead of every test file.
 *   - Captures the legacy behavior of the original 14-line `server.js`
 *     verbatim (`'Hello, World!\n'`) so backward-compatibility regressions
 *     are caught immediately.
 *   - Decouples test data from test logic, which makes the test files
 *     themselves shorter, more readable, and easier to maintain.
 *
 * Design pattern (per AAP Section 0.4.4):
 *   - Static descriptors are exported as plain `const` objects whose
 *     properties capture the EXACT canonical values (statusCode,
 *     contentType, body shape, required keys).
 *   - Dynamic per-request values (such as the `path` echoed by the 404
 *     handler or the `stack` included by the development-mode error
 *     handler) are produced by FACTORY HELPER METHODS attached to those
 *     descriptors (`forPath()`, `forError()`). Each call returns a fresh
 *     object so test mutations never leak across tests, satisfying the
 *     "factory functions rather than singleton objects" directive.
 *
 * Exports (per the file schema):
 *   - helloWorldPayload   : GET / response (preserves legacy
 *                           'Hello, World!\n' body verbatim)
 *   - healthPayload       : GET /health response shape (status, uptime,
 *                           timestamp) with type metadata for
 *                           non-deterministic-field assertions
 *   - notFoundPayload     : 404 fall-through response shape
 *                           ({error: 'Not Found', path}) with a
 *                           `forPath()` helper for path-aware bodies
 *   - internalErrorPayload: 500 error-handler response shape
 *                           ({error: {code, message [, stack]}}) with a
 *                           `forError()` helper for env-aware bodies
 *
 * Consumers (per AAP Section 0.5.5):
 *   - tests/unit/routes/index.test.js      (helloWorldPayload)
 *   - tests/unit/routes/health.test.js     (healthPayload)
 *   - tests/unit/middleware/notFoundHandler.test.js   (notFoundPayload)
 *   - tests/unit/middleware/errorHandler.test.js      (internalErrorPayload)
 *   - tests/integration/server.integration.test.js    (all four)
 *
 * Path resolution from consumer test files:
 *   - From `tests/unit/<subdir>/`:  require('../../fixtures/payloads.fixtures')
 *   - From `tests/integration/`:    require('../fixtures/payloads.fixtures')
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS `require()`/`module.exports` (matches package.json's lack
 *     of `"type": "module"`)
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline literals
 *   - Framework-agnostic plain JavaScript — NO Jest API surface
 *     (no `jest.fn()`, no `expect`, no `describe`) so this module is
 *     reusable across unit and integration tests and could in principle
 *     be reused by Mocha, Vitest, or Node's built-in test runner
 *   - No dependency on `src/**` modules or third-party packages — pure
 *     data, importable by any test file regardless of installed packages
 *   - Helper methods (`forPath`, `forError`) are PURE FUNCTIONS — they
 *     don't mutate inputs, don't hold internal state, and don't read
 *     `process.env` or any other ambient context
 *
 * Usage examples:
 *
 *   // Unit test of the root route handler
 *   const { helloWorldPayload } = require('../../fixtures/payloads.fixtures');
 *   const request = require('supertest');
 *   const app = require('../../../src/app');
 *   await request(app)
 *     .get('/')
 *     .expect(helloWorldPayload.statusCode)
 *     .expect('Content-Type', new RegExp(helloWorldPayload.contentType))
 *     .expect(helloWorldPayload.body);
 *
 *   // Unit test of the /health route handler
 *   const { healthPayload } = require('../../fixtures/payloads.fixtures');
 *   const res = await request(app).get('/health');
 *   expect(res.status).toBe(healthPayload.statusCode);
 *   expect(res.body).toEqual(expect.objectContaining({
 *     status: healthPayload.expectedStatus,
 *   }));
 *   for (const key of healthPayload.requiredKeys) {
 *     expect(res.body).toHaveProperty(key);
 *   }
 *   expect(typeof res.body.uptime).toBe(healthPayload.uptimeType);
 *   expect(typeof res.body.timestamp).toBe(healthPayload.timestampType);
 *
 *   // Unit test of the 404 fall-through handler
 *   const { notFoundPayload } = require('../../fixtures/payloads.fixtures');
 *   const res = await request(app).get('/no-such-route');
 *   expect(res.status).toBe(notFoundPayload.statusCode);
 *   expect(res.body).toEqual(notFoundPayload.forPath('/no-such-route'));
 *
 *   // Unit test of the error handler in development mode
 *   const { internalErrorPayload } = require('../../fixtures/payloads.fixtures');
 *   const err = new Error('boom');
 *   const expected = internalErrorPayload.forError(err, { production: false });
 *   expect(res.status).toBe(expected.statusCode);
 *   expect(res.body).toEqual(expected.body);
 *
 * @module tests/fixtures/payloads.fixtures
 */

// ---------------------------------------------------------------------------
// Constants — shared canonical values reused across multiple payloads.
// ---------------------------------------------------------------------------

/**
 * Default error code for the 500 error-handler body when the thrown
 * Error instance does not carry a more specific `.code` property.
 *
 * Chosen to match the SCREAMING_SNAKE_CASE convention common in REST
 * API error responses (RFC 7807 / Problem Details extensions).
 *
 * @type {string}
 */
const DEFAULT_INTERNAL_ERROR_CODE = 'INTERNAL_SERVER_ERROR';

/**
 * Default error message for the 500 error-handler body when the thrown
 * Error instance has no `.message` property (or an empty one).
 *
 * Mirrors Node's built-in `http.STATUS_CODES[500]` value to align with
 * Express's default error rendering behavior.
 *
 * @type {string}
 */
const DEFAULT_INTERNAL_ERROR_MESSAGE = 'Internal Server Error';

// ---------------------------------------------------------------------------
// helloWorldPayload — root route (GET /) canonical response.
// ---------------------------------------------------------------------------

/**
 * Root route payload. Preserves the legacy `server.js` behavior verbatim:
 * Content-Type `text/plain`, body `'Hello, World!\n'`, status `200`.
 *
 * The body's TRAILING NEWLINE (`\n`) is INTENTIONAL and MUST NOT be
 * trimmed. The legacy server's `res.end('Hello, World!\n')` call sends
 * exactly 14 bytes — preserving the newline is part of the
 * backward-compatibility contract for the modernization. Tests
 * asserting on this body must use strict equality against the full
 * string (`'Hello, World!\n'`), not a `.trim()`-ed comparison.
 *
 * The `contentType` value is `'text/plain'` WITHOUT charset suffix to
 * keep assertions tolerant of Express's automatic charset addition
 * (`text/plain; charset=utf-8`); tests typically match via regex
 * (`new RegExp(helloWorldPayload.contentType)`) or via Supertest's
 * `.expect('Content-Type', /text\/plain/)`.
 *
 * Properties:
 *   - body        {string} The exact text body, INCLUDING the trailing newline.
 *   - contentType {string} The expected Content-Type prefix (no charset).
 *   - statusCode  {number} The expected HTTP status (200 OK).
 *
 * @type {{body: string, contentType: string, statusCode: number}}
 */
const helloWorldPayload = {
  body: 'Hello, World!\n',
  contentType: 'text/plain',
  statusCode: 200,
};

// ---------------------------------------------------------------------------
// healthPayload — /health route response shape descriptor.
// ---------------------------------------------------------------------------

/**
 * Health route payload SHAPE DESCRIPTOR.
 *
 * The `/health` body has dynamic fields (`uptime`, `timestamp`) that
 * change per request, so this fixture deliberately omits a static
 * canonical body literal and instead exposes:
 *   - the static expectations every response must satisfy
 *     (`statusCode`, `contentType`, `expectedStatus`),
 *   - the set of required keys (`requiredKeys`), and
 *   - the JavaScript `typeof` strings for the dynamic fields
 *     (`uptimeType`, `timestampType`) so consumers can write
 *     `expect(typeof body.uptime).toBe(healthPayload.uptimeType)` style
 *     assertions instead of brittle exact-value comparisons.
 *
 * Per AAP Section 0.10.1: "Write deterministic timestamp assertions.
 * When testing /health (which returns a current timestamp), assert that
 * the timestamp is parseable as an ISO-8601 string ... rather than
 * asserting exact equality, which would race the system clock."
 *
 * Properties:
 *   - contentType    {string}   Expected Content-Type prefix
 *                                ('application/json').
 *   - statusCode     {number}   Expected HTTP status (200 OK).
 *   - requiredKeys   {string[]} The keys every health body must contain,
 *                                in canonical order.
 *   - expectedStatus {string}   The static value of the `status` field
 *                                ('ok').
 *   - uptimeType     {string}   The `typeof` value the `uptime` field
 *                                must report ('number').
 *   - timestampType  {string}   The `typeof` value the `timestamp` field
 *                                must report ('string').
 *
 * @type {{
 *   contentType: string,
 *   statusCode: number,
 *   requiredKeys: string[],
 *   expectedStatus: string,
 *   uptimeType: string,
 *   timestampType: string,
 * }}
 */
const healthPayload = {
  contentType: 'application/json',
  statusCode: 200,
  requiredKeys: ['status', 'uptime', 'timestamp'],
  expectedStatus: 'ok',
  uptimeType: 'number',
  timestampType: 'string',
};

// ---------------------------------------------------------------------------
// notFoundPayload — 404 fall-through response shape with forPath() helper.
// ---------------------------------------------------------------------------

/**
 * 404 fall-through payload.
 *
 * The `path` field of the response body is dynamic (it echoes the
 * requested URL path), so the fixture exposes:
 *   - the static base shape (`body.error === 'Not Found'`), and
 *   - a factory helper `forPath(requestedPath)` that builds the
 *     fully-formed expected body for a given path.
 *
 * Per AAP Section 0.4.3 / 0.3.1, the `notFoundHandler` middleware
 * returns Content-Type `application/json` with body
 * `{error: 'Not Found', path: req.path}`.
 *
 * Properties:
 *   - contentType {string} Expected Content-Type prefix
 *                          ('application/json').
 *   - statusCode  {number} Expected HTTP status (404 Not Found).
 *   - body        {Object} Static base body shape; the `path` field is
 *                          deliberately ABSENT here so consumers cannot
 *                          accidentally compare against a missing-path
 *                          body. Use `forPath()` to build the full body.
 *   - forPath     {Function} Factory helper — see below.
 *
 * @type {{
 *   contentType: string,
 *   statusCode: number,
 *   body: {error: string},
 *   forPath: (requestedPath: string) => {error: string, path: string},
 * }}
 */
const notFoundPayload = {
  contentType: 'application/json',
  statusCode: 404,
  body: {
    error: 'Not Found',
  },
  /**
   * Build the canonical 404 response body for a specific requested path.
   *
   * Returns a fresh object on every invocation so test mutations never
   * leak across calls. The returned object is shallow — its only
   * properties are the strings `error` and `path`, both of which are
   * primitive values not subject to inadvertent reference sharing.
   *
   * @param {string} requestedPath The path the client attempted to access
   *   (e.g., `'/no-such-route'`). The value is echoed verbatim into the
   *   returned body's `path` field; callers are responsible for passing
   *   a string. The function does not validate the input type or
   *   coerce non-string inputs — that is the responsibility of the
   *   `notFoundHandler` middleware itself.
   * @returns {{error: string, path: string}} A fresh body object with
   *   `error: 'Not Found'` and `path` set to `requestedPath`.
   */
  forPath(requestedPath) {
    return {
      error: 'Not Found',
      path: requestedPath,
    };
  },
};

// ---------------------------------------------------------------------------
// internalErrorPayload — 500 error-handler response shape with forError().
// ---------------------------------------------------------------------------

/**
 * 500 error-handler payload.
 *
 * The body shape varies by environment: in development the response
 * INCLUDES the error stack, while in production it OMITS the stack
 * (per AAP Section 0.4.3: "NODE_ENV !== 'production' → response
 * includes err.stack; NODE_ENV === 'production' → response excludes
 * err.stack"). The body also varies by error: a custom error with a
 * `statusCode`, `code`, or `message` overrides the defaults.
 *
 * To support both axes of variation, the fixture exposes:
 *   - the static defaults (`statusCode: 500`, `contentType:
 *     'application/json'`, base `body` shape with default code/message),
 *   - and a factory helper `forError(err, options)` that builds the
 *     fully-formed expected response (status code AND body) for a
 *     specific error and environment.
 *
 * Properties:
 *   - contentType {string}   Expected Content-Type prefix
 *                            ('application/json').
 *   - statusCode  {number}   Default HTTP status when no custom
 *                            statusCode is present on the error (500).
 *   - body        {Object}   Default production-shape body
 *                            (`{error: {code, message}}` with no stack).
 *   - forError    {Function} Factory helper — see below.
 *
 * @type {{
 *   contentType: string,
 *   statusCode: number,
 *   body: {error: {code: string, message: string}},
 *   forError: (
 *     err: Error|undefined,
 *     options?: {production?: boolean}
 *   ) => {statusCode: number, body: {error: Object}},
 * }}
 */
const internalErrorPayload = {
  contentType: 'application/json',
  statusCode: 500,
  body: {
    error: {
      code: DEFAULT_INTERNAL_ERROR_CODE,
      message: DEFAULT_INTERNAL_ERROR_MESSAGE,
    },
  },
  /**
   * Build the canonical error-handler response (status code AND body)
   * for a specific error and environment.
   *
   * The function is FULLY DEFENSIVE — every property access on the
   * `err` argument is guarded so callers can safely pass `undefined`,
   * `null`, plain strings, or POJOs without `Error.prototype` and still
   * receive a sensible default-shape result. This matches the runtime
   * behavior expected of the Express error-handling middleware itself.
   *
   * Resolution rules (in order):
   *   - `statusCode` resolves from `err.statusCode` if it is a positive
   *     integer; otherwise falls back to 500.
   *   - `code` resolves from `err.code` if it is a non-empty string;
   *     otherwise falls back to `'INTERNAL_SERVER_ERROR'`.
   *   - `message` resolves from `err.message` if it is a non-empty
   *     string; otherwise falls back to `'Internal Server Error'`.
   *   - `stack` is included in the body ONLY when `options.production`
   *     is NOT strictly `true` AND `err.stack` is a non-empty string.
   *     This mirrors the AAP-documented contract that production
   *     responses must NEVER leak stack traces while development /
   *     test responses include them for debugging convenience.
   *
   * The function does not mutate `err`, does not read `process.env`,
   * does not throw under any input, and produces a fresh object on
   * every invocation — so it is safe to call from concurrently-running
   * tests and from Jest's parallel worker pool.
   *
   * @param {Error|null|undefined} err The error instance the handler
   *   will process. Accepts any value; non-Error inputs use defaults.
   * @param {Object} [options] Build options.
   * @param {boolean} [options.production=false] If strictly `true`, the
   *   returned body OMITS the `stack` field even when `err.stack` is
   *   present. Any other value (false, undefined, missing options) is
   *   treated as non-production and the stack IS included if available.
   * @returns {{statusCode: number, body: {error: Object}}} A fresh
   *   object containing the HTTP status code and the response body.
   *   The body always has the shape `{error: {code, message [, stack]}}`.
   */
  forError(err, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const isProduction = opts.production === true;

    const statusCode = isPositiveInteger(err && err.statusCode)
      ? err.statusCode
      : 500;
    const code = isNonEmptyString(err && err.code)
      ? err.code
      : DEFAULT_INTERNAL_ERROR_CODE;
    const message = isNonEmptyString(err && err.message)
      ? err.message
      : DEFAULT_INTERNAL_ERROR_MESSAGE;

    const body = {
      error: {
        code,
        message,
      },
    };

    if (!isProduction && err && isNonEmptyString(err.stack)) {
      body.error.stack = err.stack;
    }

    return {
      statusCode,
      body,
    };
  },
};

// ---------------------------------------------------------------------------
// Internal helpers — small predicates used by forError().
//
// Defined OUTSIDE the exported objects to keep the public API minimal
// (consumers should not depend on these helpers) and to centralize the
// validation logic so all default-fallback decisions are consistent.
// ---------------------------------------------------------------------------

/**
 * Return true when `value` is a positive, finite integer.
 *
 * Used by `internalErrorPayload.forError()` to validate `err.statusCode`
 * before adopting it as the response status. HTTP status codes are
 * positive integers in the range [100, 599]; this predicate's
 * `> 0 && Number.isInteger` check is sufficient for our purposes
 * because the fixture's only consumer is the error-handler middleware,
 * which itself validates the upper bound.
 *
 * @param {*} value Any value.
 * @returns {boolean} True iff `value` is a positive finite integer.
 */
function isPositiveInteger(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value > 0;
}

/**
 * Return true when `value` is a non-empty string.
 *
 * Used by `internalErrorPayload.forError()` to decide whether to adopt
 * `err.message`, `err.code`, or `err.stack` from the supplied error.
 * Empty strings are treated as missing because they would render an
 * unhelpful response body.
 *
 * @param {*} value Any value.
 * @returns {boolean} True iff `value` is a string with length > 0.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  helloWorldPayload,
  healthPayload,
  notFoundPayload,
  internalErrorPayload,
};
