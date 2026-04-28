'use strict';

/**
 * tests/unit/middleware/requestLogger.test.js
 *
 * Unit tests for the Express request-logging middleware at
 * `src/middleware/requestLogger.js`.
 *
 * Test contracts verified:
 *   1. The middleware is a function with arity 3 (req, res, next) —
 *      arity 4 would make it an Express error handler, which we do
 *      NOT want. Express dispatches 3-arg middleware on every
 *      request and 4-arg middleware only when an error is in flight.
 *   2. Logs req.method and req.path via the project logger module
 *      (mocked via jest.mock at module-load time).
 *   3. Calls next() exactly once with no error argument so the
 *      request continues through the middleware chain.
 *   4. Does NOT modify the response body — a request logger is a
 *      transparent observer, not a terminal handler.
 *   5. Is RESILIENT: when the logger throws (e.g. a transport crash,
 *      a disk-full ENOSPC, a network timeout to a syslog host), the
 *      middleware still calls next() so the request is not blocked
 *      by a logging failure. Failing user requests because of a
 *      logging problem would degrade application availability.
 *   6. Handles edge cases gracefully: missing User-Agent header,
 *      missing X-Request-ID header, very long paths, paths with
 *      special characters, and multiple sequential invocations.
 *
 * Test strategy:
 *   - Mock `src/logger/index.js` via jest.mock() so the real Winston
 *     logger is never instantiated; this avoids any filesystem or
 *     transport overhead and provides jest.fn() spies on every log
 *     level (info, warn, error, debug) for call-count and call-args
 *     assertions.
 *   - Import req/res/next mocks from tests/fixtures/request.fixtures
 *     and tests/fixtures/response.fixtures (per AAP Section 0.5.5).
 *     These factory functions return fresh, mutually independent
 *     objects per call, supporting parallel test execution and
 *     test-order-independence.
 *   - Use JSON.stringify() of `logger.info.mock.calls[0]` plus
 *     `.toContain(...)` to verify presence of method/path tokens.
 *     This decouples the test from a specific log format — whether
 *     the implementation passes positional args (`logger.info('GET',
 *     '/path')`), structured objects (`logger.info({method, path})`),
 *     format strings (`logger.info('%s %s', method, path)`), or any
 *     combination, the assertion still passes.
 *   - Use mockImplementationOnce() to simulate one-shot logger
 *     failures without polluting subsequent tests.
 *   - Use synchronous assertion patterns — no done() callbacks,
 *     no async/await — because the middleware contract per AAP
 *     0.4.3 is synchronous (next() is called inline after logging).
 *
 * Mock dependencies (per AAP 0.5.2):
 *   - `src/logger/index.js` mocked via jest.mock('../../../src/logger')
 *   - req/res/next via tests/fixtures/request.fixtures.js and
 *     tests/fixtures/response.fixtures.js
 *
 * Why mock the logger instead of using silenceLogger():
 *   For tests that ASSERT on logger behavior (call counts, arguments),
 *   a jest.mock() that returns jest.fn() per level is mandatory. The
 *   silenceLogger() helper from tests/helpers/silenceLogger.js routes
 *   real logger output to a silent transport — useful for tests that
 *   import the real logger as a side effect, but it provides no spies
 *   to assert against. jest.mock() gives us:
 *     - Fully isolated logger (no real Winston instance)
 *     - jest.fn() for each level (info/warn/error/debug)
 *     - Zero filesystem or transport overhead in tests
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports (matches package.json's
 *     lack of "type": "module")
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline arrays/objects
 *   - Block hierarchy: describe('Unit: ...') -> describe(scenario) -> it(...)
 *   - Test names follow "should <expected behavior> when <condition>"
 *   - Arrange-Act-Assert pattern within each test
 *
 * Coordination note:
 *   The middleware at `src/middleware/requestLogger.js` and the logger
 *   factory at `src/logger/index.js` are created by the broader
 *   Express enhancement (NOT by this testing AAP). Until those files
 *   exist, every test below will fail at the require() step with
 *   MODULE_NOT_FOUND. This is expected and acceptable per AAP
 *   Section 0.2.1 — the testing AAP and the broader enhancement are
 *   coordinated efforts. Once the middleware exists with the documented
 *   contract, all tests below pass.
 *
 * @module tests/unit/middleware/requestLogger.test
 */

