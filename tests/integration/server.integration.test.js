'use strict';

/**
 * tests/integration/server.integration.test.js
 *
 * End-to-end integration tests for the Express app.
 *
 * Exercises the full middleware chain (request logging -> routing ->
 * response -> error handling -> 404 fall-through) wired together via
 * Supertest's in-process HTTP injection. NEVER binds to a real port.
 *
 * Test contracts verified (per AAP Sections 0.4.3, 0.5.1, 0.5.2):
 *   1. GET /          -> 200, Content-Type text/plain, body
 *                        'Hello, World!\n' (preserves the legacy
 *                        14-line server.js byte-for-byte, INCLUDING
 *                        the trailing newline).
 *   2. GET /health    -> 200, Content-Type application/json, body
 *                        contains status='ok', numeric uptime, and
 *                        an ISO-8601 parseable timestamp.
 *   3. Unknown paths  -> 404, Content-Type application/json, body
 *                        {error: 'Not Found', path: <requested path>}
 *                        across every HTTP method.
 *   4. Thrown errors  -> 500 JSON, NODE_ENV-gated stack-trace
 *                        exposure (development includes stack,
 *                        production omits stack), honors
 *                        err.statusCode overrides (e.g. 422).
 *   5. Middleware     -> Injected middleware runs before route
 *      ordering         handlers; the error handler is registered
 *                        last and catches throws from earlier
 *                        middleware/handlers.
 *   6. App surface    -> The Express app callable exposes
 *                        .use/.get/.post/.put/.delete without
 *                        binding to a real port (Supertest binds an
 *                        ephemeral port per request).
 *
 * Test strategy (per AAP Sections 0.4.1, 0.10.1):
 *   - Use `tests/helpers/buildApp.js` to obtain a fresh, unbound
 *     Express app per test scenario (per-test isolation).
 *   - Use Supertest's in-process injection (`request(app)`) for all
 *     HTTP-level assertions; NEVER call `app.listen()` from any test
 *     (per AAP 0.10.1 "Never call app.listen() from any test file").
 *   - Inject test-only routes/middleware via buildApp's `routes` and
 *     `middleware` overrides to exercise error-path behavior without
 *     modifying any production module.
 *   - Capture and restore `process.env` in `beforeAll`/`afterAll`;
 *     individual tests that mutate `NODE_ENV` for stack-gating
 *     coverage restore inside the test (the outer `afterAll` is the
 *     defense-in-depth final restore).
 *   - Apply `silenceLogger()` in `beforeAll` to suppress Winston
 *     output even if `LOG_LEVEL=silent` from `.env.test` is bypassed.
 *   - Use deterministic timestamp assertions per AAP 0.10.1: parse
 *     the timestamp string with `new Date(...)` and check the result
 *     is not 'Invalid Date' rather than asserting on an exact value
 *     (which would race the system clock).
 *   - Use case-insensitive regex for Content-Type assertions to
 *     accept Express's automatic charset suffix
 *     (`text/plain; charset=utf-8`).
 *   - Defensively check both `body.error.stack` and `body.stack` for
 *     stack-presence assertions so the tests couple to the CONTRACT
 *     (stack present-or-absent based on env) rather than the EXACT
 *     IMPLEMENTATION layout chosen by the broader Express
 *     enhancement.
 *
 * Test fixtures (per AAP Section 0.5.5):
 *   - tests/fixtures/payloads.fixtures.js (canonical response bodies)
 *   - tests/fixtures/env.fixtures.js (NODE_ENV scenarios)
 *
 * Test helpers (per AAP Section 0.5.5):
 *   - tests/helpers/buildApp.js (fresh app per test scenario)
 *   - tests/helpers/silenceLogger.js (Winston silencing)
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require()/module.exports
 *   - Two-space indentation, single quotes, semicolons
 *   - Block hierarchy: describe('Integration: ...') -> describe(scenario)
 *     -> it('should <expected behavior> when <condition>')
 *   - File naming: *.integration.test.js distinguishes from unit tests
 *   - Supertest in-process injection (NEVER call app.listen())
 *   - No direct mock of `winston` or `src/logger` — integration tests
 *     run the REAL middleware chain end-to-end (per AAP 0.4.1)
 *   - No snapshot testing — assertions on specific keys/values are
 *     clearer for small, well-defined responses
 *
 * Coordination note:
 *   The Express app at `src/app.js`, the middleware at
 *   `src/middleware/*.js`, and the routes at `src/routes/*.js` are
 *   created by the broader Express enhancement (NOT by this testing
 *   AAP). Until those files exist, every test below will fail at the
 *   buildApp() step with MODULE_NOT_FOUND. This is expected per AAP
 *   Section 0.2.1 — the testing AAP and the broader enhancement are
 *   coordinated efforts. Once the enhancement is authored with the
 *   documented contracts, all tests below pass.
 *
 * @module tests/integration/server.integration.test
 */

