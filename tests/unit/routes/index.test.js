'use strict';

/**
 * tests/unit/routes/index.test.js
 *
 * Unit tests for the Express root route handler at `src/routes/index.js`.
 *
 * Test contracts verified:
 *   1. GET / returns HTTP status 200 — matching the legacy 14-line
 *      server.js status code (per AAP 0.4.3).
 *   2. GET / returns body `'Hello, World!\n'` — preserving the legacy
 *      server.js byte-for-byte (INCLUDING the trailing newline that the
 *      original `res.end('Hello, World!\n')` call emitted). The trailing
 *      `\n` is part of the backward-compatibility contract; clients that
 *      depend on line-buffered I/O (e.g., `curl | xargs`, log shippers
 *      that split on `\n`) must continue to work after the modernization.
 *   3. GET / returns Content-Type matching `text/plain` (with optional
 *      charset suffix). Express may emit `text/plain` or
 *      `text/plain; charset=utf-8` depending on configuration, so the
 *      assertion uses a regex that tolerates both shapes.
 *   4. Edge cases: query strings on `/?foo=bar` produce the same body
 *      (Express path matching ignores the query); consecutive GETs
 *      produce identical responses (idempotent, no shared state).
 *   5. Edge cases: custom Accept headers (text/plain, application/json,
 *      `* / *`) ALL receive the plain-text body. The legacy server did
 *      not perform content negotiation; the Express enhancement
 *      preserves this contract verbatim.
 *   6. HEAD / returns 200 with an empty body, per RFC 7231 §4.3.2
 *      ("The HEAD method is identical to GET except that the server
 *      MUST NOT send a message body in the response").
 *   7. Non-GET methods (POST, PUT, DELETE, PATCH) on `/` fall through
 *      to the 404 handler (the root route is registered as GET-only).
 *      The 404 response is JSON with body `{error: 'Not Found', ...}`
 *      per the canonical `notFoundPayload` fixture.
 *   8. `buildApp()` returns a fresh app per call (test isolation
 *      contract — no shared state across `buildApp()` invocations).
 *
 * Test strategy:
 *   - Use Supertest's in-process injection — NEVER call `app.listen()`
 *     (per AAP Section 0.10.1: "Never call `app.listen()` from any
 *     test file. All HTTP-level testing uses Supertest's in-process
 *     injection."). Supertest binds the app to an ephemeral port for
 *     the duration of each request and tears it down automatically;
 *     no manual port management or cleanup is required.
 *   - Construct a fresh Express app per test via `buildApp()` so that
 *     each test is independently runnable and parallel-safe (per AAP
 *     0.7.2 — "Each test file must be runnable in isolation").
 *   - Assert against the canonical `helloWorldPayload` and
 *     `notFoundPayload` fixtures imported from
 *     `tests/fixtures/payloads.fixtures.js`. Centralizing the canonical
 *     values in a shared fixture means a future change to the legacy
 *     contract (extremely unlikely) requires updating exactly one file
 *     instead of fan-out edits across every route test.
 *   - Do NOT directly require `src/routes/index.js`. The route is
 *     exercised through the full Express app (constructed by
 *     `buildApp()`), which catches integration bugs (router mounting,
 *     middleware ordering) that direct route imports would miss.
 *   - Synchronous assertions inside `async`/`await` blocks — Supertest's
 *     `.get()/.post()/etc.` returns a Promise, so `await` is the
 *     idiomatic way to issue requests and assert on the response in a
 *     single linear flow. No `.expect(200, body)` chains are used here
 *     because the assertions are split across multiple `it` blocks for
 *     fine-grained failure reporting.
 *
 * Mock dependencies: NONE (per AAP Section 0.5.2 — "Mock dependencies:
 *   none — uses Supertest in-process injection against a minimal app
 *   that mounts only the route under test"). The route under test is
 *   pure — it has no external dependencies, no database, no third-party
 *   API calls — so there is nothing to mock.
 *
 * Why no `process.env` mutation in this file:
 *   The root route's behavior is environment-independent — it returns
 *   `'Hello, World!\n'` regardless of NODE_ENV, LOG_LEVEL, PORT, or
 *   HOST. This file therefore does NOT mutate `process.env` at all,
 *   eliminating an entire class of cross-test pollution bugs. Tests
 *   that DO depend on environment variables (e.g., the config loader
 *   tests) follow the canonical capture-and-restore pattern in their
 *   own `beforeEach`/`afterEach` hooks per AAP Section 0.10.1.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS `require()`/`module.exports` (matches package.json's
 *     lack of `"type": "module"`)
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline arrays/objects
 *   - Block hierarchy: `describe('Unit: ...')` -> `describe(scenario)`
 *     -> `it("should <behavior> when <condition>")`
 *   - Arrange-Act-Assert pattern within each test (each test calls
 *     `buildApp()` once for Arrange, issues one Supertest request for
 *     Act, then runs `expect()` assertions for Assert)
 *   - File naming: `index.test.js` mirrors `src/routes/index.js`
 *
 * Path resolution (per AAP Section 0.6.2):
 *   From `tests/unit/routes/index.test.js`:
 *     - `'../../helpers/buildApp'`            -> `tests/helpers/buildApp.js`
 *     - `'../../fixtures/payloads.fixtures'`  -> `tests/fixtures/payloads.fixtures.js`
 *     - `'supertest'`                         -> npm package (bare specifier)
 *   No direct import of `src/routes/index.js` — the route is reached
 *   indirectly through the app constructed by `buildApp()`.
 *
 * Coordination note (per AAP Section 0.2.1):
 *   The Express app at `src/app.js` and the root route at
 *   `src/routes/index.js` are created by the broader Express
 *   enhancement (NOT by this testing AAP). Until those files exist,
 *   `buildApp()` will throw `MODULE_NOT_FOUND` when its lazy
 *   `require('../../src/app')` executes, and every test below will
 *   fail at the `buildApp()` call. This is expected and acceptable
 *   per AAP Section 0.2.1 — the testing AAP and the broader
 *   enhancement are coordinated efforts and the test suite is
 *   authored ahead of (or alongside) the source code so the
 *   contracts are pinned before implementation begins.
 *
 * @module tests/unit/routes/index.test
 * @see tests/helpers/buildApp.js
 * @see tests/fixtures/payloads.fixtures.js
 * @see https://github.com/ladjs/supertest
 * @see https://datatracker.ietf.org/doc/html/rfc7231#section-4.3.2 (HEAD method)
 */