// ---------------------------------------------------------------------------
// Mock setup — MUST be hoisted to the top of the module per Jest convention.
// ---------------------------------------------------------------------------
// jest.mock() calls are automatically hoisted by Jest's transformer to the
// top of the file BEFORE any require() statements execute. Placing them
// visually at the top documents intent and makes the hoisting explicit to
// readers. The factory function returns a plain object with jest.fn() for
// each log level. After this mock is in place, `require('../../../src/logger')`
// anywhere in this file (or in `src/middleware/requestLogger.js` when it
// transitively requires the logger) will resolve to this mock object.
//
// All four log levels (info/warn/error/debug) are pre-registered as jest.fn()
// even though the request logger is expected to call only `info`. The extras
// guarantee that an implementation which incorrectly calls `logger.warn` or
// `logger.error` does not crash with a TypeError ("logger.warn is not a
// function"); instead, the test can assert `expect(logger.warn).not.toHaveBeenCalled()`
// to catch the mis-routing.
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
// assert on logger.info.mock.calls, logger.info.mockImplementationOnce(),
// etc., to drive both happy-path and failure-path scenarios.
const logger = require('../../../src/logger');

// Defensive resolution: `src/middleware/requestLogger.js` may be authored
// to use either of two CommonJS export styles:
//   - default export:  module.exports = requestLogger;
//   - named export:    module.exports = { requestLogger };
// This double-pattern handles both transparently. If the module exports
// `{ requestLogger }`, the destructure-style access wins; otherwise we
// fall through to the module export itself (the function). Same pattern
// is used in tests/unit/middleware/errorHandler.test.js per AAP 0.10.1.
const requestLoggerModule = require('../../../src/middleware/requestLogger');
const requestLogger = (requestLoggerModule && requestLoggerModule.requestLogger) ||
  requestLoggerModule;