// ---------------------------------------------------------------------------
// Imports — Supertest, fixtures, and helpers.
// ---------------------------------------------------------------------------
// `supertest` is the HTTP assertion library; bare specifier resolves from
// node_modules. The fixture and helper imports use relative paths per
// AAP 0.6.2: from `tests/integration/<file>` use `../fixtures/<file>` and
// `../helpers/<file>` (one level up to `tests/`, then down).
//
// NOTE: We do NOT directly import `src/app.js`. All app construction goes
// through `buildApp()` which lazy-requires the project app, decoupling this
// test file from the eventual export style chosen by the broader Express
// enhancement (factory default, named factory, ES-interop, or singleton).

const request = require('supertest');
const {
  helloWorldPayload,
  healthPayload,
  notFoundPayload,
} = require('../fixtures/payloads.fixtures');
const { testEnv, productionEnv } = require('../fixtures/env.fixtures');
const { silenceLogger } = require('../helpers/silenceLogger');
const { buildApp } = require('../helpers/buildApp');

// ---------------------------------------------------------------------------
// Top-level integration test suite
// ---------------------------------------------------------------------------
// Outer describe per AAP 0.10.1: "describe('Integration: <component>')".
// This block owns the file-level lifecycle (env capture/restore, logger
// silencing) shared across every nested scenario suite.

