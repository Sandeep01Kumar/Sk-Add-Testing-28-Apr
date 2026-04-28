'use strict';

/**
 * tests/unit/middleware/errorHandler.test.js
 *
 * Unit tests for the Express error-handling middleware at
 * `src/middleware/errorHandler.js`.
 *
 * Test contracts verified:
 *   1. The middleware is a function with arity 4 (err, req, res, next)
 *      — Express's error-handler detection is purely syntactic: it
 *      counts the parameters declared on the function. If the handler
 *      is defined as `(err, req, res, next) => {...}`, Express
 *      recognizes it. If defined as `(err, req, res) => {...}`, Express
 *      does NOT — the function is treated as regular middleware and is
 *      BYPASSED on error propagation. Asserting `length === 4` is the
 *      canary for this subtle but critical Express convention.
 *   2. By default (when `err.statusCode` is missing), the handler
 *      responds with HTTP 500 and a JSON body of canonical shape
 *      `{ error: { code, message } }` (per AAP 0.4.3 and the assigned
 *      folder requirements).
 *   3. The handler honors `err.statusCode` overrides for documented
 *      4xx codes (400, 403, 422). When `err.statusCode` is absent or
 *      not a usable status integer, the handler falls back to 500.
 *   4. When `err.message` is empty (for example, `new Error('')` or
 *      a thrown plain object with no `message` field), the handler
 *      substitutes the canonical fallback string `"Internal Server
 *      Error"` so clients always receive a non-empty, human-readable
 *      message — even for malformed errors.
 *   5. Stack-trace exposure is GATED on `NODE_ENV`:
 *        - `NODE_ENV === 'production'` → `err.stack` is OMITTED from
 *          the response body. Leaking stacks in production exposes
 *          internal file paths, library versions, and call-graph
 *          information attackers can use for reconnaissance.
 *        - `NODE_ENV !== 'production'` (e.g., 'development', 'test',
 *          undefined) → `err.stack` IS included in the response body
 *          to aid debugging during local development and CI runs.
 *   6. The handler logs the error via the project logger module
 *      (mocked via `jest.mock` at module-load time) so operators have
 *      a server-side record of every 500 even when the response body
 *      is sanitized. Logging happens exactly once per invocation —
 *      duplicate logs would inflate operational metrics and pollute
 *      log aggregation.
 *
 * Test strategy:
 *   - Mock `src/logger/index.js` via `jest.mock()` so the real Winston
 *     logger is never instantiated; this avoids any filesystem or
 *     transport overhead and provides `jest.fn()` spies on every log
 *     level (info, warn, error, debug) for call-count and call-args
 *     assertions. Per AAP 0.5.2: "Mock dependencies: src/logger/index.js;
 *     req/res/next mocks; process.env.NODE_ENV toggling."
 *   - Import req/res/next mocks from tests/fixtures/request.fixtures
 *     and tests/fixtures/response.fixtures (per AAP Section 0.5.5).
 *     Each factory invocation returns a fresh, mutually independent
 *     object/function so tests can be parallelized and run in arbitrary
 *     order without cross-test pollution (per AAP 0.4.4).
 *   - Mutate `process.env.NODE_ENV` in `beforeEach`/inside individual
 *     tests as needed for stack-gating coverage; capture the original
 *     env in `beforeEach` and restore it in `afterEach` so mutations
 *     never leak across tests or test files (per AAP 0.10.1: "Never
 *     write to `process.env` without restoring it"). The
 *     assigned-folder requirements explicitly permit this file to
 *     mutate NODE_ENV (the only middleware test that does so) because
 *     the handler's stack-exposure behavior depends on NODE_ENV.
 *   - Use the defensive resolution pattern
 *     `(module && module.errorHandler) || module` to support both
 *     `module.exports = errorHandler` and
 *     `module.exports = { errorHandler }` export styles. The export
 *     style is an implementation detail of the broader Express
 *     enhancement; the tests must not be coupled to it. The same
 *     pattern is used in tests/unit/middleware/notFoundHandler.test.js
 *     and tests/unit/middleware/requestLogger.test.js per AAP 0.10.1.
 *   - Synchronous assertions only — no `done()` callback, no
 *     `async`/`await` — because the middleware contract is synchronous
 *     (it issues `res.status().json()` inline and returns).
 *   - Inspect response bodies via `res.json.mock.calls[0][0]` rather
 *     than asserting a specific equality. This pattern allows the
 *     implementation flexibility in choosing the exact body shape
 *     (e.g., with or without a top-level `stack` field, with extra
 *     metadata fields, etc.) while still verifying contractual fields
 *     are present (per AAP 0.10.1 forward-compatibility guidance).
 *   - Detect stack presence via the OR pattern
 *     `(body.error && body.error.stack) || body.stack` — the exact
 *     location is an implementation detail that may vary; the tests
 *     check both common locations so they couple to the CONTRACT
 *     (stack present-or-absent based on env) rather than the EXACT
 *     IMPLEMENTATION layout.
 *
 * Mock dependencies (per AAP 0.5.2):
 *   - `src/logger/index.js` mocked via `jest.mock('../../../src/logger', ...)`
 *   - `req`/`res`/`next` via `tests/fixtures/request.fixtures.js` and
 *     `tests/fixtures/response.fixtures.js`
 *   - `process.env.NODE_ENV` toggled per-test, restored in `afterEach`
 *
 * Why mock the logger instead of using silenceLogger():
 *   For tests that ASSERT on logger behavior (call counts, arguments),
 *   a `jest.mock()` that returns `jest.fn()` per level is mandatory.
 *   The `silenceLogger()` helper from `tests/helpers/silenceLogger.js`
 *   routes real logger output to a silent transport — useful for tests
 *   that import the real logger as a side effect, but it provides no
 *   spies to assert against. `jest.mock()` gives us:
 *     - Fully isolated logger (no real Winston instance)
 *     - jest.fn() for each level (info/warn/error/debug)
 *     - Zero filesystem or transport overhead in tests
 *     - Direct assertions like `expect(logger.error).toHaveBeenCalledWith(...)`
 *
 * Why no `next()` assertions:
 *   The Express error handler is the LAST middleware in the chain — it
 *   is TERMINAL. It MAY call `next(err)` to forward unhandled errors to
 *   Express's default handler, but typically it does NOT call `next()`
 *   because the response has already been produced. This file does not
 *   assert on `next` calls because the handler's contract per AAP 0.4.3
 *   is "produce a response", not "propagate". Tests for `next()`
 *   propagation belong in integration tests where the full middleware
 *   chain is exercised.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS `require()` / `module.exports` (matches package.json's
 *     lack of "type": "module")
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline arrays/objects
 *   - Block hierarchy: `describe('Unit: ...')` -> `describe(scenario)` -> `it(...)`
 *   - Test names follow "should <expected behavior> when <condition>"
 *   - Arrange-Act-Assert pattern within each test
 *
 * Coordination note:
 *   The middleware at `src/middleware/errorHandler.js` and the logger
 *   factory at `src/logger/index.js` are created by the broader Express
 *   enhancement (NOT by this testing AAP). Until those files exist,
 *   every test below will fail at the `require()` step with
 *   MODULE_NOT_FOUND. This is expected and acceptable per AAP Section
 *   0.2.1 — the testing AAP and the broader enhancement are coordinated
 *   efforts. Once the middleware exists with the documented contract,
 *   all tests below pass.
 *
 * @module tests/unit/middleware/errorHandler.test
 */

