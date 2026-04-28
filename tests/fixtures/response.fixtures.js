'use strict';

/**
 * tests/fixtures/response.fixtures.js
 *
 * Express Response and `next` callback mock factories for middleware
 * unit tests.
 *
 * Provides:
 *   - `mockResponse()` — returns a chainable Partial<express.Response>
 *     with every method backed by `jest.fn()` for assertion of call
 *     counts, arguments, and ordering.
 *   - `mockNext()`     — returns a fresh `jest.fn()` suitable for use
 *     as the Express middleware `next` callback.
 *
 * Each invocation of either factory returns a brand-new object/function
 * with no shared state, so tests can be parallelized and run in arbitrary
 * order without cross-test pollution. This matches the per-call freshness
 * contract documented in AAP Section 0.4.4 ("named factory functions
 * rather than singleton objects, enabling per-test customization without
 * cross-test pollution").
 *
 * Used by every test file under tests/unit/middleware/ (per AAP 0.5.5):
 *   - tests/unit/middleware/requestLogger.test.js
 *   - tests/unit/middleware/errorHandler.test.js
 *   - tests/unit/middleware/notFoundHandler.test.js
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS `require()`/`module.exports` (matches package.json's
 *     lack of "type": "module")
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline literals
 *   - Factory pattern (not singletons) per AAP 0.4.4 — each call returns
 *     a fresh object/function so test mutations never leak across calls
 *   - Framework-agnostic public API; uses `jest.fn()` internally because
 *     this fixture is only ever consumed inside Jest test files where
 *     the `jest` global is present (per Jest 30's automatic globals
 *     injection in test environments)
 *
 * Usage (canonical pattern from AAP Section 0.5.5 and 0.6.2):
 *
 *   const { mockResponse, mockNext } = require('../../fixtures/response.fixtures');
 *
 *   // From tests/integration/: require('../fixtures/response.fixtures')
 *
 *   describe('errorHandler', () => {
 *     it('should respond with 500 JSON when err has no statusCode', () => {
 *       const res = mockResponse();
 *       const next = mockNext();
 *       const err = new Error('boom');
 *
 *       errorHandler(err, {}, res, next);
 *
 *       expect(res.status).toHaveBeenCalledWith(500);
 *       expect(res.json).toHaveBeenCalledWith(
 *         expect.objectContaining({ error: expect.any(Object) })
 *       );
 *       expect(res.statusCode).toBe(500);
 *       expect(res.headersSent).toBe(true);
 *       expect(next).not.toHaveBeenCalled();
 *     });
 *   });
 *
 * @module tests/fixtures/response.fixtures
 */

/**
 * Build a chainable Partial<express.Response> for use in middleware unit
 * tests. Every method is backed by `jest.fn()` and returns the response
 * itself, supporting natural chaining like:
 *
 *   res.status(200).json({ ok: true });
 *   res.status(404).set('X-Reason', 'not-found').end();
 *
 * After the middleware runs, tests can introspect via two complementary
 * paths:
 *
 *   // 1) Call-args assertions (verifies the API was invoked correctly)
 *   expect(res.status).toHaveBeenCalledWith(200);
 *   expect(res.json).toHaveBeenCalledWith({ ok: true });
 *
 *   // 2) State assertions (verifies the side effects were applied)
 *   expect(res.statusCode).toBe(200);
 *   expect(res.headersSent).toBe(true);
 *   expect(res._jsonBody).toEqual({ ok: true });
 *   expect(res._headers['content-type']).toBe('application/json');
 *
 * Implementation notes:
 *   - Each chainable method uses the closure-captured `res` reference so
 *     all methods return the SAME instance (true chainability with stable
 *     identity) — `res.status(200) === res` is guaranteed.
 *   - Headers are stored in a lowercased internal table (`res._headers`)
 *     to mirror Express's case-insensitive header lookup behavior.
 *   - `res.set`, `res.header`, and `res.setHeader` are SEPARATE `jest.fn()`
 *     instances even though they perform the same operation; tests must
 *     assert against the specific method actually invoked by the code
 *     under test (matches Express runtime semantics).
 *
 * Forward compatibility: additional chainable methods (e.g., `cookie`,
 * `redirect`, `sendFile`) may be added later without breaking existing
 * callers because the API surface only grows. Tests that need such
 * methods today can attach them ad-hoc to the returned object.
 *
 * @returns {Object} A fresh Partial<express.Response> with chainable
 *   `jest.fn()` methods (`status`, `json`, `send`, `end`, `sendStatus`,
 *   `setHeader`, `getHeader`, `set`, `header`, `type`) and inspectable
 *   internal state (`statusCode`, `headersSent`, `_headers`, `locals`,
 *   `_jsonBody`, `_sentBody`, `_endBody`).
 */
