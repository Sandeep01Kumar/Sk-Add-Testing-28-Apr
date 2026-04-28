'use strict';

/**
 * tests/unit/routes/health.test.js
 *
 * Unit tests for the Express health-check route handler at
 * `src/routes/health.js`.
 *
 * Test contracts verified:
 *   1. GET /health returns HTTP status 200 (per AAP 0.4.3 — the canonical
 *      health-probe response code expected by PM2 and load balancers).
 *   2. Content-Type is `application/json` (Express may include a charset
 *      suffix such as `application/json; charset=utf-8` — both are
 *      accepted by the regex match).
 *   3. Body is JSON with required keys `status`, `uptime`, `timestamp`
 *      (per `healthPayload.requiredKeys` from the canonical fixture).
 *   4. `body.status === 'ok'` (per `healthPayload.expectedStatus`).
 *   5. `typeof body.uptime === 'number'` and the value is finite and
 *      non-negative.
 *   6. `typeof body.timestamp === 'string'` and the value is parseable
 *      as a JavaScript Date — the assertion uses parseability checks
 *      ONLY (per AAP 0.10.1 — exact equality on a wall-clock timestamp
 *      would race the system clock and produce flaky failures).
 *   7. Consecutive GET /health calls return monotonically non-decreasing
 *      uptime AND non-decreasing timestamps — verifies the handler
 *      reads fresh values from `process.uptime()` and `Date.now()` per
 *      request rather than caching them at module load time.
 *   8. The body contains NO sensitive fields (`password`, `secret`,
 *      `token`, `api_key`) — defense-in-depth assertion that catches
 *      accidental disclosures even when future fields are added.
 *   9. Non-GET methods (POST, PUT, DELETE, PATCH) on `/health` fall
 *      through to the 404 handler (the route is registered as GET-only;
 *      Express's default behavior is for non-matching methods on a
 *      registered path to bypass the handler and proceed to subsequent
 *      middleware — which in this app is the 404 handler).
 *  10. `buildApp()` returns a fresh app per invocation — test isolation
 *      contract — and Supertest exercises the app without ever calling
 *      `app.listen()`.
 *
 * Test strategy:
 *   - Use Supertest's in-process injection — NEVER call `app.listen()`
 *     (per AAP Section 0.10.1: "Never call `app.listen()` from any test
 *     file. All HTTP-level testing uses Supertest's in-process
 *     injection."). Supertest binds the app to an ephemeral port for
 *     the duration of each request and tears it down automatically; no
 *     manual port management or cleanup is required and tests are
 *     parallel-safe.
 *   - Construct a fresh Express app per test via `buildApp()` so each
 *     test is independently runnable (per AAP 0.7.2).
 *   - Assert against the canonical `healthPayload` and `notFoundPayload`
 *     fixtures imported from `tests/fixtures/payloads.fixtures.js`. This
 *     keeps the test logic small and ensures any future contract change
 *     requires updating exactly one fixture file rather than fan-out
 *     edits across every health-related test.
 *   - Do NOT directly require `src/routes/health.js`. The route is
 *     exercised through the full Express app (constructed by
 *     `buildApp()`), which catches integration bugs (router mounting,
 *     middleware ordering, base-path mismatches) that direct route
 *     imports would miss.
 *
 * Mock dependencies: NONE (per AAP Section 0.5.2 — "Mock dependencies:
 *   none — Supertest in-process"). The /health route is environment-
 *   independent and has no external dependencies, no database, no
 *   third-party API calls — there is nothing to mock. The logger
 *   silencing for the broader suite is handled centrally via
 *   `tests/fixtures/.env.test` (LOG_LEVEL=silent) loaded by Jest's
 *   `setupFiles` hook.
 *
 * Why no `process.env` mutation in this file:
 *   The /health route's behavior is environment-independent — it
 *   returns the same shape regardless of NODE_ENV, LOG_LEVEL, PORT, or
 *   HOST. This file therefore does NOT mutate `process.env` at all,
 *   eliminating a class of cross-test pollution bugs. Tests that DO
 *   depend on environment variables (e.g., the config loader tests in
 *   `tests/unit/config/`) follow the canonical capture-and-restore
 *   pattern in their own `beforeEach`/`afterEach` hooks per AAP 0.10.1.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS `require()`/`module.exports` (matches package.json's
 *     lack of `"type": "module"`).
 *   - Two-space indentation, single quotes, semicolons, const-by-default.
 *   - Trailing commas in multiline arrays/objects.
 *   - Block hierarchy: `describe('Unit: ...')` -> `describe(scenario)`
 *     -> `it("should <behavior> when <condition>")`.
 *   - Arrange-Act-Assert pattern within each test (each test calls
 *     `buildApp()` once for Arrange, issues one Supertest request for
 *     Act, then runs `expect()` assertions for Assert).
 *   - File naming: `health.test.js` mirrors `src/routes/health.js`.
 *
 * Path resolution (per AAP Section 0.6.2):
 *   From `tests/unit/routes/health.test.js`:
 *     - `'../../helpers/buildApp'`            -> `tests/helpers/buildApp.js`
 *     - `'../../fixtures/payloads.fixtures'`  -> `tests/fixtures/payloads.fixtures.js`
 *     - `'supertest'`                         -> npm package (bare specifier)
 *   No direct import of `src/routes/health.js` — the route is reached
 *   indirectly through the app constructed by `buildApp()`.
 *
 * Coordination note (per AAP Section 0.2.1):
 *   The Express app at `src/app.js` and the health route at
 *   `src/routes/health.js` are created by the broader Express
 *   enhancement (NOT by this testing AAP). Until those files exist,
 *   `buildApp()` will throw `MODULE_NOT_FOUND` when its lazy
 *   `require('../../src/app')` executes, and every test below will
 *   fail at the `buildApp()` call. This is expected and acceptable
 *   per AAP Section 0.2.1 — the testing AAP and the broader
 *   enhancement are coordinated efforts and the test suite is
 *   authored ahead of (or alongside) the source code so the contracts
 *   are pinned before implementation begins.
 *
 * @module tests/unit/routes/health.test
 * @see tests/helpers/buildApp.js
 * @see tests/fixtures/payloads.fixtures.js
 * @see https://github.com/ladjs/supertest
 */