// ---------------------------------------------------------------------------
// Mock setup — MUST be hoisted to the top of the module per Jest convention.
// ---------------------------------------------------------------------------
// jest.mock() calls are automatically hoisted by Jest's transformer to the
// top of the file BEFORE any require() statements execute. Placing them
// visually at the top documents intent and makes the hoisting explicit to
// readers. The factory function returns a plain object with jest.fn() for
// each log level. After this mock is in place, `require('../../../src/logger')`
// anywhere in this file (or in `src/middleware/errorHandler.js` when it
// transitively requires the logger) will resolve to this mock object.
//
// All four log levels (info/warn/error/debug) are pre-registered as jest.fn()
// even though the error handler is expected to call only `error`. The extras
// guarantee that an implementation which incorrectly calls `logger.info` or
// `logger.warn` does not crash with a TypeError ("logger.info is not a
// function"); instead, the test can assert
// `expect(logger.info).not.toHaveBeenCalled()` to catch the mis-routing.
jest.mock('../../../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — fixtures, mocked logger, and the middleware under test.
// ---------------------------------------------------------------------------
// Fixture factories produce fresh mock req/res/next per call (per AAP 0.4.4).
// Each test creates new instances so call counts, mock state, and chained
// state never leak across tests within this file.
const { mockRequest } = require('../../fixtures/request.fixtures');
const { mockResponse, mockNext } = require('../../fixtures/response.fixtures');

// The mocked logger module — `logger` here is the object returned by the
// jest.mock() factory above (NOT the real Winston logger). Tests can
// assert on logger.error.mock.calls, logger.error.mockImplementationOnce(),
// etc., to drive both happy-path and failure-path scenarios.
const logger = require('../../../src/logger');

// Defensive resolution: `src/middleware/errorHandler.js` may be authored
// to use either of two CommonJS export styles:
//   - default export:  module.exports = errorHandler;
//   - named export:    module.exports = { errorHandler };
// This double-pattern handles both transparently. If the module exports
// `{ errorHandler }`, the property access wins; otherwise we fall through
// to the module export itself (the function). The same pattern is used in
// tests/unit/middleware/notFoundHandler.test.js and
// tests/unit/middleware/requestLogger.test.js per AAP 0.10.1.
const errorHandlerModule = require('../../../src/middleware/errorHandler');
const errorHandler = (errorHandlerModule && errorHandlerModule.errorHandler) ||
  errorHandlerModule;

describe('Unit: src/middleware/errorHandler.js', () => {
  // -------------------------------------------------------------------------
  // Environment capture / restore
  // -------------------------------------------------------------------------
  // The error handler's stack-exposure behavior depends on `process.env.NODE_ENV`.
  // To exercise both branches (production / non-production) without leaking
  // env mutations across tests or test files, we capture the original env
  // at the start of every test and restore it at the end. The
  // assigned-folder requirements explicitly permit this file to mutate
  // NODE_ENV (the only middleware test that does so) because the handler's
  // behavior is env-dependent.
  //
  // The spread operator produces a SHALLOW COPY of `process.env`. Because
  // every value in `process.env` is a primitive string (Node coerces values
  // to strings at assignment time), shallow copying is sufficient — there
  // are no nested objects to deep-clone.
  //
  // jest.clearAllMocks() between tests is automatic via `clearMocks: true`
  // in jest.config.js, so we do NOT need to manually clear logger mocks
  // here; Jest resets `logger.error.mock.calls` (and friends) between every
  // test. Likewise `restoreMocks: true` handles `jest.spyOn()` cleanup
  // (none used in this file).
  let originalEnv;

  beforeEach(() => {
    // Capture original env so afterEach can restore. Cloning into a
    // brand-new object ensures restoration is full and clean.
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore env to prevent leakage. Without this, `NODE_ENV='production'`
    // set in one test would persist into subsequent tests in the same file
    // (and into other test files run by the same Jest worker, since Jest
    // may reuse workers across files).
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // Function signature (4-argument contract)
  // -------------------------------------------------------------------------
  // Express dispatches middleware based on its arity:
  //   - 3 args (req, res, next)        -> regular middleware
  //   - 4 args (err, req, res, next)   -> error-handling middleware
  // An ERROR HANDLER MUST be 4-argument middleware (arity 4) so Express
  // routes thrown/rejected errors to it. Arity 3 would cause Express to
  // treat the function as regular middleware (executed on every request)
  // and to skip it entirely on error propagation — exactly the OPPOSITE
  // of what we want.
  //
  // These assertions are the most fundamental contract: if either fails,
  // src/middleware/errorHandler.js exports the wrong shape entirely and
  // every other test below would also fail in confusing ways.
  describe('4-argument signature contract', () => {
    it('should be a function', () => {
      // Express middleware is always a function (callable). This catches
      // accidental object-literal exports or class-default exports that
      // would silently fail at app.use(errorHandler) registration time
      // with a confusing "argument handler must be a function" error.
      expect(typeof errorHandler).toBe('function');
    });

    it('should have arity 4 (err, req, res, next) — Express error handler', () => {
      // Function.prototype.length returns the number of declared parameters
      // (excluding rest params and those with default values). Express
      // inspects this exact property at registration time. Arity 3 would
      // cause Express to dispatch the middleware on EVERY request as
      // regular middleware (with the first param bound to req — wrong)
      // and to SKIP it on error propagation — exactly opposite of what
      // we want for an error handler. Arity 4 is the only correct value.
      expect(errorHandler.length).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: default 500 response
  // -------------------------------------------------------------------------
  // The "happy path" exercises the handler with normal, well-formed input
  // (an Error instance with a message, no statusCode override) and asserts
  // the documented behavior: respond with 500, JSON body of canonical shape
  // `{ error: { code, message } }`, log the error, leave next() untouched.
  // These tests cover the canonical use case — a generic application error
  // that bubbles up through the middleware stack.
  //
  // We pin NODE_ENV='test' inside beforeEach so these tests run in the
  // 'non-production' branch (per loadTestEnv.js + .env.test, NODE_ENV is
  // already 'test' by default; the explicit set documents the assumption).
  describe('Happy path: default 500 response', () => {
    beforeEach(() => {
      // Ensure deterministic env for happy-path tests. NODE_ENV is set to
      // 'test' by tests/fixtures/.env.test, but we re-assert it here in
      // case any prior describe block (or Jest worker reuse) has nudged it.
      process.env.NODE_ENV = 'test';
    });

    it('should respond with HTTP status 500 when err has no statusCode', () => {
      // Arrange — fresh mocks per test for isolation. The default Error
      // constructor produces an instance with .message and .stack but no
      // .statusCode, so the handler should fall back to 500.
      const err = new Error('Something went wrong');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — res.status(500) is the canary for the entire default
      // path. If the handler responds with any other code, every
      // downstream behavior (response shape, content-type, log content)
      // is suspect.
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should respond by calling res.json (sets Content-Type application/json)', () => {
      // Arrange — same shape as the prior test; the assertion target
      // differs.
      const err = new Error('Boom');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — res.json (rather than res.send or res.end) signals
      // structured JSON output. Express's res.json sets the
      // Content-Type to 'application/json' automatically; the mock
      // captures the call so tests can assert on the API the
      // middleware invoked. Asserting on res.json (not res.send) also
      // verifies the handler does NOT take the legacy path of writing
      // a stringified error directly to the body.
      expect(res.json).toHaveBeenCalled();
    });

    it('should send body with shape { error: { code, message } }', () => {
      // Arrange — choose a recognizable message so the assertion is
      // unambiguous if it leaks into the matcher output.
      const err = new Error('Specific failure');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — the body MUST contain a nested `error` envelope with
      // `code` (string) and `message` (string) fields. We use
      // expect.objectContaining at both levels so the assertion does
      // not over-specify: implementations may add fields (e.g., a
      // request id, a timestamp, a top-level `stack` in dev mode)
      // without breaking the test, while still requiring the canonical
      // contractual fields. expect.any(String) accepts any string value
      // for `code` so the implementation can choose its own coding
      // scheme (e.g., 'INTERNAL_SERVER_ERROR', 'E500', 'ERR_INTERNAL').
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: expect.any(String),
            message: expect.any(String),
          }),
        }),
      );
    });

    it('should include the original err.message in the body', () => {
      // Arrange — a unique sentinel string unlikely to collide with any
      // implementation-internal default text.
      const err = new Error('Original message');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — pull the body argument from the recorded call and
      // verify the message is preserved verbatim. This catches the
      // regression where the handler accidentally substitutes its own
      // message (e.g., always "Internal Server Error") instead of
      // forwarding the original.
      expect(res.json).toHaveBeenCalled();
      const bodyArg = res.json.mock.calls[0][0];
      expect(bodyArg).toBeDefined();
      expect(bodyArg.error).toBeDefined();
      expect(bodyArg.error.message).toBe('Original message');
    });

    it('should log the error via logger.error()', () => {
      // Arrange — message text is irrelevant here; we are asserting that
      // SOMETHING was logged via logger.error, not its specific content.
      const err = new Error('Logged error');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — at least one logger.error invocation. A handler that
      // silently swallows errors without logging would degrade
      // observability dramatically — operators would see 500s on the
      // wire with no corresponding server-side trace.
      expect(logger.error).toHaveBeenCalled();
    });

    it('should call res.status exactly once', () => {
      // Arrange
      const err = new Error('once');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — the handler should set the status code exactly once.
      // Multiple status calls would suggest accidental duplicate paths
      // (e.g., a default-500 set followed by a re-set on a different
      // branch).
      expect(res.status).toHaveBeenCalledTimes(1);
    });

    it('should call res.json exactly once', () => {
      // Arrange
      const err = new Error('once');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — exactly one JSON body emission. More than one would
      // crash the response in production (Node throws "Cannot set
      // headers after they are sent" on the second write).
      expect(res.json).toHaveBeenCalledTimes(1);
    });

    it('should mark the response as headersSent (state-side check)', () => {
      // Arrange — a complementary state-based assertion to the call-args
      // assertions above. The mockResponse flips `headersSent` to true
      // inside its res.json/res.send/res.end implementations, so a true
      // value here means a terminal method actually ran (vs. just being
      // called without effect).
      const err = new Error('Headers sent');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.headersSent).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases: custom statusCode overrides
  // -------------------------------------------------------------------------
  // Application code commonly attaches a statusCode property to errors to
  // indicate the desired HTTP response code (e.g., a validation library
  // throws an error with statusCode 422; an authorization layer throws
  // statusCode 403). The handler must respect these overrides and use the
  // attached code instead of the default 500. This is the primary way
  // application logic communicates intent through the error channel.
  //
  // The four tested codes (400, 403, 422, 401) cover the most common
  // 4xx categories: malformed request, forbidden, validation failure,
  // unauthenticated. Other 4xx and 5xx codes follow the same path; the
  // four chosen codes give comprehensive branch coverage without
  // exhaustive enumeration of every HTTP status.
  describe('Edge cases: custom statusCode overrides', () => {
    beforeEach(() => {
      // Pin to non-production for these tests — statusCode handling is
      // independent of NODE_ENV, but a deterministic env makes the
      // tests easier to reason about.
      process.env.NODE_ENV = 'test';
    });

    it('should respect err.statusCode === 400 (Bad Request)', () => {
      // Arrange — Error instance with explicit statusCode 400.
      const err = new Error('Bad request');
      err.statusCode = 400;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — res.status(400), NOT 500. If the handler ignores
      // err.statusCode, this assertion fails with the recorded value
      // being 500 — clearly identifying the missed override path.
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should respect err.statusCode === 401 (Unauthorized)', () => {
      // Arrange
      const err = new Error('Unauthenticated');
      err.statusCode = 401;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should respect err.statusCode === 403 (Forbidden)', () => {
      // Arrange — a recognizable scenario: an authorization layer
      // throws a 403 when an authenticated user lacks permission for
      // the requested resource. The handler should preserve the 403.
      const err = new Error('Access denied');
      err.statusCode = 403;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should respect err.statusCode === 404 (Not Found)', () => {
      // Arrange — programmatic 404s (vs. the route fall-through
      // notFoundHandler) are common when a controller looks up a
      // resource by ID and finds nothing. Such errors carry
      // statusCode=404 and should be reflected in the response.
      const err = new Error('Resource not found');
      err.statusCode = 404;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should respect err.statusCode === 422 (Unprocessable Entity)', () => {
      // Arrange — validation failures (e.g., from express-validator,
      // Joi, Zod) often surface with statusCode 422.
      const err = new Error('Validation failed');
      err.statusCode = 422;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(422);
    });

    it('should respect err.statusCode === 503 (Service Unavailable)', () => {
      // Arrange — non-500 5xx codes also pass through. A circuit
      // breaker tripping or an upstream timeout typically produces a
      // 503; the handler must preserve it rather than collapsing all
      // 5xx errors to 500.
      const err = new Error('Upstream unavailable');
      err.statusCode = 503;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('should default to 500 when err.statusCode is missing', () => {
      // Arrange — a stock Error has no statusCode. The handler must
      // fall back to 500 (the canonical "something went wrong" code).
      const err = new Error('No code');
      // err.statusCode deliberately not set
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should default to 500 when err.statusCode is undefined explicitly', () => {
      // Arrange — same as the prior test but with explicit undefined,
      // catching implementations that use `'statusCode' in err` (which
      // distinguishes "missing key" from "key set to undefined") rather
      // than truthy/falsy checks.
      const err = new Error('Explicit undefined');
      err.statusCode = undefined;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should not throw when err.statusCode is a non-numeric string', () => {
      // Arrange — defensive edge case: an error library that mistakenly
      // attaches a string statusCode would crash a handler that does
      // strict numeric comparison. The handler must accept the input
      // and produce SOME status (either coerced or fallback to 500).
      const err = new Error('Invalid code');
      err.statusCode = 'not-a-number';
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert — invocation must not throw, regardless of the
      // exact behavior chosen by the implementation (coerce vs. ignore).
      expect(() => errorHandler(err, req, res, next)).not.toThrow();

      // The handler must call res.status with SOME value — exact
      // semantics (numeric coercion vs. default 500) are an
      // implementation choice we do not over-specify here.
      expect(res.status).toHaveBeenCalled();
    });

    it('should preserve the body shape when statusCode is overridden', () => {
      // Arrange — overriding the statusCode should NOT change the
      // body shape; only the HTTP status should differ.
      const err = new Error('Validation failed');
      err.statusCode = 422;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — same `{ error: { code, message } }` envelope as
      // the default-500 path.
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: expect.any(String),
            message: expect.any(String),
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases: missing or non-standard message
  // -------------------------------------------------------------------------
  // The handler must produce a non-empty, human-readable response message
  // even when the upstream error is malformed (empty message, plain object
  // without a message field, etc.). Falling back to "Internal Server Error"
  // for empty messages prevents API clients from receiving confusing empty
  // strings or null values in the message field.
  describe('Edge cases: missing or non-standard message', () => {
    beforeEach(() => {
      // Pin to non-production — message handling is independent of
      // NODE_ENV, but a deterministic env makes tests easier to reason
      // about.
      process.env.NODE_ENV = 'test';
    });

    it('should fall back to "Internal Server Error" when err.message is empty', () => {
      // Arrange — `new Error('')` produces an instance whose .message
      // is an empty string (the empty string passes the Error
      // constructor check). The handler should detect this and
      // substitute the canonical fallback.
      const err = new Error('');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — pull the body and verify the fallback message.
      expect(res.json).toHaveBeenCalled();
      const bodyArg = res.json.mock.calls[0][0];
      expect(bodyArg).toBeDefined();
      expect(bodyArg.error).toBeDefined();
      expect(bodyArg.error.message).toBe('Internal Server Error');
    });

    it('should fall back to "Internal Server Error" when err.message is undefined', () => {
      // Arrange — explicit deletion of the message property simulates
      // a handcrafted error or a third-party library that constructs
      // errors without setting message at all.
      const err = new Error('temp');
      delete err.message;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — same fallback behavior expected.
      const bodyArg = res.json.mock.calls[0][0];
      expect(bodyArg).toBeDefined();
      expect(bodyArg.error).toBeDefined();
      expect(bodyArg.error.message).toBe('Internal Server Error');
    });

    it('should use err.message when present', () => {
      // Arrange — non-empty message should be forwarded verbatim.
      const err = new Error('Custom failure message');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — exact string match (not toContain / objectContaining)
      // because the contract is "preserve the message", not "include
      // the message somewhere".
      const bodyArg = res.json.mock.calls[0][0];
      expect(bodyArg.error.message).toBe('Custom failure message');
    });

    it('should not throw when err is a plain object (not an Error instance)', () => {
      // Arrange — Express middleware can receive non-Error values via
      // `next({ foo: 'bar' })`. A robust handler must accept any input
      // without crashing. We provide `message` and `statusCode` so the
      // handler has something to report.
      const err = { message: 'Plain object error', statusCode: 400 };
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert — invocation must not throw, and the handler
      // must produce both a status and a body.
      expect(() => errorHandler(err, req, res, next)).not.toThrow();
      expect(res.status).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalled();
    });

    it('should not throw when err is a plain object with no message', () => {
      // Arrange — defensive variant: plain object with NO message key
      // at all. The handler should still produce a sensible response
      // (presumably with the fallback message).
      const err = { statusCode: 500 };
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert
      expect(() => errorHandler(err, req, res, next)).not.toThrow();
      expect(res.json).toHaveBeenCalled();
      const bodyArg = res.json.mock.calls[0][0];
      // The body must include an `error.message` field, and it must
      // be non-empty (either the fallback or some other defaulted
      // value chosen by the implementation).
      expect(bodyArg.error).toBeDefined();
      expect(typeof bodyArg.error.message).toBe('string');
      expect(bodyArg.error.message.length).toBeGreaterThan(0);
    });

    it('should not throw when err is a string', () => {
      // Arrange — `next('Some error string')` is anti-pattern but
      // possible in older code; the handler must remain defensive.
      const err = 'Just a string error';
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert
      expect(() => errorHandler(err, req, res, next)).not.toThrow();
      expect(res.status).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Stack trace gating: development branch (NODE_ENV !== "production")
  // -------------------------------------------------------------------------
  // In any environment other than production, the handler MUST include
  // err.stack in the response body. The stack is invaluable for local
  // debugging and CI test triage — without it, developers must manually
  // correlate 500 responses to log entries on the server side, slowing
  // the development feedback loop dramatically.
  //
  // We test three "non-production" variants — 'development', 'test', and
  // undefined — to ensure the implementation correctly uses `!==` (or
  // equivalent) rather than only checking against 'development'. A naive
  // implementation that says `if (NODE_ENV === 'development') include
  // stack` would silently fail to include the stack in 'test' or
  // unset-env scenarios.
  //
  // The exact location of the stack in the body (`body.error.stack` vs.
  // `body.stack`) is an implementation detail that may vary; the tests
  // check both common locations via the OR pattern so they couple to the
  // CONTRACT (stack present) rather than the EXACT IMPLEMENTATION layout.
  describe('Stack trace gating: development branch (NODE_ENV !== "production")', () => {
    it('should include err.stack in response body when NODE_ENV is "development"', () => {
      // Arrange — explicitly set NODE_ENV to 'development' to exercise
      // the documented dev branch.
      process.env.NODE_ENV = 'development';
      const err = new Error('Dev error');
      // err.stack is auto-generated by the Error constructor with the
      // current call site; we don't need to set it explicitly.
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — pull the body and check for the stack at either of
      // the common locations.
      expect(res.json).toHaveBeenCalled();
      const bodyArg = res.json.mock.calls[0][0];
      expect(bodyArg).toBeDefined();
      const stackInBody = (bodyArg.error && bodyArg.error.stack) ||
        bodyArg.stack;
      // Stack must be DEFINED (truthy or empty string both acceptable;
      // toBeDefined accepts both). A real Error.stack is a multi-line
      // string starting with the error name+message and continuing
      // with frame entries.
      expect(stackInBody).toBeDefined();
    });

    it('should include err.stack when NODE_ENV is "test"', () => {
      // Arrange — 'test' is the most common non-production env in CI
      // and during local Jest runs. Stack inclusion in 'test' is what
      // makes failing tests easy to diagnose.
      process.env.NODE_ENV = 'test';
      const err = new Error('Test error');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      const bodyArg = res.json.mock.calls[0][0];
      const stackInBody = (bodyArg.error && bodyArg.error.stack) ||
        bodyArg.stack;
      expect(stackInBody).toBeDefined();
    });

    it('should include err.stack when NODE_ENV is undefined', () => {
      // Arrange — `delete process.env.NODE_ENV` removes the key
      // entirely, simulating a misconfigured deployment or a fresh
      // shell with no NODE_ENV set. Per the contract, the handler
      // treats anything other than 'production' as "include stack",
      // so undefined-NODE_ENV must also include the stack.
      delete process.env.NODE_ENV;
      const err = new Error('Undefined env');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      const bodyArg = res.json.mock.calls[0][0];
      const stackInBody = (bodyArg.error && bodyArg.error.stack) ||
        bodyArg.stack;
      expect(stackInBody).toBeDefined();
    });

    it('should include err.stack when NODE_ENV is empty string', () => {
      // Arrange — an empty-string NODE_ENV is an edge case that tools
      // like dotenv can produce when an env var is set to "". The
      // handler should treat '' as non-production and include the
      // stack.
      process.env.NODE_ENV = '';
      const err = new Error('Empty env');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      const bodyArg = res.json.mock.calls[0][0];
      const stackInBody = (bodyArg.error && bodyArg.error.stack) ||
        bodyArg.stack;
      expect(stackInBody).toBeDefined();
    });

    it('should include err.stack when NODE_ENV is "staging"', () => {
      // Arrange — non-canonical NODE_ENV values (e.g., 'staging',
      // 'qa', 'preview') should also trigger the dev branch. Only
      // EXACTLY 'production' should suppress the stack. This catches
      // implementations that whitelist instead of blacklist.
      process.env.NODE_ENV = 'staging';
      const err = new Error('Staging error');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      const bodyArg = res.json.mock.calls[0][0];
      const stackInBody = (bodyArg.error && bodyArg.error.stack) ||
        bodyArg.stack;
      expect(stackInBody).toBeDefined();
    });

    it('should preserve the stack content as a string when included', () => {
      // Arrange — beyond presence, the stack must be a STRING (not an
      // object or other shape). Real Error.stack is always a string;
      // a handler that wraps it in some structured envelope risks
      // breaking serialization expectations downstream.
      process.env.NODE_ENV = 'development';
      const err = new Error('String-typed stack');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      const bodyArg = res.json.mock.calls[0][0];
      const stackInBody = (bodyArg.error && bodyArg.error.stack) ||
        bodyArg.stack;
      expect(typeof stackInBody).toBe('string');
      // The stack should reference the originating error message at
      // its first line — a sanity check that we got the correct stack
      // (vs. an unrelated stub stack).
      expect(stackInBody).toContain('String-typed stack');
    });
  });

  // -------------------------------------------------------------------------
  // Stack trace gating: production branch (NODE_ENV === "production")
  // -------------------------------------------------------------------------
  // In production, the handler MUST OMIT err.stack from the response body.
  // Leaking stacks in production exposes:
  //   - Internal file paths (revealing code structure)
  //   - Library/framework versions (aiding CVE matching)
  //   - Module identifiers and call-graph relationships (aiding
  //     reconnaissance for chained exploits)
  // This is a security-sensitive contract; failing this test in
  // production builds would be a P0/P1 incident.
  //
  // The complementary contract (status code + error message still
  // present) is also tested here to guarantee the handler does not
  // over-correct and strip the entire response body — the body must
  // remain useful to API clients while not leaking internal details.
  describe('Stack trace gating: production branch (NODE_ENV === "production")', () => {
    beforeEach(() => {
      // Pin to production for every test in this block. afterEach
      // (in the outer describe) restores the original env so this
      // does not leak.
      process.env.NODE_ENV = 'production';
    });

    it('should omit err.stack from response body when NODE_ENV is "production"', () => {
      // Arrange
      const err = new Error('Prod error');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — pull the body and check that the stack is NOT
      // present at either common location.
      expect(res.json).toHaveBeenCalled();
      const bodyArg = res.json.mock.calls[0][0];
      const stackInBody = (bodyArg.error && bodyArg.error.stack) ||
        bodyArg.stack;
      // toBeUndefined() permits the stack key to be absent OR
      // explicitly set to undefined; both satisfy the "no stack"
      // contract.
      expect(stackInBody).toBeUndefined();
    });

    it('should still include error code in production', () => {
      // Arrange — the body must remain useful to clients even with
      // the stack stripped.
      const err = new Error('Prod error');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: expect.any(String),
          }),
        }),
      );
    });

    it('should still include error message in production', () => {
      // Arrange — the message is the human-readable explanation; it
      // must survive the production sanitization. (Whether the
      // handler chooses to use the original message or a generic
      // one is a separate decision; the contract here is "non-empty
      // string present".)
      const err = new Error('Prod error');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.any(String),
          }),
        }),
      );
    });

    it('should still respond with 500 status in production for default errors', () => {
      // Arrange — production stack suppression must not change the
      // status-code logic. Default 500 still applies.
      const err = new Error('Prod error');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should still honor err.statusCode overrides in production', () => {
      // Arrange — the statusCode override and stack-suppression
      // logic are independent. A 422 error in production stays 422.
      const err = new Error('Validation failed');
      err.statusCode = 422;
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(res.status).toHaveBeenCalledWith(422);
      // And no stack
      const bodyArg = res.json.mock.calls[0][0];
      const stackInBody = (bodyArg.error && bodyArg.error.stack) ||
        bodyArg.stack;
      expect(stackInBody).toBeUndefined();
    });

    it('should still log the error in production (logging is not gated)', () => {
      // Arrange — server-side logging is INDEPENDENT of
      // client-facing stack suppression. Operators need to see the
      // full error context (including stack via Winston transport)
      // even when the API response omits it. This test verifies the
      // logger is still called in production.
      const err = new Error('Prod error logged');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(logger.error).toHaveBeenCalled();
    });

    it('should not include stack at any nested location in production', () => {
      // Arrange — defense-in-depth: we want to ensure no
      // implementation accidentally tucks the stack in an unexpected
      // top-level field (e.g., body.debug, body.trace). Stringifying
      // the entire body and searching for the canonical stack-frame
      // marker 'at ' (which appears in Node Error stacks) is a
      // catch-all sentinel.
      const err = new Error('Prod no-stack-anywhere');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — the stringified body should NOT contain the stack
      // text. We use err.stack directly so the assertion remains
      // valid even if the implementation tweaks the stack format.
      const bodyArg = res.json.mock.calls[0][0];
      const bodyString = JSON.stringify(bodyArg);
      // err.stack always starts with "Error: <message>\n    at ..."
      // so its first 30 characters are a reasonable unique marker.
      const stackHead = err.stack.slice(0, 30);
      expect(bodyString).not.toContain(stackHead);
    });
  });

  // -------------------------------------------------------------------------
  // Logger interaction
  // -------------------------------------------------------------------------
  // Beyond the happy-path assertion that "logger.error was called", these
  // tests verify the FULL logger contract: exactly-once invocation,
  // identifying error info passed to the logger, no log on the wrong
  // level, and no extra logs from the handler itself.
  //
  // logger.error is the canonical level for errors (it is treated as a
  // 5xx-class signal by log aggregation tools). Routing handler errors
  // to logger.warn or logger.info would degrade alerting and dashboards.
  describe('Logger interaction', () => {
    beforeEach(() => {
      // Pin to non-production so logging is identical to development.
      process.env.NODE_ENV = 'test';
    });

    it('should call logger.error exactly once per invocation', () => {
      // Arrange
      const err = new Error('Logged');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — exactly one log emission per invocation. More than
      // one would inflate operational metrics (alerts, dashboards,
      // billing for log ingestion at scale).
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('should pass identifying error info to logger.error', () => {
      // Arrange — a unique sentinel string in the message so the
      // assertion is unambiguous regardless of how the handler
      // formats the log call (positional, structured, format string).
      const err = new Error('Specific log target');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — the handler's logger.error call must reference the
      // error in some form: either the Error instance itself, the
      // err.message string, or a structured object containing the
      // message field. We flatten the call args into a string and
      // search for the sentinel — this decouples the assertion from
      // the specific log format the implementation chose.
      expect(logger.error).toHaveBeenCalled();
      const callArgs = logger.error.mock.calls[0];
      const flattened = callArgs.map((arg) => {
        if (arg instanceof Error) {
          // Flatten Error to its message + stack so the sentinel is
          // findable regardless of whether the handler passed the
          // error itself, err.message, or err.stack.
          return `${arg.message} ${arg.stack || ''}`;
        }
        if (typeof arg === 'object' && arg !== null) {
          // Structured log objects: stringify so any nested message
          // field is searchable. JSON.stringify cannot serialize
          // Error directly (returns "{}"), so the Error path above
          // handles that case explicitly.
          try {
            return JSON.stringify(arg);
          } catch (e) {
            // Defensive fallback for circular references, which
            // JSON.stringify rejects with a TypeError. Fall back to
            // a coarse string representation so the assertion still
            // has something to search.
            return String(arg);
          }
        }
        return String(arg);
      }).join(' ');
      expect(flattened).toContain('Specific log target');
    });

    it('should NOT call logger.info, logger.warn, or logger.debug', () => {
      // Arrange — the handler's contract is to log at the `error`
      // level. Routing application errors to a non-error level would
      // bypass alerting based on log severity (a common production
      // observability pattern).
      const err = new Error('Level check');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — only logger.error fires; the other levels stay at
      // zero invocations.
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('should call logger.error exactly once even with non-Error err input', () => {
      // Arrange — defensive logging: even when err is a plain object
      // or string, the handler should produce exactly one log entry.
      // No log entry would degrade observability; multiple log
      // entries would inflate metrics.
      const err = { message: 'plain object' };
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('should call logger.error once per call across multiple invocations', () => {
      // Arrange — three distinct invocations should produce exactly
      // three log entries (one per invocation). This catches a
      // closure-captured counter or accidental memoization that
      // would log only the first call.
      const errs = [
        new Error('First'),
        new Error('Second'),
        new Error('Third'),
      ];

      // Act — three invocations with fresh mocks each time
      errs.forEach((err) => {
        const req = mockRequest();
        const res = mockResponse();
        const next = mockNext();
        errorHandler(err, req, res, next);
      });

      // Assert — total logger.error calls equals total handler
      // invocations. (Note: clearMocks: true in jest.config.js
      // resets logger.error between tests but NOT between invocations
      // within the same test.)
      expect(logger.error).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // Defensive / structural assertions
  // -------------------------------------------------------------------------
  // These tests verify miscellaneous defensive contracts not covered by
  // the dedicated category blocks above: synchronous execution, no
  // request-mutation, idempotency across invocations.
  describe('Defensive / structural assertions', () => {
    beforeEach(() => {
      // Pin env for determinism.
      process.env.NODE_ENV = 'test';
    });

    it('should not throw when invoked synchronously', () => {
      // Arrange + Act + Assert — the most basic defensive check:
      // the handler must complete without throwing for a stock
      // Error input. Throws here would crash the entire response
      // and leave the client hanging.
      const err = new Error('Synchronous test');
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      expect(() => errorHandler(err, req, res, next)).not.toThrow();
    });

    it('should not modify req.method or req.path', () => {
      // Arrange — set deterministic input values to compare against
      // post-invocation state.
      const err = new Error('No mutation');
      const req = mockRequest({ method: 'POST', path: '/api/test' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      errorHandler(err, req, res, next);

      // Assert — the handler should not mutate the request object.
      // Mutations could surprise downstream observers (request
      // loggers, telemetry, audit middleware) that read req after
      // the response is sent.
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/api/test');
    });

    it('should produce the same response shape for repeated calls with the same error', () => {
      // Arrange — idempotency check: the handler must not retain
      // state between invocations, so two calls with the same input
      // should produce identical output shape.
      const err = new Error('Idempotent');
      const req1 = mockRequest();
      const res1 = mockResponse();
      const req2 = mockRequest();
      const res2 = mockResponse();

      // Act — two distinct invocations with the same error.
      errorHandler(err, req1, res1, mockNext());
      errorHandler(err, req2, res2, mockNext());

      // Assert — both responses have the same status and body
      // structure. We compare by extracting the body and asserting
      // structural equality; reference equality is irrelevant
      // because each mockResponse returns a fresh object.
      const body1 = res1.json.mock.calls[0][0];
      const body2 = res2.json.mock.calls[0][0];
      expect(body1.error.message).toBe(body2.error.message);
      expect(body1.error.code).toBe(body2.error.code);
      // Both should have the same status arg.
      expect(res1.status.mock.calls[0][0]).toBe(res2.status.mock.calls[0][0]);
    });

    it('should produce fresh body objects on each call (no shared reference)', () => {
      // Arrange — defense against an implementation that pre-builds
      // a singleton body object and mutates it in place. Such an
      // implementation would break under concurrent requests,
      // because two simultaneous responses would share the same
      // body instance.
      const err = new Error('Fresh body');
      const req1 = mockRequest();
      const res1 = mockResponse();
      const req2 = mockRequest();
      const res2 = mockResponse();

      // Act
      errorHandler(err, req1, res1, mockNext());
      errorHandler(err, req2, res2, mockNext());

      // Assert — the body objects are DISTINCT references even
      // though they have the same content.
      const body1 = res1.json.mock.calls[0][0];
      const body2 = res2.json.mock.calls[0][0];
      expect(body1).not.toBe(body2);
    });
  });
});