describe('Unit: src/middleware/requestLogger.js', () => {
  // -------------------------------------------------------------------------
  // Function signature
  // -------------------------------------------------------------------------
  // Express dispatches middleware based on its arity:
  //   - 3 args (req, res, next)        -> regular middleware
  //   - 4 args (err, req, res, next)   -> error-handling middleware
  // A request LOGGER must be regular middleware (arity 3) so it runs on
  // every request, not only when an error is already in flight. These
  // assertions are the most fundamental contract: if either fails,
  // src/middleware/requestLogger.js exports the wrong shape entirely.
  describe('Function signature', () => {
    it('should be a function', () => {
      // Express middleware is always a function (callable). This catches
      // accidental object-literal exports or class-default exports.
      expect(typeof requestLogger).toBe('function');
    });

    it('should have arity 3 (req, res, next) — NOT an error handler', () => {
      // Function.prototype.length returns the number of declared parameters
      // (excluding rest params and those with default values). Express
      // inspects this exact property at registration time. Arity 4 would
      // cause Express to skip the middleware on normal requests and only
      // invoke it when an error has been thrown — wrong for a logger.
      expect(requestLogger.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: logs request information
  // -------------------------------------------------------------------------
  // The "happy path" exercises the middleware with normal, well-formed
  // input and asserts the documented behavior: log once, call next() once,
  // do not touch the response. These tests cover the canonical use case
  // — a typical incoming HTTP request with method and path.
  describe('Happy path: logs request information', () => {
    it('should call logger.info exactly once', () => {
      // Arrange — fresh request/response/next mocks per test for isolation.
      const req = mockRequest({ method: 'GET', path: '/api/v1/users' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      requestLogger(req, res, next);

      // Assert — exactly one log emission per request. More than one would
      // suggest accidental duplicate logging (a common bug when the same
      // middleware is registered twice or wraps a finish/close listener
      // that fires the logger again on response end).
      expect(logger.info).toHaveBeenCalledTimes(1);
    });

    it('should include req.method in the log', () => {
      // Arrange — POST chosen specifically because 'POST' as a string
      // never appears coincidentally in path segments or other request
      // data, making toContain('POST') a clean signal for the method.
      const req = mockRequest({ method: 'POST', path: '/api/v1/users' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      requestLogger(req, res, next);

      // Assert — verify logger was invoked, then inspect the serialized
      // call args for the method token. Using JSON.stringify on the call
      // arguments array decouples the test from the specific log format
      // (positional, structured, format-string — all serialize to a
      // string containing 'POST' somewhere).
      expect(logger.info).toHaveBeenCalled();
      const callArgsString = JSON.stringify(logger.info.mock.calls[0]);
      expect(callArgsString).toContain('POST');
    });

    it('should include req.path in the log', () => {
      // Arrange — '/health' is a recognizable, unique token unlikely
      // to appear in any default log envelope or boilerplate, so
      // toContain('/health') is unambiguous.
      const req = mockRequest({ method: 'GET', path: '/health' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      requestLogger(req, res, next);

      // Assert
      expect(logger.info).toHaveBeenCalled();
      const callArgsString = JSON.stringify(logger.info.mock.calls[0]);
      expect(callArgsString).toContain('/health');
    });

    it('should call next() exactly once', () => {
      // Arrange — defaults are sufficient; the assertion is about
      // control flow, not request content.
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      requestLogger(req, res, next);

      // Assert — exactly one next() invocation. Zero would mean the
      // middleware swallowed the request (causing a hang in production);
      // two or more would propagate the request twice through the chain.
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should call next() with no error argument', () => {
      // Arrange
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      requestLogger(req, res, next);

      // Assert — when a request logger calls next() with an Error instance
      // (or any truthy value), Express treats it as an error and skips
      // forward to the error-handling middleware. A logger should NEVER
      // do that; logging is a side effect, not a request-failing event.
      expect(next).toHaveBeenCalled();
      const nextCallArgs = next.mock.calls[0];
      // The first call to next() may have zero arguments (next()) or
      // a single falsy argument (next(undefined)/next(null)). Both are
      // acceptable; only a truthy arg would route to the error chain.
      if (nextCallArgs.length > 0) {
        expect(nextCallArgs[0]).toBeFalsy();
      }
    });

    it('should not modify the response body (no res.json/.send/.end calls)', () => {
      // Arrange — fresh response mock; response method spies start at zero.
      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act
      requestLogger(req, res, next);

      // Assert — a request logger is a TRANSPARENT OBSERVER. It logs
      // information about the request and yields control to the next
      // middleware via next(). It must NEVER call res.json(), res.send(),
      // or res.end() — doing so would terminate the response chain and
      // prevent downstream route handlers from executing. This catches
      // the regression where a logger mistakenly calls a response
      // terminator (e.g., refactored from an error handler).
      expect(res.json).not.toHaveBeenCalled();
      expect(res.send).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });

    it('should not modify req.method or req.path', () => {
      // Arrange — set deterministic input values to compare against
      // post-invocation state.
      const req = mockRequest({ method: 'GET', path: '/test' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      requestLogger(req, res, next);

      // Assert — the middleware should not mutate the request object.
      // Even if it generates a request ID and attaches it to req.id,
      // the existing method/path fields must remain unchanged so
      // downstream middleware sees the original values.
      expect(req.method).toBe('GET');
      expect(req.path).toBe('/test');
    });
  });

  // -------------------------------------------------------------------------
  // HTTP method coverage
  // -------------------------------------------------------------------------
  // Express applications accept any of the standard HTTP verbs. The
  // request logger should treat them uniformly — it logs whichever
  // method the request carries. These data-driven tests use forEach()
  // to generate one `it` block per method, ensuring symmetric coverage
  // and explicit per-method test names in the Jest output.
  describe('HTTP method coverage', () => {
    // The five most common verbs in REST APIs. Adding HEAD/OPTIONS/CONNECT/
    // TRACE here is forward-compatible — extending the array adds tests
    // without restructuring existing assertions.
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

    methods.forEach((method) => {
      it(`should log ${method} requests`, () => {
        // Arrange — same shape per method; only the method name varies.
        const req = mockRequest({ method, path: '/api/test' });
        const res = mockResponse();
        const next = mockNext();

        // Act
        requestLogger(req, res, next);

        // Assert — three checks: logger fired, next() was called, and
        // the method token appears somewhere in the log payload.
        expect(logger.info).toHaveBeenCalled();
        expect(next).toHaveBeenCalledTimes(1);
        const callArgsString = JSON.stringify(logger.info.mock.calls[0]);
        expect(callArgsString).toContain(method);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases: missing headers
  // -------------------------------------------------------------------------
  // Production middleware must not crash when optional headers are
  // absent. These tests exercise the defensive paths in the middleware
  // — if it tries to read req.headers['user-agent'] without a fallback
  // and the header is missing, the test catches the resulting undefined
  // dereference or unintended log content.
  describe('Edge cases: missing headers', () => {
    it('should handle missing User-Agent header gracefully', () => {
      // Arrange — empty headers object simulates a request from a
      // minimal client (e.g., curl --silent without -H, or a
      // synthetic load-test tool that omits User-Agent).
      const req = mockRequest({ headers: {} });
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert — the middleware MUST NOT throw; it should
      // log whatever metadata it has (method, path) and call next().
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should handle missing X-Request-ID header gracefully', () => {
      // Arrange — most clients do NOT send X-Request-ID; the
      // middleware may generate one when absent (per AAP 0.4.3
      // edge-case enumeration), but that generation must not
      // require an existing header to be present.
      const req = mockRequest({ headers: {} });
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should handle requests with empty headers object', () => {
      // Arrange — same as the two prior tests but explicit about the
      // logging side effect. The middleware should still log even
      // when headers are empty (the method/path are independently
      // available on the request).
      const req = mockRequest({ headers: {} });
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalled();
    });

    it('should handle requests with rich headers', () => {
      // Arrange — a fully populated header set matching what a real
      // production client (e.g., a browser or instrumented HTTP
      // library) might send. Verifies the middleware gracefully
      // accepts comprehensive headers without throwing.
      const req = mockRequest({
        method: 'POST',
        path: '/api/users',
        headers: {
          'User-Agent': 'TestAgent/1.0',
          'X-Request-ID': 'test-id-12345',
          'Content-Type': 'application/json',
        },
      });
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases: large request paths
  // -------------------------------------------------------------------------
  // RFC 7230 imposes no hard limit on URL length; well-known servers
  // (Apache, nginx) cap at ~8KB by default but Node.js itself accepts
  // longer URLs. The middleware must not crash on long or unusual paths.
  describe('Edge cases: large request paths', () => {
    it('should handle very long paths without throwing', () => {
      // Arrange — 2000+ char path simulates a degenerate input
      // (e.g., a misconfigured client appending state to the URL,
      // or a malicious request probing buffer limits).
      const longPath = '/api/' + 'a'.repeat(2000);
      const req = mockRequest({ method: 'GET', path: longPath });
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert — the middleware should log the path (truncated
      // or not, that's an implementation choice) and call next().
      // A throw here would indicate a hard limit in the middleware
      // that production traffic could trip.
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should handle paths with special characters', () => {
      // Arrange — paths can legitimately contain hyphens, underscores,
      // dots, tildes, percent-encoded sequences, and other RFC 3986
      // unreserved/reserved characters. The middleware must accept
      // them all without escaping or rejecting.
      const specialPath = '/api/with-special_chars.~/test%20space';
      const req = mockRequest({ method: 'GET', path: specialPath });
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should handle deeply nested paths', () => {
      // Arrange — REST-style nested resource paths are common
      // (e.g., /api/v1/users/:userId/posts/:postId/comments/:commentId).
      // Although fixed-length, deep nesting exercises any path-parsing
      // logic in the middleware.
      const deepPath = '/api/v1/users/12345/posts/67890/comments/abcdef';
      const req = mockRequest({ method: 'GET', path: deepPath });
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert — deeply nested paths should log normally.
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(logger.info).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error resilience: logger throws
  // -------------------------------------------------------------------------
  // CRITICAL contract per AAP 0.4.3: if the logger throws (transport
  // crash, disk-full ENOSPC, network timeout to a syslog host, or any
  // other transient failure), the middleware MUST still call next()
  // so the user's request continues. A logging failure is NOT an
  // application error — failing requests because of a logging problem
  // would degrade availability unnecessarily. The implementation should
  // wrap the log emission in try/catch (or equivalent) and swallow
  // any caught exception silently (or via console.error, but never
  // by re-throwing or by passing the error to next()).
  describe('Error resilience: logger throws', () => {
    it('should still call next() when logger.info throws', () => {
      // Arrange — mockImplementationOnce overrides the mock for ONE
      // call only, simulating a single transient failure. Subsequent
      // tests revert to the default behavior (no-op jest.fn()).
      logger.info.mockImplementationOnce(() => {
        throw new Error('Logger crashed!');
      });

      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert — per AAP 0.4.3: "logger throws -> middleware
      // does not propagate the throw to next(); next() is still called".
      // The middleware must swallow the throw and continue the chain.
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should not propagate the logger throw via next(err)', () => {
      // Arrange — same one-shot throw, different assertion focus.
      logger.info.mockImplementationOnce(() => {
        throw new Error('Logger crashed!');
      });

      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalled();
      const nextCallArgs = next.mock.calls[0];
      // If next() was called with any argument, it MUST NOT be the
      // logger error (or any truthy value). The middleware should
      // swallow the failure entirely so Express does not route the
      // user's request to the error handler.
      if (nextCallArgs.length > 0) {
        expect(nextCallArgs[0]).toBeFalsy();
      }
    });

    it('should not throw synchronously when logger fails with a TypeError', () => {
      // Arrange — different error subclass to verify the middleware's
      // catch block is generic (catches Error and all subclasses).
      // A naive `try { ... } catch (e) { if (e instanceof MyError) ... }`
      // would let other error types escape; a generic catch handles all.
      logger.info.mockImplementationOnce(() => {
        throw new TypeError('Cannot read property of null');
      });

      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert — synchronous throws of any Error subtype must
      // be caught and swallowed by the middleware.
      expect(() => requestLogger(req, res, next)).not.toThrow();
    });

    it('should call next() even when logger throws on every call', () => {
      // Arrange — mockImplementation (no "Once") sets a permanent
      // override that affects every call to logger.info within this
      // test. Useful for asserting consistent behavior under sustained
      // failure (vs. a one-shot transient).
      logger.info.mockImplementation(() => {
        throw new Error('Always crashes');
      });

      const req = mockRequest();
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert
      expect(() => requestLogger(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);

      // Cleanup — mockImplementation persists across tests within the
      // file. Although clearMocks: true in jest.config.js handles
      // .mockClear() (call-history cleanup) between tests, it does
      // NOT reset .mockImplementation() overrides. mockReset() is
      // explicit about returning the mock to a default jest.fn()
      // (no-op) state for any subsequent tests in this describe block.
      logger.info.mockReset();
      logger.info.mockImplementation(() => {});
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency and isolation
  // -------------------------------------------------------------------------
  // The middleware should be invocable repeatedly with no shared state
  // between calls. Each invocation logs once, calls its own next() once,
  // and does not affect previous or subsequent invocations. This catches
  // regressions where a middleware accidentally caches state in a
  // module-level variable (e.g., a request counter that overflows or
  // a header buffer that gets reused across requests).
  describe('Idempotency and isolation', () => {
    it('should not retain state between invocations', () => {
      // Arrange + Act — two consecutive invocations with different
      // request shapes and independent next() spies.
      const req1 = mockRequest({ method: 'GET', path: '/path-a' });
      const res1 = mockResponse();
      const next1 = mockNext();
      requestLogger(req1, res1, next1);

      const req2 = mockRequest({ method: 'POST', path: '/path-b' });
      const res2 = mockResponse();
      const next2 = mockNext();
      requestLogger(req2, res2, next2);

      // Assert — each next() spy was called exactly once (independent
      // counts), and the cumulative logger.info call count is exactly
      // two (one per invocation, no extras).
      expect(next1).toHaveBeenCalledTimes(1);
      expect(next2).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledTimes(2);
    });

    it('should call next() each time for repeated invocations', () => {
      // Arrange — five sequential invocations stress-test the
      // middleware's stateless contract over a small loop. Increasing
      // the count to 100+ would still pass but provides no additional
      // signal beyond the first few iterations.
      const calls = 5;

      // Act + Assert (per-iteration)
      for (let i = 0; i < calls; i += 1) {
        const req = mockRequest({ method: 'GET', path: `/iter-${i}` });
        const res = mockResponse();
        const next = mockNext();
        requestLogger(req, res, next);
        // Each fresh `next` spy must be called exactly once — verifies
        // the middleware is not accidentally accumulating prior next()
        // references and calling them all.
        expect(next).toHaveBeenCalledTimes(1);
      }

      // Final assert — cumulative log count equals the loop iteration count.
      expect(logger.info).toHaveBeenCalledTimes(calls);
    });
  });
});