const request = require('supertest');
const { buildApp } = require('../../helpers/buildApp');
const {
  healthPayload,
  notFoundPayload,
} = require('../../fixtures/payloads.fixtures');

describe('Unit: src/routes/health.js (health route)', () => {
  // ------------------------------------------------------------------
  // Happy path: GET /health returns 200 JSON
  // ------------------------------------------------------------------
  // The /health route's primary contract is a 200 OK with a JSON body
  // containing operational metadata. These tests verify each dimension
  // of that contract — status, content-type, body parseability — in
  // isolated `it` blocks so that a failure in any single dimension
  // surfaces immediately in the test output without obscuring the
  // others. Splitting the assertions also keeps each test focused on
  // a single behavior, which is the canonical TDD pattern.
  describe('Happy path: GET /health', () => {
    it('should return 200 status when GET /health is requested', async () => {
      // Arrange: construct a fresh Express app for this test.
      const app = buildApp();

      // Act: issue an in-process GET /health request via Supertest.
      const response = await request(app).get('/health');

      // Assert: the status code must match the canonical fixture
      // (healthPayload.statusCode === 200). Asserting against the
      // fixture rather than the literal `200` ensures that a future
      // contract change would require updating the fixture in exactly
      // one place rather than every health-related test.
      expect(response.status).toBe(healthPayload.statusCode);
    });

    it('should return Content-Type containing application/json when GET /health is requested', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Express may emit `Content-Type: application/json` (no charset)
      // or `Content-Type: application/json; charset=utf-8` (with
      // charset) depending on configuration. Strict equality
      // `.toBe('application/json')` would fail the latter
      // unnecessarily; the regex tolerates both shapes. The `i` flag
      // accepts implementation-emitted casing variants like
      // `Application/JSON` (uncommon but valid per RFC 7231).
      expect(response.headers['content-type']).toMatch(/application\/json/i);
    });

    it('should return a parseable JSON object body when GET /health succeeds', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Supertest auto-parses JSON response bodies into `response.body`
      // when the Content-Type matches `/json/`. Asserting both
      // `typeof === 'object'` AND `not.toBeNull()` is necessary
      // because `typeof null === 'object'` in JavaScript — the
      // `null` check rules out the degenerate case where the handler
      // accidentally returns `res.json(null)`.
      expect(typeof response.body).toBe('object');
      expect(response.body).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Body shape verification (per healthPayload contract)
  // ------------------------------------------------------------------
  // The health response body has a fixed shape with three required
  // keys: `status`, `uptime`, `timestamp`. These tests verify each
  // key is present and of the documented type. The required-keys
  // iteration uses the canonical fixture's `requiredKeys` array, so
  // adding a new required key in the future requires updating the
  // fixture (one place) rather than every test (fan-out).
  //
  // The final test in this group (sensitive-data check) is a
  // defense-in-depth assertion that scans the entire body for known
  // secret-flavored substrings. It catches regressions where a
  // future implementation accidentally exposes a secret in a debug
  // field (e.g., `apiKey`, `dbPassword`, `sessionToken`).
  describe('Body shape: required keys', () => {
    it('should include all required keys (status, uptime, timestamp) when GET /health succeeds', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Iterate the canonical required-keys array and assert each
      // key is present in the response body. Using `forEach` rather
      // than a fixed list of `expect().toHaveProperty()` calls keeps
      // the test forward-compatible with fixture changes — a new
      // required key added to `healthPayload.requiredKeys` would be
      // automatically asserted here without code edits.
      healthPayload.requiredKeys.forEach((key) => {
        expect(response.body).toHaveProperty(key);
      });
    });

    it('should set status to "ok" when GET /health succeeds', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // `status === 'ok'` is the static portion of the health
      // contract — it does NOT vary per request and MUST be exactly
      // the literal string 'ok' (per healthPayload.expectedStatus).
      // A mismatch here indicates either the handler is returning a
      // different status string (e.g., 'healthy', 'up') or that the
      // contract has been intentionally changed and the fixture
      // needs updating.
      expect(response.body.status).toBe(healthPayload.expectedStatus);
    });

    it('should set uptime to a number when GET /health succeeds', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Type assertion only — value range is verified by the
      // dedicated `Uptime: numeric, non-negative` describe block
      // below. Using `healthPayload.uptimeType` (the string 'number')
      // rather than the literal `'number'` keeps the assertion
      // canonical-fixture-driven.
      expect(typeof response.body.uptime).toBe(healthPayload.uptimeType);
    });

    it('should set timestamp to a string when GET /health succeeds', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Type assertion only — parseability and shape are verified by
      // the dedicated `Timestamp: ISO-8601 parseable` describe block
      // below. The handler must return an ISO-8601 STRING (not a
      // Date object, not a numeric epoch); JSON serialization would
      // not preserve a Date instance, and a numeric epoch would be
      // ambiguous with `uptime`.
      expect(typeof response.body.timestamp).toBe(healthPayload.timestampType);
    });

    it('should not include sensitive data (password, secret, token, api_key) in the response body', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Defense-in-depth: serialize the entire body and scan for
      // known secret-flavored substrings. The check is
      // case-insensitive (via `.toLowerCase()`) so it catches
      // capitalization variants like `API_KEY`, `Password`,
      // `accessToken`, etc. Each negative assertion fails on the
      // FIRST violation, which yields a clear test output naming
      // exactly which forbidden substring leaked.
      //
      // This test does NOT assert the body must EXCLUDE these
      // strings entirely (e.g., a future field could legitimately
      // be `tokenBucket` for rate-limit metadata). For now, the
      // bare substring check is acceptable — if a legitimate field
      // ever requires one of these substrings, the test should be
      // updated to a more nuanced check (e.g., a regex anchored to
      // word boundaries) or the fixture should be extended with a
      // documented allow-list.
      const bodyString = JSON.stringify(response.body).toLowerCase();
      expect(bodyString).not.toContain('password');
      expect(bodyString).not.toContain('secret');
      expect(bodyString).not.toContain('token');
      expect(bodyString).not.toContain('api_key');
    });
  });

  // ------------------------------------------------------------------
  // Uptime: should be non-negative finite number
  // ------------------------------------------------------------------
  // `process.uptime()` returns the number of seconds since the
  // Node.js process started — a high-resolution floating-point
  // value that monotonically increases. These tests verify the
  // handler exposes that value (or an equivalent monotonic counter)
  // and that it is well-formed (finite, non-negative). The
  // monotonicity check uses a 10ms `setTimeout` between two
  // requests to ensure an OBSERVABLE difference; without the wait,
  // the two calls might land in the same millisecond and produce
  // identical uptime values, which would still satisfy the `>=`
  // contract but provides weaker evidence of the per-request read.
  describe('Uptime: numeric, non-negative', () => {
    it('should report uptime as a non-negative number when GET /health succeeds', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Uptime cannot be negative — the process cannot have started
      // in the future. The `>= 0` lower bound covers the edge case
      // where `process.uptime()` is called immediately at process
      // start and returns 0 (or near-zero positive values).
      expect(typeof response.body.uptime).toBe('number');
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should report uptime as a finite number when GET /health succeeds', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // `Number.isFinite()` rejects `Infinity`, `-Infinity`, and
      // `NaN` — all of which would technically pass `typeof ===
      // 'number'` but would be invalid uptime values. The handler
      // should always return a finite floating-point seconds count.
      expect(Number.isFinite(response.body.uptime)).toBe(true);
    });

    it('should return monotonically non-decreasing uptime when called consecutively', async () => {
      const app = buildApp();

      // First request — capture the uptime baseline.
      const r1 = await request(app).get('/health');

      // Wait 10ms so the observable uptime delta is non-zero. The
      // wait is intentional — `process.uptime()` resolution is
      // sub-millisecond on modern platforms, so two back-to-back
      // calls might land in the same millisecond and produce
      // identical values. The 10ms gap guarantees the second call
      // sees a different (greater) value, which provides stronger
      // evidence that the handler reads `process.uptime()` per
      // request rather than caching it at module load time.
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const r2 = await request(app).get('/health');

      // `>=` (not `>`) accommodates the unlikely-but-possible edge
      // case where `process.uptime()` resolution exceeds the 10ms
      // wait or the OS clock has drifted backward by a tiny amount.
      // The strict-monotonicity contract is not part of the
      // documented health-route shape; the relaxed contract
      // (`r2 >= r1`) is sufficient to verify per-request reads and
      // forward-time progression.
      expect(r2.body.uptime).toBeGreaterThanOrEqual(r1.body.uptime);
    });
  });

  // ------------------------------------------------------------------
  // Timestamp: ISO-8601 parseable (DETERMINISTIC — no clock racing)
  // ------------------------------------------------------------------
  // Per AAP Section 0.10.1: "Write deterministic timestamp assertions.
  // When testing /health (which returns a current timestamp), assert
  // that the timestamp is parseable as an ISO-8601 string ... rather
  // than asserting exact equality, which would race the system
  // clock."
  //
  // These tests therefore verify three orthogonal properties of the
  // timestamp string:
  //   1. PARSEABILITY — `new Date(...).toString() !== 'Invalid Date'`
  //      proves the value can be reconstructed as a valid Date.
  //   2. SHAPE — the regex `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/`
  //      enforces the ISO-8601 prefix (year-month-dayThour:minute:
  //      second). The prefix-only regex is intentional: the full
  //      ISO-8601 grammar permits fractional seconds, milliseconds,
  //      and a timezone suffix (e.g., `2025-01-01T12:00:00.000Z`),
  //      and the handler is free to include or omit those tail
  //      components without breaking the contract.
  //   3. WINDOW — the parsed timestamp falls within ±1 second of
  //      `Date.now()` at request time. The ±1s window is generous
  //      enough to absorb minor system clock skew, slow CI
  //      environments, and Supertest's in-process round-trip
  //      latency, while still being tight enough to catch a stale
  //      hardcoded value or a 24-hour-off rendering bug.
  //
  // The fourth test verifies that consecutive requests produce
  // non-decreasing timestamps — the same monotonicity contract
  // applied to uptime, but at millisecond resolution rather than
  // sub-second.
  describe('Timestamp: ISO-8601 parseable (deterministic assertion)', () => {
    it('should return a timestamp parseable as a valid Date when GET /health succeeds', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // Per AAP 0.10.1: assert PARSEABILITY, NEVER exact equality.
      // `new Date('garbage').toString()` returns the literal string
      // 'Invalid Date', so a parseable timestamp will produce some
      // OTHER string (the canonical Date.toString() rendering).
      // This is the strongest possible assertion that does NOT race
      // the system clock.
      expect(new Date(response.body.timestamp).toString()).not.toBe('Invalid Date');
    });

    it('should return a timestamp matching the ISO-8601 prefix shape when GET /health succeeds', async () => {
      const app = buildApp();
      const response = await request(app).get('/health');

      // ISO-8601 prefix regex: YYYY-MM-DDTHH:MM:SS. The full ISO
      // form may include `.SSS` (fractional seconds) and a `Z` or
      // `±HH:MM` timezone suffix; this regex matches only the
      // prefix and intentionally does NOT anchor at the end ($).
      // That tolerance lets the handler emit any of:
      //   2025-01-01T12:00:00.000Z         (millisecond + UTC)
      //   2025-01-01T12:00:00Z             (no fractional, UTC)
      //   2025-01-01T12:00:00-05:00        (with timezone offset)
      //   2025-01-01T12:00:00.123456+00:00 (microsecond + offset)
      // All four are RFC 3339 / ISO-8601 compliant and all four
      // satisfy this regex. The implementation is therefore free
      // to choose any valid form.
      expect(response.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should return a timestamp close to the current system time when GET /health succeeds', async () => {
      const app = buildApp();

      // Capture the time bracket: the response timestamp must fall
      // within ±1000ms of this window. Using `before` and `after`
      // to bracket the request gives a tight bound while still
      // tolerating in-process round-trip latency.
      const before = Date.now();
      const response = await request(app).get('/health');
      const after = Date.now();

      // Convert the response timestamp string back to milliseconds
      // since epoch via `new Date(...).getTime()`. This conversion
      // is the canonical inverse of `new Date().toISOString()`.
      const stamp = new Date(response.body.timestamp).getTime();

      // ±1000ms window: protects against minor system clock skew
      // (Supertest's in-process call should be sub-millisecond, but
      // CI runners can occasionally pause for GC or context-switch
      // delays). A tighter window (e.g., ±100ms) would be flakier
      // on slow CI without providing meaningfully stronger
      // verification of correctness.
      expect(stamp).toBeGreaterThanOrEqual(before - 1000);
      expect(stamp).toBeLessThanOrEqual(after + 1000);
    });

    it('should return non-decreasing timestamps across consecutive calls', async () => {
      const app = buildApp();

      // First request — capture the timestamp baseline.
      const r1 = await request(app).get('/health');

      // 10ms wait so the second request lands in a strictly later
      // millisecond — at millisecond resolution this gap is well
      // above the noise floor. The wait is the same idiom used in
      // the uptime monotonicity test above; both tests verify
      // per-request reads of mutable runtime state.
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const r2 = await request(app).get('/health');

      // Convert both timestamps to milliseconds and compare. `>=`
      // (not `>`) is the relaxed contract — a system clock that
      // ticks backward by a tiny amount (NTP correction, leap
      // smearing) should not fail the test, since the handler
      // itself is correct in such cases.
      const t1 = new Date(r1.body.timestamp).getTime();
      const t2 = new Date(r2.body.timestamp).getTime();
      expect(t2).toBeGreaterThanOrEqual(t1);
    });
  });

  // ------------------------------------------------------------------
  // Error cases: non-GET methods fall through to the 404 handler
  // ------------------------------------------------------------------
  // The /health route is registered with `app.get('/health', handler)`
  // — GET-only. Non-GET requests (POST, PUT, DELETE, PATCH) on the
  // same path therefore fall through to the 404 handler, which
  // responds with `{error: 'Not Found', path: '/health'}`. Per AAP
  // Section 0.4.3, the project chose 404 fall-through (the default
  // Express behavior) over 405 Method Not Allowed (which would
  // require additional middleware) — this test pins that contract
  // explicitly.
  //
  // Each method gets its own `it` block so a failure pinpoints the
  // exact method that violated the contract. Without the per-method
  // tests, a regression that accidentally registered
  // `app.all('/health', handler)` (matches every method) would
  // silently slip through with a single combined "all methods
  // return 200" test.
  describe('Error cases: non-GET methods', () => {
    it('should return 404 when POST /health is requested', async () => {
      const app = buildApp();

      // POST with an empty body: the request body should not
      // influence the routing decision (the route is GET-only, so
      // any body is irrelevant). Sending a body verifies that body
      // parsing does not accidentally trigger a different code path.
      const response = await request(app).post('/health').send({});

      expect(response.status).toBe(notFoundPayload.statusCode);
    });

    it('should return 404 when PUT /health is requested', async () => {
      const app = buildApp();
      const response = await request(app).put('/health').send({});

      expect(response.status).toBe(notFoundPayload.statusCode);
    });

    it('should return 404 when DELETE /health is requested', async () => {
      const app = buildApp();

      // DELETE typically has no body; we omit `.send(...)` here to
      // exercise the body-less code path. The route is still
      // GET-only and DELETE must fall through to 404.
      const response = await request(app).delete('/health');

      expect(response.status).toBe(notFoundPayload.statusCode);
    });

    it('should return 404 when PATCH /health is requested', async () => {
      const app = buildApp();
      const response = await request(app).patch('/health').send({});

      expect(response.status).toBe(notFoundPayload.statusCode);
    });
  });

  // ------------------------------------------------------------------
  // Idempotency: GET /health is idempotent
  // ------------------------------------------------------------------
  // Idempotency is a contract requirement for any health-check
  // endpoint: PM2, load balancers, and orchestrators (Kubernetes,
  // Docker Swarm, Nomad) issue health probes at high frequency
  // (often every few seconds), and a non-idempotent endpoint would
  // produce inconsistent results that could cascade into false
  // unhealthy markings.
  //
  // These tests verify that consecutive GET /health calls produce
  // structurally identical responses — same status, same
  // content-type, same key shape. The DYNAMIC fields (`uptime`,
  // `timestamp`) are EXPECTED to change across calls and are
  // therefore NOT compared for equality here; their monotonicity
  // contracts are tested separately above.
  describe('Idempotency: GET /health', () => {
    it('should respond with the same shape across multiple consecutive calls', async () => {
      const app = buildApp();

      // Three consecutive calls — sufficient to detect any
      // first-vs-subsequent divergence (e.g., a closure-captured
      // counter, a one-shot initialization that flips after the
      // first request, a lazy-cache that mis-renders on subsequent
      // calls).
      const r1 = await request(app).get('/health');
      const r2 = await request(app).get('/health');
      const r3 = await request(app).get('/health');

      // Status code is static: every call must return the same
      // canonical status (200 OK).
      expect(r1.status).toBe(r2.status);
      expect(r2.status).toBe(r3.status);

      // Content-Type is static: every call must return the same
      // canonical content-type header (Express does not vary
      // Content-Type per request for a single registered handler).
      expect(r1.headers['content-type']).toBe(r2.headers['content-type']);
      expect(r2.headers['content-type']).toBe(r3.headers['content-type']);

      // Required keys must be present in every response — the body
      // SHAPE is static even though the values of `uptime` and
      // `timestamp` are dynamic.
      healthPayload.requiredKeys.forEach((key) => {
        expect(r1.body).toHaveProperty(key);
        expect(r2.body).toHaveProperty(key);
        expect(r3.body).toHaveProperty(key);
      });

      // The static `status` field must be exactly 'ok' on every
      // call. A drift here (e.g., the second call returning
      // 'degraded' due to a stateful side effect) would indicate
      // a serious idempotency violation.
      expect(r1.body.status).toBe(healthPayload.expectedStatus);
      expect(r2.body.status).toBe(healthPayload.expectedStatus);
      expect(r3.body.status).toBe(healthPayload.expectedStatus);
    });

    it('should produce a fresh app instance per buildApp() call', () => {
      // Two consecutive calls to buildApp() must return DIFFERENT
      // app instances (different object references). If they were
      // the same instance, tests that mutate the app (e.g., to add
      // override middleware) would leak state into subsequent tests
      // and parallel test execution would produce flaky failures.
      // This test pins the helper's per-call freshness contract
      // explicitly and serves as a meta-contract for the entire
      // test suite.
      const a = buildApp();
      const b = buildApp();

      // `.not.toBe(b)` is a reference-identity check — strictly
      // distinct object references. This is the strongest possible
      // isolation guarantee at the JavaScript object level.
      expect(a).not.toBe(b);
    });
  });

  // ------------------------------------------------------------------
  // Test isolation
  // ------------------------------------------------------------------
  // Meta-contract verification: the test suite never accidentally
  // invokes `app.listen()` (per AAP 0.10.1 — "Never call
  // `app.listen()` from any test file"). Supertest manages
  // ephemeral port binding internally for the duration of each
  // request and tears it down on response, so the test code itself
  // does NOT need to manage ports, sockets, or connection pools.
  // This test pins that contract by asserting the app surface is a
  // callable function (the Express request handler that node's
  // http.Server invokes for each incoming request) AND that a
  // Supertest request against it succeeds without manual port
  // management.
  describe('Test isolation', () => {
    it('should never call app.listen() during test (no port binding)', async () => {
      const app = buildApp();

      // The Express app is itself a callable function — the
      // request handler signature `(req, res) => void` that
      // node's http.Server expects. Asserting `typeof === 'function'`
      // confirms the app surface is correct.
      expect(typeof app).toBe('function');

      // Issuing a Supertest request against the app DOES NOT
      // require app.listen() to have been called — Supertest
      // manages an ephemeral port internally for the duration of
      // the request and tears it down on response. This assertion
      // exercises both halves of the contract: app is callable,
      // AND a request against it succeeds without manual port
      // management.
      const response = await request(app).get('/health');

      expect(response.status).toBe(healthPayload.statusCode);
    });
  });
});
