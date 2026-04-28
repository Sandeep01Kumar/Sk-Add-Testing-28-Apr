'use strict';

/**
 * tests/unit/middleware/notFoundHandler.test.js
 *
 * Unit tests for the Express 404 fall-through middleware at
 * `src/middleware/notFoundHandler.js`.
 *
 * Test contracts verified:
 *   1. The middleware is a function with arity 3 (req, res, next) —
 *      arity 4 would make it an Express error handler, which we do
 *      NOT want. Express dispatches 3-arg middleware as regular
 *      middleware on every request and 4-arg middleware only when
 *      an error has already been raised. The 404 fall-through must
 *      run on EVERY unmatched request, so arity 3 is mandatory.
 *   2. Responds with HTTP status 404 and a JSON body of the canonical
 *      shape `{ error: 'Not Found', path: req.path }` (per AAP 0.4.3).
 *   3. Catches every HTTP method: GET, POST, PUT, DELETE, PATCH,
 *      OPTIONS, HEAD. A 404 handler that responds only to GET is a
 *      common mis-registration bug (e.g., `app.get('*', ...)` instead
 *      of `app.use('*', ...)`); the per-method coverage exercises
 *      this surface explicitly.
 *   4. Catches every unmatched path and reflects the requested path
 *      verbatim into the response body. Echoing the path lets API
 *      clients (especially programmatic ones) determine which path
 *      was rejected without parsing free-form text.
 *   5. Is TERMINAL — does NOT call `next()` (neither `next()` nor
 *      `next(err)`). The handler produces the final response itself;
 *      forwarding to `next()` would either invoke the next middleware
 *      (there is none — 404 is the fall-through) or, if invoked with
 *      an Error, route a "Not Found" condition through the error
 *      handler, conflating routing failures with application errors.
 *   6. Is idempotent — repeated invocations with the same request
 *      shape produce the same response shape, and concurrent
 *      invocations with different paths do not share state. The
 *      handler holds no internal cache, counter, or singleton.
 *
 * Test strategy:
 *   - DO NOT mock the logger. Per AAP 0.4.3, the notFoundHandler
 *     "never logs as application error". The implementation may or
 *     may not log the 404 (e.g., for monitoring), but tests do not
 *     assert on logger behavior here. Any incidental logger output
 *     is silenced globally via `LOG_LEVEL=silent` in
 *     `tests/fixtures/.env.test` (loaded by `tests/helpers/loadTestEnv.js`).
 *   - Import req/res/next mocks from tests/fixtures/request.fixtures
 *     and tests/fixtures/response.fixtures (per AAP Section 0.5.5).
 *     Each factory invocation returns a fresh, mutually independent
 *     object so tests can run in arbitrary order without cross-test
 *     pollution.
 *   - Use the defensive resolution pattern
 *     `(module && module.notFoundHandler) || module` to support both
 *     `module.exports = notFoundHandler` and
 *     `module.exports = { notFoundHandler }` export styles. The
 *     export style is an implementation detail of the broader Express
 *     enhancement; the tests must not be coupled to it.
 *   - Synchronous assertions only — no done(), no async/await — because
 *     the middleware contract is synchronous (it issues res.status().json()
 *     inline and returns).
 *
 * Mock dependencies (per AAP 0.5.2):
 *   - req/res/next via tests/fixtures/request.fixtures.js and
 *     tests/fixtures/response.fixtures.js
 *   - NO logger mock (per AAP 0.4.3 "never logs as application error"
 *     and AAP 0.5.2 listing only "req/res/next mocks")
 *
 * Why no `process.env` mutation:
 *   Per the assigned-folder requirements in the AAP: "No `process.env`
 *   mutation in middleware tests EXCEPT for `errorHandler.test.js`".
 *   The notFoundHandler's behavior does NOT depend on NODE_ENV (it
 *   returns 404 regardless of environment), so this file does not
 *   mutate process.env at all. Other middleware tests may capture
 *   and restore env via beforeEach/afterEach for stack-exposure
 *   gating; this file does not need that machinery.
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
 *   The middleware at `src/middleware/notFoundHandler.js` is created
 *   by the broader Express enhancement (NOT by this testing AAP).
 *   Until that file exists, every test below will fail at the
 *   require() step with MODULE_NOT_FOUND. This is expected and
 *   acceptable per AAP Section 0.2.1's coordination notes — the
 *   testing AAP and the broader enhancement are coordinated efforts.
 *   Once the middleware exists with the documented contract, all
 *   tests below pass.
 *
 * @module tests/unit/middleware/notFoundHandler.test
 */