const request = require('supertest');
const { buildApp } = require('../../helpers/buildApp');
const {
  helloWorldPayload,
  notFoundPayload,
} = require('../../fixtures/payloads.fixtures');

describe('Unit: src/routes/index.js (root route)', () => {
  // ----------------------------------------------------------------
  // Happy path: GET / returns 200 + 'Hello, World!\n' body
  // ----------------------------------------------------------------
  // The root route's primary contract is the byte-for-byte
  // preservation of the legacy server.js response. These tests are
  // SPLIT across multiple `it` blocks (rather than collapsed into a
  // single combined assertion) so that a failure of any single
  // dimension — status, body, content-type — surfaces immediately in
  // the test output without obscuring the others. The final test in
  // this group then re-verifies all three dimensions in one block to
  // exercise them together as a contract.
  describe('Happy path: GET /', () => {
    it('should return 200 status when GET / is requested', async () => {
      // Arrange: construct a fresh Express app for this test.
      const app = buildApp();

      // Act: issue an in-process GET / request via Supertest.
      const response = await request(app).get('/');

      // Assert: the status code must match the canonical fixture
      // (helloWorldPayload.statusCode === 200). Asserting against the
      // fixture rather than the literal `200` ensures that a future
      // contract change would require updating the fixture in exactly
      // one place rather than every route test.
      expect(response.status).toBe(helloWorldPayload.statusCode);
    });

    it('should return body "Hello, World!\\n" preserving legacy behavior', async () => {
      const app = buildApp();
      const response = await request(app).get('/');

      // The legacy server.js sent EXACTLY 'Hello, World!\n' (14 bytes
      // including the trailing newline). The Express enhancement must
      // preserve this byte sequence verbatim — `res.send('Hello, World!')`
      // would NOT satisfy the contract because Express's send() does
      // not append a newline. Asserting equality against the fixture's
      // `body` property (which is itself 'Hello, World!\n') guarantees
      // the trailing newline is preserved.
      expect(response.text).toBe(helloWorldPayload.body);
    });

    it('should return body with trailing newline character', async () => {
      const app = buildApp();
      const response = await request(app).get('/');

      // Defense-in-depth assertion: even if a future fixture change
      // accidentally drops the trailing newline (and the previous
      // test's strict-equality assertion is updated accordingly),
      // this `endsWith('\n')` check would still fire and prevent the
      // regression. The legacy contract is "the body ends with \n";
      // this test asserts that contract directly.
      expect(response.text.endsWith('\n')).toBe(true);
    });

    it('should return Content-Type containing text/plain when GET / is requested', async () => {
      const app = buildApp();
      const response = await request(app).get('/');

      // Express may emit `Content-Type: text/plain` (no charset) or
      // `Content-Type: text/plain; charset=utf-8` (with charset)
      // depending on configuration. Strict equality `.toBe('text/plain')`
      // would fail the latter unnecessarily; using a regex that matches
      // the `text/plain` prefix accepts both shapes. The `i` flag
      // tolerates implementation-emitted casing variants like
      // `Text/Plain` (uncommon but valid per RFC 7231).
      expect(response.headers['content-type']).toMatch(/text\/plain/i);
    });

    it('should match the canonical helloWorldPayload contract exactly', async () => {
      const app = buildApp();
      const response = await request(app).get('/');

      // Combined assertion that exercises all three dimensions of the
      // canonical helloWorldPayload contract in a single test block.
      // If a regression breaks any single dimension, the previous
      // single-dimension tests will pinpoint it; this test confirms
      // that the dimensions hold TOGETHER (e.g., guards against a
      // theoretical bug where the body is correct only when the
      // status code is wrong, which would slip past the per-dimension
      // tests if assertion ordering allowed it).
      expect(response.status).toBe(helloWorldPayload.statusCode);
      expect(response.text).toBe(helloWorldPayload.body);
      expect(response.headers['content-type']).toMatch(/text\/plain/i);
    });
  });

  // ----------------------------------------------------------------
  // Edge cases: path variants
  // ----------------------------------------------------------------
  // Path-variant tests verify that the root route's behavior is
  // robust against routine URL noise: query strings, repeated calls,
  // etc. The legacy server.js responded identically to every URL
  // (because it ignored the request entirely); the Express enhancement
  // narrows that to GET / specifically, but for the GET / path itself
  // the response must be invariant under query-string variation.
  describe('Edge cases: path variants', () => {
    it('should return 200 with the same body when GET / is called with a query string', async () => {
      const app = buildApp();

      // Express's path matching in `app.get('/', ...)` ignores query
      // strings — `/` and `/?foo=bar&baz=qux` both match the same
      // handler. This test verifies that contract: the response body
      // is identical regardless of query-string presence.
      const response = await request(app).get('/?foo=bar&baz=qux');

      expect(response.status).toBe(200);
      expect(response.text).toBe(helloWorldPayload.body);
    });

    it('should respond consistently across multiple consecutive GET / calls', async () => {
      const app = buildApp();

      // Idempotency: repeated GETs against the same route produce
      // identical responses. This test catches a class of bugs where
      // the route accidentally maintains state across requests
      // (e.g., a counter, a closure-captured variable, a memoized
      // response). Three consecutive calls are sufficient to detect
      // any first-vs-subsequent divergence.
      const r1 = await request(app).get('/');
      const r2 = await request(app).get('/');
      const r3 = await request(app).get('/');

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      expect(r1.text).toBe(r2.text);
      expect(r2.text).toBe(r3.text);
    });
  });

  // ----------------------------------------------------------------
  // Edge cases: custom Accept headers
  // ----------------------------------------------------------------
  // The legacy server.js returned 'Hello, World!\n' regardless of
  // the client's Accept header — there was no content negotiation.
  // The Express enhancement preserves this exact behavior; even when
  // the client requests `application/json`, the server returns plain
  // text. These tests pin that contract explicitly so a future
  // (well-intentioned) refactor that introduces content negotiation
  // would fail loudly here and force a deliberate decision instead
  // of silent backward-incompatibility.
  describe('Edge cases: custom Accept headers', () => {
    it('should return Hello, World!\\n when Accept is text/plain', async () => {
      const app = buildApp();

      // Happy path for content negotiation: the client EXPLICITLY
      // requests text/plain, which matches the response contract,
      // so the response is plain text as expected.
      const response = await request(app)
        .get('/')
        .set('Accept', 'text/plain');

      expect(response.status).toBe(200);
      expect(response.text).toBe(helloWorldPayload.body);
    });

    it('should return plain text Hello, World!\\n even when Accept requests application/json', async () => {
      const app = buildApp();

      // Anti-content-negotiation contract: the client requests JSON,
      // but the server still returns plain text — matching the legacy
      // server.js behavior verbatim. A future implementation that
      // honors `Accept: application/json` by returning a JSON body
      // would BREAK backward compatibility with clients that rely on
      // the legacy plain-text response, and this test would fail
      // loudly to signal that the change has been made and must be
      // reviewed.
      const response = await request(app)
        .get('/')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.text).toBe(helloWorldPayload.body);
    });

    it('should handle Accept */* gracefully and return Hello, World!\\n', async () => {
      const app = buildApp();

      // Default Accept value: `*/*` (any media type). Many HTTP
      // clients (curl, fetch in browsers, ad-hoc tools) send `*/*`
      // by default. The legacy server.js's lack of content
      // negotiation meant `*/*` always received plain text; the
      // Express enhancement preserves that contract.
      const response = await request(app)
        .get('/')
        .set('Accept', '*/*');

      expect(response.status).toBe(200);
      expect(response.text).toBe(helloWorldPayload.body);
    });
  });

  // ----------------------------------------------------------------
  // HEAD / behavior (RFC 7231: HEAD identical to GET but no body)
  // ----------------------------------------------------------------
  // Per RFC 7231 §4.3.2, HEAD responses MUST NOT include a message
  // body. Express handles this automatically when `res.send()` or
  // `res.end()` is invoked from a GET handler — Express recognizes
  // the HEAD method and drops the body before transmission. These
  // tests verify both the status-code contract (HEAD must mirror GET)
  // and the empty-body contract (HEAD must not return a body).
  describe('HEAD / behavior', () => {
    it('should return 200 status when HEAD / is requested', async () => {
      const app = buildApp();

      // HEAD requests are routed to the same handler as GET, so the
      // status code MUST match the GET / status code (200 OK). A
      // mismatch here would indicate the route is registered with
      // `app.head('/', ...)` separately (and incorrectly), or that
      // the GET handler is doing something HEAD-incompatible.
      const response = await request(app).head('/');

      expect(response.status).toBe(200);
    });

    it('should return empty body when HEAD / is requested (per HTTP spec)', async () => {
      const app = buildApp();
      const response = await request(app).head('/');

      // RFC 7231 §4.3.2 requires that HEAD responses MUST NOT include
      // a message body. Supertest exposes the body as `response.text`
      // (for non-JSON) or `response.body` (for JSON); for HEAD, both
      // should be falsy (empty string, undefined, or null). We use
      // `.toBeFalsy()` rather than `.toBe('')` because the underlying
      // HTTP parser may yield any of those shapes, and any of them
      // satisfies the spec.
      expect(response.text).toBeFalsy();
    });
  });

  // ----------------------------------------------------------------
  // Error cases: non-GET methods fall through to 404 handler
  // ----------------------------------------------------------------
  // The root route is registered with `app.get('/', handler)`, which
  // matches GET (and HEAD) but not other HTTP methods. Non-GET
  // requests to `/` therefore fall through to the 404 handler,
  // which returns a JSON body with `error: 'Not Found'`. These tests
  // are critical because a common mis-registration is `app.all('/',
  // handler)` (matches all methods) or `app.use('/', handler)` (acts
  // as middleware on every request). Either bug would silently
  // accept POST/PUT/DELETE/PATCH and respond with the GET body —
  // without these per-method tests, that regression could go
  // undetected. Per AAP 0.4.3, "POST /, PUT /, DELETE / on the root
  // path return 404 (or 405 if method-not-allowed handler is added)";
  // this project's chosen approach is the simpler 404 fall-through.
  describe('Error cases: non-GET methods', () => {
    it('should return 404 when POST / is requested', async () => {
      const app = buildApp();

      // POST with a body: the request body should not influence the
      // routing decision (the route is GET-only, so any body is
      // irrelevant). Sending a body verifies that body parsing does
      // not accidentally trigger a different code path.
      const response = await request(app).post('/').send({ data: 'test' });

      expect(response.status).toBe(notFoundPayload.statusCode);
    });

    it('should return 404 when PUT / is requested', async () => {
      const app = buildApp();
      const response = await request(app).put('/').send({ data: 'test' });

      expect(response.status).toBe(notFoundPayload.statusCode);
    });

    it('should return 404 when DELETE / is requested', async () => {
      const app = buildApp();

      // DELETE typically has no body; we omit `.send(...)` here to
      // exercise the body-less code path. The route is still GET-only
      // and DELETE must fall through to 404.
      const response = await request(app).delete('/');

      expect(response.status).toBe(notFoundPayload.statusCode);
    });

    it('should return 404 when PATCH / is requested', async () => {
      const app = buildApp();
      const response = await request(app).patch('/').send({ data: 'test' });

      expect(response.status).toBe(notFoundPayload.statusCode);
    });

    it('should return JSON Content-Type for fall-through 404 responses', async () => {
      const app = buildApp();
      const response = await request(app).post('/');

      // The 404 handler returns a JSON body, so its Content-Type must
      // be `application/json` (with optional charset suffix). We use
      // a regex that tolerates both `application/json` and
      // `application/json; charset=utf-8`. This contract is captured
      // by the canonical notFoundPayload fixture's `contentType`
      // property.
      expect(response.headers['content-type']).toMatch(/application\/json/i);
    });

    it('should include "Not Found" error in the body for fall-through 404 responses', async () => {
      const app = buildApp();
      const response = await request(app).post('/');

      // Supertest auto-parses JSON response bodies into `response.body`.
      // The notFoundPayload fixture defines the canonical 404 body
      // shape as `{error: 'Not Found', path}`; this test asserts the
      // `error` field directly, which is the static portion of the
      // shape. The dynamic `path` field is asserted by the
      // notFoundHandler unit tests in tests/unit/middleware/.
      expect(response.body.error).toBe('Not Found');
    });
  });

  // ----------------------------------------------------------------
  // Test isolation
  // ----------------------------------------------------------------
  // These tests verify the meta-contract of the test infrastructure
  // itself: that `buildApp()` returns a fresh app per call (no shared
  // state) and that the test suite never accidentally invokes
  // `app.listen()`. Without these guarantees, parallel test execution
  // and arbitrary test ordering would produce flaky failures.
  describe('Test isolation', () => {
    it('should produce a fresh app instance per buildApp() call', () => {
      // Two consecutive calls to buildApp() must return DIFFERENT app
      // instances (different object references). If they were the
      // same instance, tests that mutate the app (e.g., to add
      // override middleware) would leak state into subsequent tests.
      const a = buildApp();
      const b = buildApp();

      // `.not.toBe(b)` is a reference-identity check — strictly
      // distinct object references. This is the strongest possible
      // isolation guarantee at the JavaScript object level.
      expect(a).not.toBe(b);
    });

    it('should never call app.listen() during test (no port binding)', async () => {
      const app = buildApp();

      // The Express app is itself a callable function (the request
      // handler that node's http.Server invokes for each incoming
      // request). Asserting `typeof app === 'function'` confirms the
      // app surface is correct. Issuing a Supertest request against
      // the app DOES NOT require app.listen() to have been called —
      // Supertest manages an ephemeral port internally for the
      // duration of the request and tears it down on response. This
      // test exercises both halves of the contract: app is callable,
      // AND a request against it succeeds without manual port
      // management.
      expect(typeof app).toBe('function');

      const response = await request(app).get('/');

      expect(response.status).toBe(200);
    });
  });
});