function mockResponse() {
  // Capture `res` in the closure so every method below can return the
  // same object instance, supporting natural chaining like
  // `res.status(200).json({...}).end()`. Returning `this` from inside a
  // jest.fn() arrow callback would be `undefined` in strict mode, so the
  // closure pattern is required.
  const res = {};

  // -------------------------------------------------------------------------
  // Initial state — values match Express's documented defaults so tests
  // observing these properties see the same starting state they would in
  // a real Express response before any middleware has acted on it.
  // -------------------------------------------------------------------------

  // Default status code on a fresh Express response is 200 (set lazily by
  // the underlying http.ServerResponse). Tests asserting "no status was
  // explicitly set" should check call counts on res.status (not statusCode
  // equality), because the default is observable here regardless.
  res.statusCode = 200;

  // headersSent flips to true the moment json/send/end/sendStatus is
  // called. Middleware that calls one of those terminal methods is
  // expected to leave this flag set.
  res.headersSent = false;

  // Internal lowercased header table. Direct access (e.g.,
  // res._headers['content-type']) provides a state-based assertion path
  // complementary to the call-args path on res.setHeader.
  res._headers = {};

  // res.locals is Express's documented per-request scratchpad for
  // inter-middleware data sharing. Tests that exercise middleware which
  // populates res.locals can assert on this object directly.
  res.locals = {};

  // -------------------------------------------------------------------------
  // Terminal / status methods (chainable)
  // -------------------------------------------------------------------------

  // res.status(code) — sets the status code and returns `res` for
  // chaining. Tests can assert either via call args
  // (expect(res.status).toHaveBeenCalledWith(200)) or via state
  // (expect(res.statusCode).toBe(200)).
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });

  // res.json(body) — sends a JSON-serialized body, marks headers sent,
  // captures the body on `_jsonBody` for inspection. The mock does not
  // perform the actual JSON.stringify call (no real socket exists) — it
  // only records the input.
  res.json = jest.fn((body) => {
    res.headersSent = true;
    res._jsonBody = body;
    return res;
  });

  // res.send(body) — sends an arbitrary body (string | Buffer | object).
  // Marks headers sent and captures the body on `_sentBody`. Real Express
  // dispatches to `res.json` internally for object bodies; the mock keeps
  // these paths distinct so tests can assert the exact API the
  // middleware called.
  res.send = jest.fn((body) => {
    res.headersSent = true;
    res._sentBody = body;
    return res;
  });

  // res.end([body]) — terminal method ending the response. Body argument
  // is optional (callers may pass nothing for an empty 204-style end).
  // The mock only records `_endBody` when a body was actually supplied
  // so tests can distinguish `res.end()` from `res.end('')`.
  res.end = jest.fn((body) => {
    res.headersSent = true;
    if (body !== undefined) {
      res._endBody = body;
    }
    return res;
  });

  // res.sendStatus(code) — Express convenience that sets the status AND
  // sends the standard status text (e.g., sendStatus(200) sends 'OK').
  // The mock simulates both side effects (statusCode + headersSent) so
  // middleware that calls sendStatus is observable on both paths.
  res.sendStatus = jest.fn((code) => {
    res.statusCode = code;
    res.headersSent = true;
    return res;
  });

  // -------------------------------------------------------------------------
  // Header manipulation methods (chainable)
  // -------------------------------------------------------------------------

  // res.setHeader(name, value) — Node.js http.ServerResponse signature.
  // Stores the value under a lowercased key so res.getHeader is
  // case-insensitive (mirrors Node/Express runtime behavior).
  res.setHeader = jest.fn((name, value) => {
    res._headers[String(name).toLowerCase()] = value;
    return res;
  });

  // res.getHeader(name) — returns the value previously stored via any of
  // setHeader/set/header/type. Lowercases the lookup key so calls with
  // mixed-case header names ('Content-Type', 'content-type') match.
  // Returns `undefined` for unset headers (matches Node's behavior).
  res.getHeader = jest.fn((name) => {
    return res._headers[String(name).toLowerCase()];
  });

  // -------------------------------------------------------------------------
  // Express-aliased methods (chainable, separate jest.fn instances)
  // -------------------------------------------------------------------------
  //
  // res.set, res.header, and res.type are all shorthand for setting
  // headers in idiomatic Express. They are SEPARATE jest.fn instances
  // from setHeader so tests can assert against the specific method the
  // middleware actually called. Calling res.set does NOT register a
  // call on res.setHeader (matches real Express runtime semantics).

  // res.set(name, value) — Express's idiomatic header setter.
  res.set = jest.fn((name, value) => {
    res._headers[String(name).toLowerCase()] = value;
    return res;
  });

  // res.header(name, value) — alias for res.set; same behavior.
  res.header = jest.fn((name, value) => {
    res._headers[String(name).toLowerCase()] = value;
    return res;
  });

  // res.type(contentType) — convenience setter for the Content-Type
  // header. Real Express resolves MIME shortcuts ('json' -> 'application/json')
  // via the `mime-types` package; the mock stores the raw input verbatim
  // so tests asserting `expect(res.type).toHaveBeenCalledWith('json')`
  // observe what the middleware actually passed.
  res.type = jest.fn((contentType) => {
    res._headers['content-type'] = contentType;
    return res;
  });

  return res;
}

/**
 * Build a fresh `next` callback (Express middleware control-flow function)
 * backed by `jest.fn()` for assertion of:
 *
 *   - call count    : expect(next).toHaveBeenCalledTimes(1)
 *   - call arguments: expect(next).toHaveBeenCalledWith()      // no args
 *                     expect(next).toHaveBeenCalledWith(err)   // with error
 *   - non-invocation: expect(next).not.toHaveBeenCalled()
 *
 * Each invocation returns a brand-new `jest.fn()` instance with no shared
 * call history, so tests in different files (or different `it` blocks)
 * never observe each other's `next` calls.
 *
 * Per AAP Section 0.4.4 the spec is intentionally minimal:
 *
 *   mockNext() → jest.fn() (Express 'next' callback)
 *
 * No `.error()` shorthand or other extensions are added — tests pass an
 * `Error` instance directly via `next(err)` to exercise error-flow
 * propagation through the middleware chain.
 *
 * @returns {jest.Mock} A fresh `jest.fn()` suitable for use as Express's
 *   `next` callback in middleware unit tests.
 */
function mockNext() {
  return jest.fn();
}

module.exports = {
  mockResponse,
  mockNext,
};