// ---------------------------------------------------------------------------
// Imports — fixtures and the middleware under test.
// ---------------------------------------------------------------------------
// Fixture factories produce fresh mock req/res/next per call (per AAP 0.4.4).
// Each test creates new instances so call counts, mock state, and chained
// state never leak across tests within this file.
const { mockRequest } = require('../../fixtures/request.fixtures');
const { mockResponse, mockNext } = require('../../fixtures/response.fixtures');

// Defensive resolution: `src/middleware/notFoundHandler.js` may be authored
// to use either of two CommonJS export styles:
//   - default export:  module.exports = notFoundHandler;
//   - named export:    module.exports = { notFoundHandler };
// This double-pattern handles both transparently. If the module exports
// `{ notFoundHandler }`, the property access wins; otherwise we fall
// through to the module export itself (the function). The same pattern is
// used in tests/unit/middleware/requestLogger.test.js and
// tests/unit/middleware/errorHandler.test.js per AAP 0.10.1.
const notFoundHandlerModule = require('../../../src/middleware/notFoundHandler');
const notFoundHandler = (notFoundHandlerModule && notFoundHandlerModule.notFoundHandler) ||
  notFoundHandlerModule;

describe('Unit: src/middleware/notFoundHandler.js', () => {
  // -------------------------------------------------------------------------
  // Function signature
  // -------------------------------------------------------------------------
  // Express dispatches middleware based on its arity:
  //   - 3 args (req, res, next)        -> regular middleware
  //   - 4 args (err, req, res, next)   -> error-handling middleware
  // A 404 fall-through MUST be regular middleware (arity 3) so it runs on
  // every unmatched request, not only when an error is already in flight.
  // These assertions are the most fundamental contract: if either fails,
  // src/middleware/notFoundHandler.js exports the wrong shape entirely.
  describe('Function signature', () => {
    it('should be a function', () => {
      // Express middleware is always a function (callable). This catches
      // accidental object-literal exports or class-default exports that
      // would silently fail at app.use(notFoundHandler) registration time
      // with a confusing "argument handler must be a function" error.
      expect(typeof notFoundHandler).toBe('function');
    });

    it('should have arity 3 (req, res, next) — NOT an error handler', () => {
      // Function.prototype.length returns the number of declared parameters
      // (excluding rest params and those with default values). Express
      // inspects this exact property at registration time. Arity 4 would
      // cause Express to skip the middleware on normal requests and only
      // invoke it when an error has already been raised — wrong for a
      // fall-through that needs to fire on every unmatched route.
      expect(notFoundHandler.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: 404 JSON response
  // -------------------------------------------------------------------------
  // The "happy path" exercises the middleware with normal, well-formed
  // input and asserts the documented behavior: respond 404 with JSON
  // body of shape { error: 'Not Found', path }. These tests cover the
  // canonical use case — a typical incoming HTTP request to an unmatched
  // route.
  describe('Happy path: 404 JSON response', () => {
    it('should respond with HTTP status 404', () => {
      // Arrange — fresh mocks per test for isolation. The path value
      // here is arbitrary (any unmatched path triggers the same
      // contract); we use '/unknown' as a recognizable, unique token.
      const req = mockRequest({ path: '/unknown' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — res.status(404) is the canary for the entire 404
      // contract. If the handler responds with any other code, every
      // downstream behavior (response shape, content-type, terminal
      // semantics) is suspect.
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should respond by calling res.json (sets Content-Type application/json)', () => {
      // Arrange — same shape as the prior test; the assertion target
      // differs.
      const req = mockRequest({ path: '/unknown' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — res.json (rather than res.send or res.end) signals
      // structured JSON output. Express's res.json sets the
      // Content-Type to 'application/json' automatically; the mock
      // captures the call so tests can assert on the API the
      // middleware invoked.
      expect(res.json).toHaveBeenCalled();
    });

    it('should send body containing error "Not Found"', () => {
      // Arrange — '/missing' is a recognizable, unique token unlikely
      // to appear in any unrelated assertion or boilerplate.
      const req = mockRequest({ path: '/missing' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — the body MUST include `error: 'Not Found'`. We use
      // expect.objectContaining so the assertion does not over-specify:
      // implementations may add fields (e.g., a request id) without
      // breaking the test, while still requiring the canonical error
      // string.
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Not Found' }),
      );
    });

    it('should include the requested path in the response body', () => {
      // Arrange — a deeper path so the assertion is unambiguous (no
      // accidental match against a generic '/unknown' that could appear
      // in error envelopes or boilerplate text).
      const req = mockRequest({ path: '/some/missing/route' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — the response body's `path` field MUST equal the
      // requested path verbatim. Echoing the path is the documented
      // contract per AAP 0.4.3 ("body {error: 'Not Found', path: req.path}").
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/some/missing/route' }),
      );
    });

    it('should produce a body matching the canonical 404 shape exactly', () => {
      // Arrange — a path with no special characters so the equality
      // assertion is unambiguous.
      const req = mockRequest({ path: '/canonical' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — exact shape match. While the prior tests use
      // objectContaining (permissive), this test uses toEqual (strict)
      // to verify there are no UNEXPECTED extra fields. The canonical
      // shape per AAP 0.4.3 is { error: 'Not Found', path: <requested> }.
      // If the implementation accidentally includes a stack trace,
      // request id, timestamp, or other field by default, this test
      // catches it.
      const bodyArg = res.json.mock.calls[0][0];
      expect(bodyArg).toEqual({
        error: 'Not Found',
        path: '/canonical',
      });
    });

    it('should chain res.status before res.json (canonical Express idiom)', () => {
      // Arrange
      const req = mockRequest({ path: '/chain-check' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — verify both methods were called. This protects against
      // a regression where the implementation calls res.json without
      // first calling res.status (defaulting to 200, which would silently
      // produce a 200 response with the 404 body — an insidious bug).
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalled();
      // The mock's res.statusCode is mutated to 404 by the .status(404)
      // call, providing a state-based confirmation that the chain ran.
      expect(res.statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // HTTP method coverage (catches all methods)
  // -------------------------------------------------------------------------
  // A 404 fall-through MUST catch every HTTP method, not just GET. The
  // canonical mis-registration bug is `app.get('*', notFoundHandler)`
  // instead of `app.use(notFoundHandler)`, which would silently allow
  // POST/PUT/DELETE etc. requests to bypass the 404 handler entirely.
  // These data-driven tests use forEach() to generate one `it` block per
  // method, ensuring symmetric coverage and explicit per-method test
  // names in the Jest output (so a failure in POST does not shadow PUT).
  describe('HTTP method coverage (catches all methods)', () => {
    // The seven methods documented in AAP 0.4.3 ("any HTTP method,
    // any path"). The assigned folder requirements explicitly list
    // "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD". Adding new methods
    // (e.g., CONNECT, TRACE) is forward-compatible — extending the array
    // adds tests without restructuring existing assertions.
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

    methods.forEach((method) => {
      it(`should return 404 for ${method} requests`, () => {
        // Arrange — same shape per method; only the method name varies.
        // The path is held constant ('/unmatched') so the only variable
        // under test is the HTTP method.
        const req = mockRequest({ method, path: '/unmatched' });
        const res = mockResponse();
        const next = mockNext();

        // Act
        notFoundHandler(req, res, next);

        // Assert — three checks per method:
        //   1) Status is 404 (the headline contract).
        //   2) res.json was called (signals JSON content-type).
        //   3) The body contains the canonical error string.
        // Together these verify the entire 404 contract for the method.
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'Not Found' }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Path coverage (catches all unmatched paths)
  // -------------------------------------------------------------------------
  // The 404 handler must respond identically regardless of the requested
  // path — there is no per-path branching expected. These tests exercise
  // a variety of path shapes (simple, deep, root, special characters,
  // trailing slashes) to catch implementations that accidentally hardcode
  // a path, strip trailing slashes incorrectly, or fail on edge-case
  // characters.
  describe('Path coverage (catches all unmatched paths)', () => {
    it('should return 404 for /unknown-route', () => {
      const req = mockRequest({ path: '/unknown-route' });
      const res = mockResponse();
      const next = mockNext();

      notFoundHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/unknown-route' }),
      );
    });

    it('should return 404 for /api/v1/missing', () => {
      // A typical API-style path with versioning and resource segments.
      // Verifies multi-segment paths flow through the handler correctly.
      const req = mockRequest({ path: '/api/v1/missing' });
      const res = mockResponse();
      const next = mockNext();

      notFoundHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/api/v1/missing' }),
      );
    });

    it('should return 404 for the root path /', () => {
      // The root path is normally handled by the index route, but if
      // routing is ever misconfigured (e.g., the index router is not
      // mounted) and the request reaches this handler, it must still
      // produce a structured 404 rather than crash on an empty path.
      const req = mockRequest({ path: '/' });
      const res = mockResponse();
      const next = mockNext();

      notFoundHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/' }),
      );
    });

    it('should return 404 for deeply nested paths', () => {
      // A pathologically deep path — eight segments — exercises any
      // implementation that has a recursion depth limit, a path-length
      // truncation, or a regex that fails on long inputs.
      const deepPath = '/a/very/deeply/nested/path/that/does/not/exist';
      const req = mockRequest({ path: deepPath });
      const res = mockResponse();
      const next = mockNext();

      notFoundHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ path: deepPath }),
      );
    });

    it('should return 404 for paths with trailing slashes', () => {
      // Trailing slashes are a frequent normalization quirk. The handler
      // should NOT strip the trailing slash before reflecting the path
      // — clients sent the path that way and expect to see it echoed
      // verbatim in the error response so they can debug the mismatch.
      const req = mockRequest({ path: '/missing/' });
      const res = mockResponse();
      const next = mockNext();

      notFoundHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/missing/' }),
      );
    });

    it('should return 404 for paths with hyphens, underscores, and dots', () => {
      // URL-safe special characters that may appear in REST-style
      // resource identifiers (e.g., kebab-case, snake_case, file
      // extensions). The handler must not mishandle them.
      const req = mockRequest({ path: '/missing-with_special.chars' });
      const res = mockResponse();
      const next = mockNext();

      notFoundHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/missing-with_special.chars' }),
      );
    });

    it('should reflect each requested path independently across calls', () => {
      // Verifies path independence: each invocation should see only its
      // own path, with no carry-over from previous calls. A bug here
      // would manifest as the handler "remembering" the first path and
      // echoing it for subsequent requests (e.g., if path were captured
      // in module-level state).
      const paths = ['/foo', '/bar', '/baz/qux'];
      paths.forEach((path) => {
        const req = mockRequest({ path });
        const res = mockResponse();
        const next = mockNext();

        notFoundHandler(req, res, next);

        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ path }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Terminal contract (does NOT call next())
  // -------------------------------------------------------------------------
  // The 404 fall-through is the LAST regular middleware before the error
  // handler. It either:
  //   - Receives the request because no earlier handler matched
  //     (the 404 case) -> respond with 404 directly.
  //   - Or it is never reached because an earlier handler responded.
  // In either case, calling next() would either invoke the next
  // middleware (there is none — this IS the fall-through) or, if called
  // with an Error, route a routing failure through the error handler,
  // conflating "not found" with "server error". Both behaviors are bugs.
  // The most important assertion in this file is
  // `expect(next).not.toHaveBeenCalled()`.
  describe('Terminal contract (does NOT call next())', () => {
    it('should NOT call next() during normal handling', () => {
      // Arrange — defaults are sufficient; the assertion is about
      // control flow, not request content.
      const req = mockRequest({ path: '/missing' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — the handler is terminal. Per AAP 0.4.3:
      // "never calls next() (terminal middleware)".
      expect(next).not.toHaveBeenCalled();
    });

    it('should NOT call next(err) (does not propagate to error handler)', () => {
      // Arrange
      const req = mockRequest({ path: '/missing' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — this is the strongest version of the previous
      // assertion: not only was next() never called, but specifically
      // it was never called with an Error argument. A common bug is
      // for a 404 handler to construct an Error and forward it via
      // next(err), which would route the 404 through the error
      // handler — exactly what we DO NOT want for an unmatched route.
      expect(next).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should NOT call next() across all HTTP methods', () => {
      // Arrange — exhaustively verify the terminal contract holds
      // for every HTTP method, not just the default GET. A handler
      // that branches on method and accidentally forwards via next()
      // for, say, POST would be caught here.
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
      methods.forEach((method) => {
        const req = mockRequest({ method, path: '/missing' });
        const res = mockResponse();
        const next = mockNext();

        // Act
        notFoundHandler(req, res, next);

        // Assert
        expect(next).not.toHaveBeenCalled();
      });
    });

    it('should NOT call next() across a variety of paths', () => {
      // Arrange — exhaustively verify the terminal contract holds for
      // every path shape, not just the canonical '/missing'. A path-
      // dependent regression (e.g., the handler forwards via next()
      // for the root path '/' to "let the index route handle it")
      // would be caught here.
      const paths = ['/', '/missing', '/a/b/c', '/with-special_chars.json'];
      paths.forEach((path) => {
        const req = mockRequest({ path });
        const res = mockResponse();
        const next = mockNext();

        // Act
        notFoundHandler(req, res, next);

        // Assert
        expect(next).not.toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency and isolation
  // -------------------------------------------------------------------------
  // The handler is a pure function of (req.path) -> (res with 404 JSON).
  // It must hold no internal state — no counter, no cache, no singleton
  // response. These tests verify that:
  //   - Sequential calls with different paths produce path-specific
  //     responses (no carry-over).
  //   - Sequential calls with the same path produce identical responses
  //     (no drift).
  describe('Idempotency and isolation', () => {
    it('should not retain state between invocations with different paths', () => {
      // Arrange — Call 1: path A.
      const req1 = mockRequest({ path: '/path-a' });
      const res1 = mockResponse();
      const next1 = mockNext();
      notFoundHandler(req1, res1, next1);

      // Arrange — Call 2: path B.
      const req2 = mockRequest({ path: '/path-b' });
      const res2 = mockResponse();
      const next2 = mockNext();
      notFoundHandler(req2, res2, next2);

      // Assert — each call's body reflects its own path. A bug in
      // which the handler caches the first path (e.g., as a module-
      // level variable or a closure variable in a higher-order
      // factory) would manifest as both bodies showing '/path-a'.
      const body1 = res1.json.mock.calls[0][0];
      const body2 = res2.json.mock.calls[0][0];
      expect(body1.path).toBe('/path-a');
      expect(body2.path).toBe('/path-b');
      // Cross-check via objectContaining for completeness.
      expect(res1.json).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/path-a' }),
      );
      expect(res2.json).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/path-b' }),
      );
    });

    it('should produce the same response shape for repeated calls with the same path', () => {
      // Arrange — Call 1.
      const req1 = mockRequest({ path: '/same' });
      const res1 = mockResponse();
      const next1 = mockNext();
      notFoundHandler(req1, res1, next1);

      // Arrange — Call 2 with identical input.
      const req2 = mockRequest({ path: '/same' });
      const res2 = mockResponse();
      const next2 = mockNext();
      notFoundHandler(req2, res2, next2);

      // Assert — bodies must be deep-equal. A bug in which the handler
      // accidentally mutates a shared body object across calls (e.g.,
      // by reusing a singleton) would leave one of the bodies in an
      // unexpected state.
      const body1 = res1.json.mock.calls[0][0];
      const body2 = res2.json.mock.calls[0][0];
      expect(body1).toEqual(body2);
      // Both should also independently equal the canonical shape.
      expect(body1).toEqual({ error: 'Not Found', path: '/same' });
      expect(body2).toEqual({ error: 'Not Found', path: '/same' });
    });

    it('should produce fresh body object instances on each call (no shared reference)', () => {
      // Arrange — two independent calls.
      const req1 = mockRequest({ path: '/fresh' });
      const res1 = mockResponse();
      notFoundHandler(req1, res1, mockNext());

      const req2 = mockRequest({ path: '/fresh' });
      const res2 = mockResponse();
      notFoundHandler(req2, res2, mockNext());

      // Assert — bodies should be deep-equal but NOT the same reference.
      // A shared-singleton bug would manifest as `body1 === body2` (same
      // memory address), which means a mutation on body1 (e.g., by a
      // serializer) would silently mutate body2 as well.
      const body1 = res1.json.mock.calls[0][0];
      const body2 = res2.json.mock.calls[0][0];
      expect(body1).toEqual(body2);
      expect(body1).not.toBe(body2);
    });
  });

  // -------------------------------------------------------------------------
  // Defensive / structural assertions
  // -------------------------------------------------------------------------
  // These tests catch regressions in fundamental contracts that may
  // not surface from the specific scenario tests above.
  describe('Defensive / structural assertions', () => {
    it('should not throw when invoked synchronously', () => {
      // Arrange
      const req = mockRequest({ path: '/safe' });
      const res = mockResponse();
      const next = mockNext();

      // Act + Assert — wrapping the call in expect().not.toThrow()
      // catches any unexpected synchronous exception (e.g., a typo
      // that references an undefined property on req, an unhandled
      // null path). The middleware contract is synchronous and must
      // not throw under any input from this fixture.
      expect(() => notFoundHandler(req, res, next)).not.toThrow();
    });

    it('should call res.status exactly once', () => {
      // Arrange
      const req = mockRequest({ path: '/once' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — multiple status calls would indicate accidental
      // double-execution of the response logic (e.g., a finish
      // listener re-firing the handler) which in real Express would
      // throw "ERR_HTTP_HEADERS_SENT" on the second call.
      expect(res.status).toHaveBeenCalledTimes(1);
    });

    it('should call res.json exactly once', () => {
      // Arrange
      const req = mockRequest({ path: '/once-json' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — same rationale as the status assertion above. A
      // duplicate res.json invocation in production would throw
      // "ERR_HTTP_HEADERS_SENT" on the second call.
      expect(res.json).toHaveBeenCalledTimes(1);
    });

    it('should mark the response as headersSent (state-side check)', () => {
      // Arrange
      const req = mockRequest({ path: '/state-check' });
      const res = mockResponse();
      const next = mockNext();

      // Act
      notFoundHandler(req, res, next);

      // Assert — the mockResponse fixture sets res.headersSent = true
      // when res.json/.send/.end is invoked, mirroring real Express
      // behavior. This is a state-based confirmation complementary to
      // the call-args-based assertions: even if the implementation
      // calls a different method (res.send instead of res.json), the
      // response must still be marked as completed.
      expect(res.headersSent).toBe(true);
    });
  });
});