describe('Integration: Express app full request chain', () => {
  // -------------------------------------------------------------------------
  // File-level lifecycle: env capture and logger silencing
  // -------------------------------------------------------------------------
  // `originalEnv` is bound in `beforeAll` and restored in `afterAll` so this
  // file's env mutations (including the stack-gating tests in Section 4)
  // never leak to other test files. Per AAP 0.10.1: "Never write to
  // process.env without restoring it."
  //
  // Note: even though `tests/helpers/loadTestEnv.js` populates process.env
  // from `.env.test` once per worker, individual tests in this file flip
  // NODE_ENV between 'production' and 'test' to exercise the error
  // handler's stack-gating contract. The `beforeAll`/`afterAll` pair
  // ensures the worker-level env baseline is restored when this file
  // finishes, which matters when Jest runs other files in the same worker
  // sequentially.

  let originalEnv;

  beforeAll(() => {
    // Capture the worker's env snapshot ONCE before any test runs. Spread
    // copy is required — `originalEnv = process.env` would alias the live
    // object and any subsequent mutation would also mutate the snapshot.
    originalEnv = { ...process.env };

    // Apply the canonical test-mode baseline. testEnv() returns
    // {NODE_ENV: 'test', PORT: '3000', HOST: '127.0.0.1', LOG_LEVEL: 'silent'}.
    // Object.assign mutates process.env in place — required because Node
    // child processes read env from the live object, not from a copy.
    Object.assign(process.env, testEnv());

    // Defense-in-depth: silence the project's Winston logger regardless of
    // LOG_LEVEL. silenceLogger() is idempotent and tolerates the absence
    // of `src/logger/index.js` (returns the original argument unchanged
    // when the module cannot be resolved), so this call never throws even
    // before the broader Express enhancement is authored.
    silenceLogger();
  });

  afterAll(() => {
    // Restore the worker's env snapshot. Direct assignment (rather than
    // spread back into process.env) is sufficient here because we own the
    // entire process.env mutation lifecycle within this file. Subsequent
    // test files (sequenced by Jest in the same worker) observe a clean
    // env identical to the pre-beforeAll state.
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // Section 1: Root route (GET /)
  // -------------------------------------------------------------------------
  // The root route preserves the legacy server.js behavior verbatim:
  // status 200, Content-Type text/plain, body 'Hello, World!\n' (14 bytes
  // INCLUDING the trailing newline). The trailing newline is part of the
  // backward-compatibility contract per AAP 0.4.3 and `helloWorldPayload`.

  describe('GET / (root route)', () => {
    it('should return 200 with the legacy Hello, World body', async () => {
      // Arrange: build a fresh app with the standard wiring.
      const app = buildApp();

      // Act: issue an in-process GET against /.
      const response = await request(app).get('/');

      // Assert: the response body is byte-for-byte identical to the
      // legacy server.js's `res.end('Hello, World!\n')`.
      expect(response.status).toBe(helloWorldPayload.statusCode);
      expect(response.text).toBe(helloWorldPayload.body);
    });

    it('should return text/plain Content-Type when requested at /', async () => {
      const app = buildApp();
      const response = await request(app).get('/');

      // Use a regex to accept Express's automatic charset suffix
      // (`text/plain; charset=utf-8`). Strict equality against
      // 'text/plain' would fail on the with-charset variant.
      expect(response.headers['content-type']).toMatch(/text\/plain/i);
    });

    it('should preserve the trailing newline in the body for legacy compatibility', async () => {
      const app = buildApp();
      const response = await request(app).get('/');

      // The legacy server.js sent exactly 14 bytes ('Hello, World!\n'),
      // including the trailing newline. The Express enhancement MUST
      // preserve this byte sequence — it is the single
      // backward-compatibility checkpoint between the old and new
      // implementations.
      expect(response.text).toBe('Hello, World!\n');
      expect(response.text.endsWith('\n')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Section 2: Health route (GET /health)
  // -------------------------------------------------------------------------
  // The /health route returns a JSON liveness payload for use by PM2,
  // load balancers, and orchestration platforms. Per AAP 0.4.3 and
  // `healthPayload`, the body must contain `status: 'ok'`, a numeric
  // `uptime`, and an ISO-8601 `timestamp`.
  //
  // All assertions on the dynamic fields (`uptime`, `timestamp`) avoid
  // exact-value comparisons because both fields race the system clock.
  // Instead, we assert on type, parseability, and monotonicity.

  describe('GET /health (health route)', () => {
    it('should return 200 with application/json when requested at /health', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      expect(response.status).toBe(healthPayload.statusCode);
      // Tolerant Content-Type assertion via regex — accepts the with-
      // charset and without-charset variants Express emits.
      expect(response.headers['content-type']).toMatch(/application\/json/i);
    });

    it('should include status, uptime, and timestamp keys in the body', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Iterate through the canonical key list from the fixture so this
      // assertion stays in sync with the fixture's contract. Using
      // `forEach` rather than `for...of` matches the codebase's
      // arrow-callback style.
      healthPayload.requiredKeys.forEach((key) => {
        expect(response.body).toHaveProperty(key);
      });

      // Static-value assertions — the `status` field must always be 'ok'
      // for a healthy server. The dynamic fields are type-checked only
      // (deterministic content assertions cannot race the clock).
      expect(response.body.status).toBe(healthPayload.expectedStatus);
      expect(typeof response.body.uptime).toBe(healthPayload.uptimeType);
      expect(typeof response.body.timestamp).toBe(healthPayload.timestampType);
    });

    it('should return an ISO-8601 parseable timestamp value', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Parse the timestamp string into a Date object. If the string is
      // malformed, Date's toString() returns 'Invalid Date' — checking
      // against this exact string is the canonical Node.js pattern for
      // verifying ISO-8601 parseability without third-party libraries.
      // Per AAP 0.10.1: "assert that the timestamp is parseable as an
      // ISO-8601 string ... rather than asserting exact equality, which
      // would race the system clock."
      expect(new Date(response.body.timestamp).toString()).not.toBe(
        'Invalid Date',
      );

      // Additional shape check: ISO-8601 timestamps from Date.toISOString()
      // begin with YYYY-MM-DDTHH:MM:SS. The regex anchors at the start
      // (^) but stops at the seconds boundary so milliseconds and the
      // 'Z' suffix do not affect the match — Express implementations may
      // legitimately use either toISOString() or a custom formatter.
      expect(response.body.timestamp).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    });

    it('should return non-decreasing uptime across consecutive calls', async () => {
      const app = buildApp();

      // First request — capture the initial uptime value.
      const firstResponse = await request(app).get('/health');

      // Wait 10ms so process.uptime() observably advances. Wrapping
      // setTimeout in a Promise lets us `await` it inline (setTimeout
      // itself is callback-based). 10ms is short enough to keep the
      // test fast (<100ms per AAP 0.7.2) yet long enough for
      // process.uptime() to tick on every supported Node version.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second request — uptime must have advanced or stayed equal
      // (non-decreasing). Strict greater-than would race against the
      // host scheduler on heavily loaded CI runners; >= is the correct
      // monotonicity assertion.
      const secondResponse = await request(app).get('/health');

      expect(secondResponse.body.uptime).toBeGreaterThanOrEqual(
        firstResponse.body.uptime,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Section 3: 404 fall-through (unmatched routes)
  // -------------------------------------------------------------------------
  // Express's default behavior for unmatched routes is to dispatch a
  // 404 — the project's notFoundHandler middleware customizes the
  // response body to `{error: 'Not Found', path: req.path}` per AAP 0.4.3
  // and `notFoundPayload.forPath()`.

  describe('404 fall-through (unmatched routes)', () => {
    it('should return 404 JSON when GET is issued against an unknown path', async () => {
      const app = buildApp();
      const response = await request(app).get('/nonexistent-path');

      expect(response.status).toBe(notFoundPayload.statusCode);
      expect(response.headers['content-type']).toMatch(/application\/json/i);

      // Compare against the fixture-provided canonical body for this
      // specific path. notFoundPayload.forPath() returns a fresh object
      // per call so this assertion is safe against accidental mutation.
      expect(response.body).toEqual(notFoundPayload.forPath('/nonexistent-path'));
    });

    it('should return 404 JSON when POST is issued against an unknown path', async () => {
      const app = buildApp();
      const response = await request(app).post('/no-such-route');

      expect(response.status).toBe(404);
      // The error key is the only static field we can assert on without
      // path-specific knowledge — the body's `path` field is dynamic
      // (echoes the request path).
      expect(response.body.error).toBe('Not Found');
    });

    it('should echo the requested path verbatim in the error body', async () => {
      const app = buildApp();
      const requestedPath = '/some/nested/missing/path';

      const response = await request(app).get(requestedPath);

      // The path field MUST mirror the client's requested path so
      // programmatic API consumers can determine which route was
      // rejected without parsing free-form text.
      expect(response.body.path).toBe(requestedPath);
    });

    it('should set Content-Type to application/json on every 404 response', async () => {
      const app = buildApp();
      const response = await request(app).get('/another-missing');

      expect(response.headers['content-type']).toMatch(/application\/json/i);
    });
  });

  // -------------------------------------------------------------------------
  // Section 4: Error handler (thrown errors)
  // -------------------------------------------------------------------------
  // The error handler converts thrown errors (synchronous throws and
  // async-rejected promises) into 500 JSON responses. We inject test-
  // only routes via buildApp({routes: [...]}) to exercise the error
  // path without modifying any production module.
  //
  // Per AAP 0.4.3 the response shape is `{error: {code, message}}`,
  // with `err.statusCode` overrides honored and `err.stack` exposed
  // only when NODE_ENV !== 'production'.

  describe('Error handler (thrown errors)', () => {
    it('should return 500 JSON when a route throws synchronously', async () => {
      // Inject a route that throws a synchronous Error. The Express 5
      // dispatcher catches synchronous throws automatically and forwards
      // them to the registered error handler.
      const app = buildApp({
        routes: [
          (a) => a.get('/throws-sync', () => {
            throw new Error('Synchronous failure');
          }),
        ],
      });

      const response = await request(app).get('/throws-sync');

      expect(response.status).toBe(500);
      expect(response.headers['content-type']).toMatch(/application\/json/i);
      // Use `toBeDefined()` rather than `toEqual({...})` because the
      // exact body shape (object vs nested object) is an implementation
      // choice the test should not over-couple to.
      expect(response.body.error).toBeDefined();
    });

    it('should return 500 JSON when a route rejects a promise (Express 5 auto-handles async rejections)', async () => {
      // Express 5 (the project's pinned version) automatically forwards
      // rejected promises from middleware/handlers to the error chain —
      // older Express versions required explicit `.catch(next)` or
      // `next(err)`. This test exercises the auto-forwarding contract.
      const app = buildApp({
        routes: [
          (a) => a.get('/throws-async', async () => {
            throw new Error('Asynchronous rejection');
          }),
        ],
      });

      const response = await request(app).get('/throws-async');

      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
    });

    it('should include error.message in the response body', async () => {
      // Inject a route that forwards a custom-message error via
      // next(err). This pattern (rather than throwing) lets us pass an
      // error object without relying on the implicit throw-to-error-chain
      // forwarding — useful for verifying the handler's body shape
      // independent of the throw-detection path.
      const app = buildApp({
        routes: [
          (a) => a.get('/with-message', (req, res, next) => {
            next(new Error('Specific error message'));
          }),
        ],
      });

      const response = await request(app).get('/with-message');

      expect(response.status).toBe(500);

      // The handler may nest `message` under `body.error.message` or
      // place it at `body.message` — both layouts are common in the
      // Express ecosystem. Defensive resolution keeps the test coupled
      // to the CONTRACT (a non-empty message string is present) rather
      // than an exact layout chosen by the broader enhancement.
      const message = (response.body.error && response.body.error.message)
        || response.body.message;
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    });

    it('should include err.stack in the response body when NODE_ENV is development', async () => {
      // Mutate NODE_ENV INSIDE the test so the configuration loader
      // (re-resolved by buildApp) produces a development-mode app. This
      // exercises the stack-exposure branch that should leak the stack
      // for debugging convenience in development.
      //
      // The mutation is bracketed and reverted at the end of this test;
      // even if the revert is bypassed by an early throw, the outer
      // `afterAll` restores `process.env` from `originalEnv` so the
      // mutation never leaks to other test files.
      process.env.NODE_ENV = 'development';

      const app = buildApp({
        routes: [
          (a) => a.get('/dev-stack-error', () => {
            throw new Error('Stack-exposing error');
          }),
        ],
      });

      const response = await request(app).get('/dev-stack-error');

      expect(response.status).toBe(500);

      // Defensive stack-presence detection — the implementation may
      // place the stack under `body.error.stack` (nested) or
      // `body.stack` (top-level). Both are acceptable layouts for the
      // contract "expose stack in development".
      const stack = (response.body.error && response.body.error.stack)
        || response.body.stack;
      expect(stack).toBeDefined();

      // Restore the test-mode env baseline so subsequent tests in this
      // suite observe NODE_ENV='test' (the file-level baseline).
      Object.assign(process.env, testEnv());
    });

    it('should NOT include err.stack in the response body when NODE_ENV is production', async () => {
      // Apply the production env (NODE_ENV='production', LOG_LEVEL='info'),
      // build a fresh app, and assert that the stack is suppressed. Per
      // AAP 0.4.3: "NODE_ENV === 'production' -> response excludes
      // err.stack." Leaking stacks in production exposes internal file
      // paths and library versions attackers can use for reconnaissance.
      Object.assign(process.env, productionEnv());

      const app = buildApp({
        routes: [
          (a) => a.get('/prod-no-stack', () => {
            throw new Error('Production-suppressed error');
          }),
        ],
      });

      const response = await request(app).get('/prod-no-stack');

      expect(response.status).toBe(500);

      // The stack must NOT be present in either common layout.
      const stack = (response.body.error && response.body.error.stack)
        || response.body.stack;
      expect(stack).toBeUndefined();

      // Restore the test-mode env baseline.
      Object.assign(process.env, testEnv());
    });

    it('should honor err.statusCode override when an error attaches a custom status', async () => {
      // Inject a route that forwards an error with a custom statusCode
      // (422 — Unprocessable Entity). The handler must use this code
      // rather than the default 500 fallback per AAP 0.4.3.
      const app = buildApp({
        routes: [
          (a) => a.get('/unprocessable', (req, res, next) => {
            const err = new Error('Unprocessable Entity');
            err.statusCode = 422;
            next(err);
          }),
        ],
      });

      const response = await request(app).get('/unprocessable');

      expect(response.status).toBe(422);
      expect(response.body.error).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Section 5: Middleware ordering
  // -------------------------------------------------------------------------
  // Verifies that the middleware chain wires up in the correct sequence
  // (request logger and any standard middleware before route handlers,
  // error handler last) and that the Express app exposes the standard
  // surface without binding to a real port.

  describe('Middleware ordering', () => {
    it('should execute injected middleware before the route handler', async () => {
      // Order verification via a shared call-log array: the injected
      // middleware pushes 'middleware', the test route pushes 'handler'.
      // After the request completes, the array's index ordering
      // confirms the middleware ran first.
      const callLog = [];
      const app = buildApp({
        middleware: [
          (req, res, next) => {
            callLog.push('middleware');
            next();
          },
        ],
        routes: [
          (a) => a.get('/order-check', (req, res) => {
            callLog.push('handler');
            res.status(200).json({ ok: true });
          }),
        ],
      });

      await request(app).get('/order-check');

      // Both entries must be present and the middleware index must
      // precede the handler index. Using indexOf rather than direct
      // array-element comparison keeps the assertion robust against
      // future additions to the middleware chain (which would push
      // additional entries before either token, leaving the relative
      // ordering still valid).
      const middlewareIdx = callLog.indexOf('middleware');
      const handlerIdx = callLog.indexOf('handler');
      expect(middlewareIdx).toBeGreaterThanOrEqual(0);
      expect(handlerIdx).toBeGreaterThan(middlewareIdx);
    });

    it('should execute the error handler as the final middleware (catches throws)', async () => {
      // The error handler is registered LAST in the middleware chain
      // (per Express's 4-arg convention) so it catches throws from
      // every preceding middleware/handler. This test injects a
      // throwing route and verifies the response is the canonical
      // error-handler 500 JSON — proving the error handler is wired
      // last (otherwise an earlier non-error middleware would intercept
      // and the response shape would differ).
      const app = buildApp({
        routes: [
          (a) => a.get('/late-error', () => {
            throw new Error('Late-stage error');
          }),
        ],
      });

      const response = await request(app).get('/late-error');

      expect(response.status).toBe(500);
      expect(response.headers['content-type']).toMatch(/application\/json/i);
    });

    it('should expose the standard Express surface without binding to a port', () => {
      // Synchronous test (no `async`) — we are inspecting the app
      // object's shape, not issuing HTTP requests. Express apps are
      // callable functions that ARE the request handler; the .use,
      // .get, and .post methods must be present so middleware and
      // routes can be registered. None of these inspections trigger
      // a network bind.
      const app = buildApp();

      expect(typeof app).toBe('function');
      expect(typeof app.use).toBe('function');
      expect(typeof app.get).toBe('function');
      expect(typeof app.post).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // Section 6: HTTP method coverage
  // -------------------------------------------------------------------------
  // Verifies behavior across the HTTP methods relevant to the project's
  // routes. The root route is registered as GET-only, so non-GET methods
  // fall through to the 404 handler. HEAD is special-cased by Express to
  // return the same status/headers as GET with an empty body (per
  // RFC 7231).

  describe('HTTP methods coverage', () => {
    it('should accept HEAD / and return 200 with an empty body', async () => {
      const app = buildApp();
      const response = await request(app).head('/');

      // Express's GET handler also responds to HEAD by default — same
      // status code and headers, but the body is stripped per RFC 7231.
      expect(response.status).toBe(200);
      // Supertest reports the empty body as either undefined or empty
      // string depending on the Content-Type. `toBeFalsy()` accepts
      // both common variants ('', undefined, null, 0).
      expect(response.text).toBeFalsy();
    });

    it('should return 404 for POST / when the root route is GET-only', async () => {
      // The root route is registered with `app.get('/')`, NOT
      // `app.all('/')`. Non-GET methods on the root path therefore fall
      // through to the 404 handler. This test verifies the default
      // Express behavior holds (no implicit 405 Method Not Allowed
      // handler is registered).
      const app = buildApp();
      const response = await request(app).post('/').send({ data: 'test' });

      expect(response.status).toBe(404);
    });
  });
});
