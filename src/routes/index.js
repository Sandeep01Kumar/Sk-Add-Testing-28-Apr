'use strict';

/**
 * src/routes/index.js
 *
 * Express root route — registers the GET / handler that preserves
 * the legacy 14-line server.js byte-for-byte response.
 *
 * Backward-compatibility contract:
 *   The legacy server.js used `res.end('Hello, World!\n')` which
 *   sent EXACTLY 14 bytes including the trailing newline. The
 *   Express enhancement MUST preserve this byte sequence verbatim,
 *   because clients that depend on line-buffered I/O (curl | xargs,
 *   log shippers that split on \n, scripts that pipe the response
 *   through `read line`) would otherwise break.
 *
 * Behavior contract (per AAP Section 0.4.3 and the
 * tests/unit/routes/index.test.js test suite):
 *
 *   Route registration
 *     - Registered as `GET /` only — non-GET methods (POST, PUT,
 *       DELETE, PATCH) on `/` fall through to the 404 handler. This
 *       is the default Express behavior; no method-not-allowed
 *       middleware is added.
 *     - Express handles HEAD automatically: HEAD / receives the same
 *       status and headers as GET / but the body is stripped per
 *       RFC 7231 §4.3.2.
 *
 *   Response shape
 *     - Status: 200 (OK)
 *     - Content-Type: text/plain (with optional charset suffix —
 *       Express's default for `res.send(string)` is
 *       'text/html; charset=utf-8', so we explicitly set the type
 *       to 'text/plain' to match the canonical helloWorldPayload).
 *     - Body: 'Hello, World!\n' (14 bytes, INCLUDING the trailing
 *       newline). The trailing newline is part of the contract; the
 *       test asserts both the exact body string and that the body
 *       ends with '\n'.
 *
 *   Idempotency
 *     - Pure function — no module-level state, no per-request
 *       caching. Repeated GETs produce identical responses.
 *
 *   Content negotiation
 *     - The legacy server did not perform content negotiation: every
 *       request received plain text regardless of the Accept header.
 *       This route preserves that behavior — Accept: application/json
 *       still receives plain text. Tests pin this explicitly so a
 *       future content-negotiation refactor would fail loudly and
 *       force a deliberate decision rather than silent
 *       backward-incompatibility.
 *
 *   Query strings
 *     - Express's path matching ignores query strings; GET /?foo=bar
 *       receives the same body as GET /. The tests verify this.
 *
 * Module export contract:
 *   - Exports an `applyRoutes(app)` registrar function as the
 *     default export. The factory in `src/app.js` invokes
 *     `applyRoutes(app)` to register the route on the app instance.
 *     This pattern (a registrar that mutates the passed app) is
 *     consistent with `src/routes/health.js` and lets the app
 *     factory control the registration order without exposing
 *     individual handler implementations.
 *
 * Path resolution:
 *   - The root path `/` is the only path this module registers; no
 *     base path or prefix is applied. The route is mounted directly
 *     on the app via `app.get('/', handler)`.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons,
 *     const-by-default
 *   - Trailing commas in multiline literals
 *   - 'use strict' at the file head
 *
 * @module src/routes/index
 */

// ---------------------------------------------------------------------------
// Constants — canonical response values held in named constants so future
// refactors (i18n, body-format changes) update one source of truth.
// ---------------------------------------------------------------------------

/**
 * The canonical response body for GET /. Preserves the legacy
 * server.js's `res.end('Hello, World!\n')` output verbatim, including
 * the trailing newline.
 *
 * The trailing newline is INTENTIONAL and part of the
 * backward-compatibility contract per AAP Section 0.4.3 and the
 * canonical helloWorldPayload fixture.
 *
 * @type {string}
 */
const HELLO_WORLD_BODY = 'Hello, World!\n';

/**
 * The canonical Content-Type for GET /. Set to 'text/plain' to match
 * the legacy server.js behavior. Express's default for
 * `res.send(string)` is 'text/html'; we override via res.type or
 * res.set('Content-Type', ...) to force plain text.
 *
 * @type {string}
 */
const CONTENT_TYPE_TEXT_PLAIN = 'text/plain';

/**
 * The canonical HTTP status code for GET /. Matches the legacy
 * server.js's implicit 200 OK behavior.
 *
 * @type {number}
 */
const STATUS_OK = 200;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Express handler for GET /.
 *
 * Sends the legacy 'Hello, World!\n' body with HTTP 200 and
 * Content-Type 'text/plain'. The function is synchronous and does
 * NOT call next() — the response is terminal.
 *
 * The unused `_req` parameter is kept (rather than omitted) so the
 * function maintains Express's documented `(req, res, next?)`
 * signature for handler arity. The underscore prefix signals
 * intentional non-use to readers and linters.
 *
 * @param {import('express').Request} _req The Express request
 *   object. Not consumed by this handler — the route is independent
 *   of request data.
 * @param {import('express').Response} res The Express response
 *   object. The handler calls
 *   `res.status(200).type('text/plain').send('Hello, World!\n')`.
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
function handleRoot(_req, res) {
  // Set the status, content-type, and body in a single chained
  // expression. Express's res.status returns res, res.type returns
  // res, and res.send writes the body and ends the response. The
  // chain produces exactly one HTTP response with the canonical
  // shape.
  //
  // res.type('text/plain') overrides Express's default 'text/html'
  // for string bodies. Without this call, the response would have
  // Content-Type 'text/html; charset=utf-8' which would fail the
  // tests that match against /text\/plain/i.
  //
  // res.send(HELLO_WORLD_BODY) writes the EXACT 14-byte body
  // including the trailing newline. Using res.send(string) (rather
  // than res.json or res.end) preserves the byte sequence and lets
  // Express handle Content-Length and Transfer-Encoding correctly.
  res
    .status(STATUS_OK)
    .type(CONTENT_TYPE_TEXT_PLAIN)
    .send(HELLO_WORLD_BODY);
}

/**
 * Register the root route on the provided Express app.
 *
 * Called by the app factory in `src/app.js` after the standard
 * middleware has been registered. The registrar pattern (a function
 * that takes the app and registers routes) keeps the registration
 * order under the factory's control — the factory can register the
 * 404 handler AFTER all route registrars, ensuring unmatched paths
 * fall through correctly.
 *
 * The registrar uses `app.get('/', handler)` (NOT `app.all('/')` or
 * `app.use('/')`) so non-GET methods on `/` fall through to the 404
 * handler per the documented contract. A common mis-registration is
 * `app.all('/')` (which would silently accept POST/PUT/DELETE/PATCH
 * with the GET response); using app.get explicitly avoids that
 * regression.
 *
 * @param {import('express').Express} app The Express app instance to
 *   register the route on. The app must expose `.get(path, handler)`.
 * @returns {void}
 */
function applyRoutes(app) {
  app.get('/', handleRoot);
}

module.exports = applyRoutes;
module.exports.applyRoutes = applyRoutes;
module.exports.handleRoot = handleRoot;
