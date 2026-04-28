'use strict';

/**
 * src/app.js
 *
 * Express application factory.
 *
 * The factory is the canonical entry point for every consumer that
 * needs an Express app instance:
 *
 *   - `src/server.js` calls `createApp()` once at process boot, then
 *     binds the returned app to a TCP socket via `app.listen(...)`.
 *   - `tests/helpers/buildApp.js` calls `createApp(overrides)` per
 *     test, then hands the returned app to Supertest's in-process
 *     injection. Tests NEVER call `app.listen()` per AAP 0.10.1.
 *
 * Why a factory (rather than a singleton-exported app)?
 *   - Each factory call returns an INDEPENDENT app instance with its
 *     own router stack and per-instance state. Tests can construct
 *     dozens of apps in parallel without cross-test interference.
 *   - The factory pattern decouples app construction from app
 *     execution. Construction is pure (no socket binding, no I/O);
 *     execution happens in `src/server.js` only.
 *   - Per AAP 0.10.1: "the only acceptable source change driven by
 *     testing is the `app.js`/`server.js` separation noted above."
 *     This file IS that separation.
 *
 * Middleware chain (left-to-right is dispatch order):
 *
 *   [requestLogger] ──▶ [GET /] ──▶ [GET /health] ──▶
 *     [override middleware*] ──▶ [override routes*] ──▶
 *     [notFoundHandler (404 fall-through)] ──▶
 *     [errorHandler (4-arg, catches throws)]
 *
 *   * Override middleware/routes are injected by tests via the
 *     `overrides` parameter. They are positioned AFTER the standard
 *     routes (so test-only routes can shadow specific paths if
 *     desired) and BEFORE the 404 handler (so test-only routes are
 *     reachable — registering them after the 404 handler would make
 *     them unreachable, since the 404 handler would intercept first).
 *
 * The error handler is registered LAST per Express's documented
 * convention. Express identifies error-handling middleware by its
 * arity (a function with `.length === 4`) and dispatches forwarded
 * errors to it. Placing it last guarantees it catches throws from
 * every preceding middleware/handler.
 *
 * Public surface contract (per AAP Sections 0.4.3, 0.5.1, and the
 * tests/unit/app.test.js suite):
 *
 *   - `createApp()` returns an Express app (a callable function).
 *   - The app exposes `.use`, `.get`, `.post`, `.put`, `.delete`,
 *     `.listen`, `.set`, `.all`, `.disable`, `.enable`, and the
 *     `request`/`response` prototype objects.
 *   - The app does NOT bind to a port at construction (no
 *     `.listen()` is called). `app.listening` is falsy.
 *   - `createApp()` is idempotent: each call returns a brand-new
 *     instance with no shared state.
 *   - `createApp(overrides)` accepts an optional object whose
 *     `middleware` and `routes` array properties are applied between
 *     standard routes and the 404 handler.
 *
 * Module export contract:
 *   The module's default export is the factory function itself,
 *   so consumers can call `require('./app')(...)` directly. The
 *   `createApp` named export is also attached for consumers that
 *   prefer the explicit destructured form
 *   (`const { createApp } = require('./app')`). Both exports are
 *   the SAME function reference — there is no duplication.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons,
 *     const-by-default, trailing commas in multiline literals
 *   - 'use strict' at the file head
 *
 * @module src/app
 * @see src/server.js (uses createApp at process boot)
 * @see tests/helpers/buildApp.js (uses createApp per test)
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
// Top-level requires are safe here because none of the imported modules
// have observable side effects at load time:
//   - express is a pure factory itself
//   - the middleware modules export pure functions (no I/O on load)
//   - the routes modules export pure registrars (no I/O on load)
// Lazy-requiring inside the factory body would only matter if a
// dependency had to be re-resolved per call, which is not the case
// here.

const express = require('express');

// Middleware. Each module exports a function (default export pattern):
//   - requestLogger: 3-arg middleware that logs each request
//   - notFoundHandler: 3-arg terminal middleware for unmatched routes
//   - errorHandler: 4-arg error-handling middleware (catches throws)
const requestLogger = require('./middleware/requestLogger');
const notFoundHandler = require('./middleware/notFoundHandler');
const errorHandler = require('./middleware/errorHandler');

// Route registrars. Each module's default export is a registrar
// function `applyRoutes(app)` that registers the route handlers on
// the supplied app instance. The routes modules use the triple-
// export pattern `module.exports = applyRoutes; module.exports.
// applyRoutes = applyRoutes; module.exports.handleX = handleX;`,
// so a plain `require()` returns the registrar function directly
// (the named exports are attached as function properties for
// consumers that prefer the destructured form).
const applyIndexRoutes = require('./routes/index');
const applyHealthRoutes = require('./routes/health');

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a fresh Express application instance.
 *
 * The factory is the cornerstone of the project's testable Express
 * setup: it constructs an unbound app (no `.listen()` call), wires
 * up the standard middleware/route chain, applies any test-supplied
 * overrides, and returns the result. The returned app is suitable
 * for both production execution (via `src/server.js`'s
 * `app.listen()`) and test execution (via Supertest's in-process
 * injection through `tests/helpers/buildApp.js`).
 *
 * Each invocation produces an INDEPENDENT app — Express's `express()`
 * call returns a brand-new app instance with its own router, settings,
 * and prototype objects. Tests can therefore construct as many apps
 * as needed in parallel without state leakage.
 *
 * The `overrides` parameter is the test-injection surface. It is a
 * plain object with two optional array properties:
 *
 *   `middleware`: Array<Function>
 *     Each function is a standard 3-arg Express middleware
 *     `(req, res, next)`. Each is registered via `app.use(mw)` AFTER
 *     the standard middleware and routes — so test-only middleware
 *     observes requests AFTER the request logger runs but BEFORE the
 *     404/error handlers run.
 *
 *   `routes`: Array<Function>
 *     Each function is a route registrar callback that receives the
 *     freshly built app and registers one or more custom routes. For
 *     example: `(a) => a.get('/__test__', handler)`. Registrars run
 *     AFTER the standard route registration and AFTER any override
 *     middleware — so test-only routes can override specific paths
 *     without affecting standard routes, and remain reachable BEFORE
 *     the 404 handler intercepts unmatched paths.
 *
 * Both override channels are optional. Passing no argument is
 * equivalent to passing `{}` — no overrides applied.
 *
 * @param {Object} [overrides={}] Optional test-only overrides.
 * @param {Function[]} [overrides.middleware] Array of 3-arg
 *   Express middleware functions. Each is registered via
 *   `app.use(mw)` after standard middleware.
 * @param {Function[]} [overrides.routes] Array of registrar
 *   functions. Each is invoked with the app to register routes.
 * @returns {import('express').Express} A fresh Express app
 *   instance with the standard middleware/route chain wired,
 *   plus any overrides applied.
 */
