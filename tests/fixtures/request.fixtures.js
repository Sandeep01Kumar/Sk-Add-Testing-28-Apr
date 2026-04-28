'use strict';

/**
 * tests/fixtures/request.fixtures.js
 *
 * Express Request mock factory for middleware unit tests.
 *
 * Provides a `mockRequest()` factory function that returns shaped
 * Partial<express.Request> objects with sensible defaults and per-call
 * customization. Each invocation returns a brand-new object, so tests
 * can be parallelized and run in arbitrary order without cross-test
 * pollution. This matches the per-call freshness contract documented
 * in AAP Section 0.4.4 ("named factory functions rather than singleton
 * objects, enabling per-test customization without cross-test
 * pollution").
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
 *     a fresh object so test mutations never leak across calls
 *   - Framework-agnostic public API; uses `jest.fn()` internally because
 *     this fixture is only ever consumed inside Jest test files where
 *     the `jest` global is automatically injected by the test runner
 *
 * Companion fixture: tests/fixtures/response.fixtures.js exports
 * `mockResponse()` and `mockNext()`. Together these three factories
 * form the complete `(req, res, next)` mock triple required by every
 * Express middleware unit test.
 *
 * Usage (canonical pattern from AAP Section 0.5.5 and 0.6.2):
 *
 *   const { mockRequest } = require('../../fixtures/request.fixtures');
 *
 *   // From tests/integration/: require('../fixtures/request.fixtures')
 *
 *   describe('requestLogger', () => {
 *     it('should log method/path with case-insensitive header lookup', () => {
 *       const req = mockRequest({
 *         method: 'POST',
 *         path: '/health',
 *         headers: { 'X-Request-Id': 'abc-123' },
 *       });
 *
 *       expect(req.method).toBe('POST');
 *       expect(req.path).toBe('/health');
 *       expect(req.get('x-request-id')).toBe('abc-123');
 *       expect(req.get('X-REQUEST-ID')).toBe('abc-123');
 *     });
 *   });
 *
 * @module tests/fixtures/request.fixtures
 */

/**
 * Build a shaped Partial<express.Request> for use in middleware unit tests.
 *
 * The returned object exposes the subset of express.Request properties
 * that production middleware typically reads (method, path, url,
 * originalUrl, baseUrl, params, query, body, headers, ip, ips, protocol,
 * secure, hostname, xhr) plus two callable accessors (`get`, `header`)
 * backed by `jest.fn()` so tests can assert call counts and arguments
 * via `.toHaveBeenCalledWith(...)` matchers.
 *
 * Implementation notes:
 *   - All mutable input objects (`headers`, `body`, `query`) are
 *     SHALLOW-COPIED via the spread operator so test authors can mutate
 *     `req.headers` after construction without affecting the original
 *     `options.headers` object passed by the caller. This is critical
 *     for fixture isolation per AAP 0.4.4.
 *   - Header lookups via `req.get()`/`req.header()` are CASE-INSENSITIVE
 *     to match Express's runtime behavior. The fixture builds a
 *     lowercased lookup table (`lowerCasedHeaders`) at construction
 *     time; subsequent `req.get('Content-Type')`,
 *     `req.get('content-type')`, and `req.get('CONTENT-TYPE')` calls
 *     all return the same value.
 *   - `req.headers` PRESERVES the original casing supplied by the test
 *     (matching Express, which stores headers verbatim and only
 *     normalizes lookups). This lets tests inspect both representations.
 *   - `get` and `header` are SEPARATE `jest.fn()` instances even though
 *     they implement identical behavior. This mirrors Express's runtime
 *     binding model and lets tests assert against the specific method
 *     the middleware actually invoked. Calling `req.get('X')` does NOT
 *     register a call on `req.header`.
 *   - Non-string header lookups return `undefined` (matches Express,
 *     which validates the argument type and skips the table lookup
 *     when it is not a string). The defensive type check prevents
 *     `TypeError` when middleware accidentally passes `null`/`undefined`.
 *
 * Forward compatibility (per AAP 0.10.1): additional optional fields
 * may be added to the `options` parameter without breaking existing
 * callers because:
 *   - Defaults are provided for every field (callers can omit any
 *     subset of options or omit the argument entirely)
 *   - New fields are read by explicit property access (`opts.newField`)
 *     rather than positional argument enumeration
 *
 * @param {Object} [options] Per-call request overrides. Pass an empty
 *   object or omit entirely to receive a fully-defaulted request mock.
 * @param {string} [options.method='GET'] HTTP method. Normalized to
 *   uppercase (Express convention) regardless of input casing.
 * @param {string} [options.path='/'] Request path (no query string).
 *   Aliased to `req.url` and `req.originalUrl` for middleware that
 *   reads either.
 * @param {Object} [options.headers={}] Request headers. Any casing is
 *   preserved on `req.headers`; `req.get()`/`req.header()` perform
 *   case-insensitive lookups.
 * @param {Object} [options.body={}] Parsed request body (e.g., from
 *   `express.json()` middleware).
 * @param {Object} [options.query={}] Parsed query string (e.g., from
 *   Express's built-in query parser).
 * @param {string} [options.ip='127.0.0.1'] Client IP address.
 * @returns {Object} A fresh Partial<express.Request> with `.get` and
 *   `.header` backed by `jest.fn()` for spying. Every call returns a
 *   distinct object reference (no shared state).
 */
