'use strict';

/**
 * src/routes/health.js
 *
 * Express health-check route — registers GET /health for liveness
 * probing by PM2, load balancers, and orchestration platforms
 * (Kubernetes, Docker Swarm, Nomad).
 *
 * Behavior contract (per AAP Section 0.4.3 and the
 * tests/unit/routes/health.test.js test suite):
 *
 *   Route registration
 *     - Registered as `GET /health` only — non-GET methods (POST,
 *       PUT, DELETE, PATCH) on `/health` fall through to the 404
 *       handler. This is the default Express behavior; no
 *       method-not-allowed middleware is added.
 *
 *   Response shape
 *     - Status: 200 (OK)
 *     - Content-Type: application/json (with optional charset
 *       suffix — Express's default for res.json is
 *       'application/json; charset=utf-8').
 *     - Body: JSON object with EXACTLY three keys:
 *         status    : string — always 'ok' (static value, indicates
 *                     the process is alive)
 *         uptime    : number — process uptime in seconds, finite,
 *                     non-negative, monotonically non-decreasing
 *                     across requests
 *         timestamp : string — ISO-8601 timestamp of the request,
 *                     parseable as a JavaScript Date, close to the
 *                     current system clock at request time
 *
 *   Dynamic field semantics
 *     - `uptime` MUST be read fresh per request via
 *       `process.uptime()`. Caching the value at module-load time
 *       would cause the test "monotonically non-decreasing uptime"
 *       to fail.
 *     - `timestamp` MUST be read fresh per request via
 *       `new Date().toISOString()`. Caching the value at module-load
 *       time would cause the test "non-decreasing timestamps" and
 *       the "close to current system time" assertion to fail.
 *
 *   Idempotency
 *     - The body SHAPE is constant across requests (same keys, same
 *       static `status` value, same types). Only the dynamic
 *       `uptime` and `timestamp` fields vary. This is the contract
 *       PM2/orchestrators rely on: a constant-shape response with
 *       monotonically advancing dynamic fields.
 *
 *   Sensitive-data exclusion
 *     - The body MUST NOT include any string containing the
 *       substrings 'password', 'secret', 'token', or 'api_key'
 *       (case-insensitive). This is a defense-in-depth contract:
 *       even if a future field is added, the body should never leak
 *       credentials.
 *
 * Module export contract:
 *   - Exports an `applyRoutes(app)` registrar function as the
 *     default export. The factory in `src/app.js` invokes
 *     `applyRoutes(app)` to register the route on the app instance.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons,
 *     const-by-default
 *   - Trailing commas in multiline literals
 *   - 'use strict' at the file head
 *
 * @module src/routes/health
 */

// ---------------------------------------------------------------------------
// Constants — canonical response values
// ---------------------------------------------------------------------------

/**
 * The canonical static value for the `status` field. Health-check
 * probes use this string to signal "process is alive".
 *
 * Held in a constant so future operational signals (e.g., a
 * 'degraded' status when downstream dependencies are unhealthy)
 * can be added by extending the response builder without breaking
 * the static-status contract.
 *
 * @type {string}
 */
const HEALTH_STATUS_OK = 'ok';

/**
 * The HTTP status code for a healthy probe response.
 *
 * @type {number}
 */
const STATUS_OK = 200;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Express handler for GET /health.
 *
 * Builds a fresh response body with the current process uptime and
 * an ISO-8601 timestamp, then sends it as JSON with status 200.
 *
 * Each invocation reads `process.uptime()` and `new Date()` directly
 * (NOT via cached values) so consecutive calls produce
 * monotonically advancing dynamic fields. This is critical for the
 * monotonicity tests in tests/unit/routes/health.test.js and the
 * idempotency contract that PM2/orchestrators rely on.
 *
 * The unused `_req` parameter is kept (rather than omitted) so the
 * function maintains Express's documented `(req, res, next?)`
 * signature. The underscore prefix signals intentional non-use.
 *
 * @param {import('express').Request} _req The Express request
 *   object. Not consumed — the health route's response is
 *   independent of request data.
 * @param {import('express').Response} res The Express response
 *   object. The handler calls `res.status(200).json({...})`.
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
function handleHealth(_req, res) {
  // Build a fresh body literal on every invocation. The literal
  // syntax produces a new object reference per call, so concurrent
  // requests cannot share state via the body. The order of property
  // assembly is irrelevant for JSON serialization; we follow the
  // canonical fixture order (status, uptime, timestamp) for
  // readability.
  //
  // process.uptime() returns the number of seconds the Node.js
  // process has been running, as a high-resolution floating-point
  // number. This is a per-request read — caching at module load
  // would freeze the value at the first request and break
  // monotonicity assertions.
  //
  // new Date().toISOString() produces a UTC timestamp in canonical
  // ISO-8601 form (YYYY-MM-DDTHH:MM:SS.sssZ). The format is
  // unambiguous, parseable by every JavaScript Date constructor,
  // and matches the regex /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
  // asserted by the tests.
  const body = {
    status: HEALTH_STATUS_OK,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };

  // Send the response. res.status returns res for chaining, and
  // res.json serializes the body and sets Content-Type to
  // 'application/json; charset=utf-8'. The chain produces exactly
  // one HTTP frame with the canonical 200 + JSON shape.
  res.status(STATUS_OK).json(body);
}

/**
 * Register the health route on the provided Express app.
 *
 * Called by the app factory in `src/app.js` after the standard
 * middleware has been registered. The registrar pattern (a function
 * that takes the app and registers routes) keeps registration
 * order under the factory's control.
 *
 * The registrar uses `app.get('/health', handler)` (NOT `app.all`
 * or `app.use`) so non-GET methods on `/health` fall through to
 * the 404 handler per the documented contract.
 *
 * @param {import('express').Express} app The Express app instance
 *   to register the route on. The app must expose
 *   `.get(path, handler)`.
 * @returns {void}
 */
function applyRoutes(app) {
  app.get('/health', handleHealth);
}

module.exports = applyRoutes;
module.exports.applyRoutes = applyRoutes;
module.exports.handleHealth = handleHealth;