function createApp(overrides = {}) {
  // -------------------------------------------------------------------------
  // 1. Construct a fresh Express app instance
  // -------------------------------------------------------------------------
  // express() returns a brand-new app — it is itself a callable
  // function (the request handler that node's http.Server invokes
  // for each incoming request). The instance has its own router,
  // settings table, sub-app registry, and request/response prototypes.
  const app = express();

  // -------------------------------------------------------------------------
  // 2. Production hardening: disable the X-Powered-By header
  // -------------------------------------------------------------------------
  // Express advertises itself by default via `X-Powered-By: Express`.
  // Disabling this header is a standard production-hardening step —
  // it removes one piece of free reconnaissance information attackers
  // would otherwise have. The setting is harmless in development too;
  // we disable it unconditionally rather than gating on NODE_ENV.
  app.disable('x-powered-by');

  // -------------------------------------------------------------------------
  // 3. Standard middleware: request logging
  // -------------------------------------------------------------------------
  // The request logger runs FIRST in the middleware chain so every
  // incoming request — including those that would 404 or throw — is
  // observed and logged uniformly. Per
  // tests/unit/middleware/requestLogger.test.js, the logger is
  // resilient to logger-transport failures (silent swallow) so a
  // logging fault cannot break the request flow.
  app.use(requestLogger);

  // -------------------------------------------------------------------------
  // 4. Standard routes: GET / and GET /health
  // -------------------------------------------------------------------------
  // The applyRoutes registrar pattern keeps registration order under
  // the factory's control. Each registrar is a function that takes
  // the app and registers route handlers via app.get/app.post/etc.
  //
  // Registration order matters when paths could collide; here, '/' and
  // '/health' do not overlap, so the relative order is irrelevant.
  // The fixed order (index then health) is a stylistic choice that
  // mirrors the typical "root before sub-routes" reading order.
  applyIndexRoutes(app);
  applyHealthRoutes(app);

  // -------------------------------------------------------------------------
  // 5. Test-only override middleware
  // -------------------------------------------------------------------------
  // Override middleware is registered AFTER standard middleware/routes
  // so test-only behavior layers on top. The position is critical:
  //   - Before standard routes: tests could intercept standard routes
  //     (e.g., spy on every '/' request), which is not the intended
  //     test pattern.
  //   - After 404 handler: override middleware would be UNREACHABLE
  //     because the 404 handler terminates with a response.
  // Placing overrides between standard routes and the 404 handler
  // makes them reachable for both standard and test-only routes that
  // follow.
  //
  // `Array.isArray` (rather than truthiness) correctly rejects
  // strings, plain objects, and other accidentally truthy non-arrays
  // a `if (overrides.middleware)` test would erroneously accept.
  if (Array.isArray(overrides.middleware)) {
    overrides.middleware.forEach((mw) => {
      app.use(mw);
    });
  }

  // -------------------------------------------------------------------------
  // 6. Test-only override routes
  // -------------------------------------------------------------------------
  // Each registrar is a function that takes the app and registers
  // custom test-only routes. The registrar pattern (rather than a
  // direct array of {path, handler} pairs) keeps the factory agnostic
  // to specific HTTP methods and path shapes — each registrar owns
  // its own registration logic.
  //
  // CRITICAL POSITIONING: override routes are registered BEFORE the
  // 404 handler so they are reachable. Registering them after the 404
  // handler would silently break every integration test that injects
  // routes via buildApp({routes: [...]}).
  if (Array.isArray(overrides.routes)) {
    overrides.routes.forEach((registerFn) => {
      registerFn(app);
    });
  }

  // -------------------------------------------------------------------------
  // 7. Terminal middleware: 404 fall-through
  // -------------------------------------------------------------------------
  // Registered as the final 3-arg middleware. Catches every request
  // that no preceding handler claimed and produces a 404 JSON response
  // per src/middleware/notFoundHandler.js.
  //
  // Registered with `app.use(notFoundHandler)` (no path argument) so
  // it matches every method on every unmatched path. Using
  // `app.all('*', ...)` would behave equivalently in Express 4 but
  // Express 5's stricter path-matching could reject the bare `*`
  // wildcard; the `app.use` form is the canonical idiom.
  app.use(notFoundHandler);

  // -------------------------------------------------------------------------
  // 8. Terminal middleware: error handler (4-arg, registered LAST)
  // -------------------------------------------------------------------------
  // Express identifies error-handling middleware by its arity — a
  // function with `.length === 4` is dispatched ONLY when an upstream
  // handler calls `next(err)` or throws. Registering it LAST in the
  // chain ensures it catches errors propagated from every preceding
  // middleware and route handler.
  //
  // Express 5 (the project's pinned version) automatically forwards
  // rejected promises from async middleware/handlers to the error
  // chain — older Express versions required explicit `.catch(next)` or
  // `next(err)`. The error handler at src/middleware/errorHandler.js
  // converts the propagated error into a 500 (or err.statusCode) JSON
  // response, with stack-trace exposure gated on NODE_ENV.
  app.use(errorHandler);

  // -------------------------------------------------------------------------
  // 9. Return the fresh, unbound app
  // -------------------------------------------------------------------------
  // No `.listen()` call, no caching, no module-level shared state.
  // Each createApp() invocation produces an independent app instance
  // suitable for parallel test execution and arbitrary test ordering.
  return app;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
// Triple export pattern:
//   - Default export: the factory function itself, so
//     `require('./app')(overrides)` works.
//   - Named export: `createApp` attached to the function as a property,
//     so `require('./app').createApp(overrides)` works for consumers
//     that prefer the explicit form.
// Both exports are the SAME function reference — there is no duplicate
// implementation.
module.exports = createApp;
module.exports.createApp = createApp;