function mockRequest(options) {
  // Defensive defaulting — handle `null` and `undefined` options without
  // tripping a TypeError on subsequent property access. The `options || {}`
  // pattern coerces any falsy value (undefined, null, false, 0, '') to an
  // empty object before destructuring, which is safer than relying on
  // ES6 default parameters when callers may pass `null` explicitly.
  const opts = options || {};

  // Normalize method to uppercase so middleware comparing against 'GET',
  // 'POST', etc. works regardless of how the test author wrote the input.
  // Real Express performs the same uppercase normalization at the http.IncomingMessage layer.
  const method = (opts.method || 'GET').toUpperCase();

  const path = opts.path || '/';

  // Spread-copy mutable input objects so post-construction mutation of
  // `req.headers` (e.g., a middleware that adds `req.headers['x-request-id']`)
  // does not leak back into the caller's `options.headers` object. Without
  // these copies, a single test mutating `req.headers` would silently
  // pollute the next test that spreads the same fixture template.
  const headers = opts.headers ? { ...opts.headers } : {};
  const body = opts.body ? { ...opts.body } : {};
  const query = opts.query ? { ...opts.query } : {};

  const ip = opts.ip || '127.0.0.1';

  // Build a lowercased lookup table for case-insensitive header access via
  // req.get()/req.header(). Express's runtime stores headers verbatim in
  // req.headers (preserving original casing) but lowercases the lookup key
  // when req.get() is called. This fixture mirrors that exact behavior so
  // middleware tests observe the same semantics as production.
  //
  // Note: Object.keys + forEach is preferred over Object.entries here
  // because it avoids creating an intermediate array of [key, value] pairs
  // for every fixture call — a small but meaningful optimization given
  // this factory may be invoked hundreds of times in a single test run.
  const lowerCasedHeaders = {};
  Object.keys(headers).forEach((key) => {
    lowerCasedHeaders[key.toLowerCase()] = headers[key];
  });

  // -------------------------------------------------------------------------
  // Construct the mock request object
  // -------------------------------------------------------------------------
  // Each property mirrors a documented express.Request field. Properties
  // not listed here (e.g., cookies, signedCookies, route, app, res) are
  // intentionally omitted — middleware unit tests never read them, and
  // including them would inflate the fixture surface without value.
  // Tests that need additional properties may attach them ad-hoc via
  // Object.assign(req, { ... }) after construction.
  const req = {
    // HTTP method — uppercased per Express convention.
    method,

    // Request path (no query string). Express sets this from the URL
    // parsed by the router; the fixture supplies it directly.
    path,

    // url and originalUrl are aliased to path. In real Express they may
    // diverge after router rewriting (originalUrl preserves the inbound
    // value while url tracks the current router-relative path), but unit
    // tests of leaf middleware never observe that divergence — the
    // middleware reads whichever property it needs and gets the same
    // value either way.
    url: path,
    originalUrl: path,

    // baseUrl is the mount path of the surrounding router. Unit tests
    // of individual middleware run against the bare path with no router
    // mounted, so this is always an empty string.
    baseUrl: '',

    // params is populated by the router from path-param patterns
    // (e.g., '/users/:id' → { id: '...' }). Unit tests of middleware
    // that don't depend on path params receive an empty object; tests
    // that DO depend on params override this field via the options.
    // (Forward compatibility: callers can mutate req.params after
    // construction without affecting other fixtures, since `{}` is a
    // fresh object per call.)
    params: {},

    // Spread-copied query/body/headers (see above for rationale).
    query,
    body,
    headers,

    // Client IP — set from req.connection.remoteAddress in real Express.
    // The fixture defaults to the loopback address; tests asserting
    // proxy-aware behavior can override via options.ip.
    ip,

    // ips is populated when 'trust proxy' is enabled and X-Forwarded-For
    // is present. Defaults to empty array; tests asserting proxy-chain
    // behavior can attach values directly.
    ips: [],

    // protocol/secure reflect the connection scheme. Default to plain
    // HTTP since unit tests do not exercise TLS-conditional branches.
    protocol: 'http',
    secure: false,

    // hostname is derived from the Host header if present, otherwise
    // falls back to 'localhost'. Real Express trims the port off this
    // value; the fixture mirrors that simplicity by reading whatever
    // the test supplied for the Host header without further parsing.
    hostname: lowerCasedHeaders.host || 'localhost',

    // xhr is true when X-Requested-With === 'XMLHttpRequest'. Defaults
    // to false; tests asserting xhr-conditional branches can override
    // by setting the header AND attaching the boolean directly.
    xhr: false,

    // -------------------------------------------------------------------
    // Header accessors (jest.fn() instances for spying)
    // -------------------------------------------------------------------

    // req.get(name) — Express's idiomatic header accessor. Performs
    // case-insensitive lookup against the lowerCasedHeaders table built
    // above. Returns undefined for unset headers and for non-string
    // arguments (matches Express's runtime behavior, which validates
    // the argument type before lookup).
    //
    // Backed by jest.fn() so tests can assert:
    //   expect(req.get).toHaveBeenCalledWith('X-Request-Id');
    //   expect(req.get).toHaveBeenCalledTimes(1);
    get: jest.fn((headerName) => {
      if (typeof headerName !== 'string') {
        return undefined;
      }
      return lowerCasedHeaders[headerName.toLowerCase()];
    }),

    // req.header(name) — Express provides this as a synonym for req.get().
    // Behavior is identical, but the underlying jest.fn() instance is
    // SEPARATE from req.get so tests can assert against the specific
    // method the middleware actually invoked. Calling req.get('X') does
    // NOT register a call on req.header (matches Express's runtime
    // binding semantics where the two are independent function refs).
    header: jest.fn((headerName) => {
      if (typeof headerName !== 'string') {
        return undefined;
      }
      return lowerCasedHeaders[headerName.toLowerCase()];
    }),
  };

  return req;
}

module.exports = {
  mockRequest,
};
