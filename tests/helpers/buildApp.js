'use strict';

/**
 * tests/helpers/buildApp.js
 *
 * Express app construction helper for tests.
 *
 * Wraps `src/app.js`'s Express factory with optional test-specific
 * middleware/route overrides, returning a fresh, unbound Express app
 * instance per call.
 *
 * Used by:
 *   - tests/unit/app.test.js (testing the factory itself)
 *   - selected tests/integration/*.test.js files (custom wiring
 *     scenarios that need test-only middleware or routes injected on
 *     top of the standard app build)
 *
 * Contract guarantees (per AAP Sections 0.5.2 and 0.10.1):
 *   - Returns a brand-new app instance per invocation — no shared state,
 *     no cached singletons — so tests can be parallelized and run in
 *     arbitrary order without interference.
 *   - NEVER calls `app.listen()` — the helper is strictly a builder.
 *     Callers are expected to pass the returned app to Supertest's
 *     in-process injection (per AAP 0.10.1: "Never call `app.listen()`
 *     from any test file").
 *   - Lazy-requires `src/app.js` INSIDE the function body so that any
 *     `jest.mock('../../../src/app', ...)` calls in test files take
 *     effect before resolution. This is the standard pattern for test
 *     helpers that consume mockable modules.
 *   - Robust to multiple plausible export styles in `src/app.js`
 *     (factory default export, named factory export, ES-module interop,
 *     singleton export) so tests written against this helper remain
 *     stable as the broader Express enhancement evolves.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS `require()`/`module.exports`
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline arrays/objects
 *   - Idempotent and stateless — each call returns a brand-new app
 *
 * Usage:
 *   const request = require('supertest');
 *   const { buildApp } = require('../../helpers/buildApp');
 *
 *   // Plain build — the standard, fully-wired Express app.
 *   it('responds with 200 on /', async () => {
 *     const app = buildApp();
 *     await request(app).get('/').expect(200);
 *   });
 *
 *   // Build with test-only middleware injected.
 *   it('observes each request via custom middleware', async () => {
 *     const seen = [];
 *     const recorder = (req, res, next) => { seen.push(req.path); next(); };
 *     const app = buildApp({ middleware: [recorder] });
 *     await request(app).get('/health').expect(200);
 *     expect(seen).toContain('/health');
 *   });
 *
 *   // Build with test-only routes registered.
 *   it('exposes a custom test route', async () => {
 *     const app = buildApp({
 *       routes: [(a) => a.get('/__test__', (req, res) => res.json({ ok: true }))],
 *     });
 *     await request(app).get('/__test__').expect(200, { ok: true });
 *   });
 *
 * @module tests/helpers/buildApp
 */

/**
 * Build a fresh, unbound Express app instance for testing.
 *
 * Each invocation lazily resolves the project's Express app factory
 * (`src/app.js`), produces a new app instance, applies any test-only
 * middleware/route overrides supplied by the caller, and returns the
 * result. The function is intentionally tolerant of several plausible
 * export shapes for `src/app.js` so tests remain stable across the
 * broader Express enhancement's chosen export pattern.
 *
 * The returned app is NOT bound to any port; callers are expected to
 * pass it to Supertest (`request(app).get(...)`) or invoke its methods
 * directly. This helper will NEVER call `app.listen()`.
 *
 * @param {Object} [overrides={}] Optional test-specific overrides.
 * @param {Function[]} [overrides.middleware] Array of Express middleware
 *   functions with the standard `(req, res, next)` signature. Each is
 *   registered on the app via `app.use(mw)` in array order, AFTER the
 *   factory's standard middleware so the test-only behavior layers on
 *   top (and is observed last in the middleware chain).
 * @param {Function[]} [overrides.routes] Array of route registrar
 *   callbacks. Each function is invoked with the freshly built app so
 *   custom routes can be registered, e.g.
 *   `(app) => app.get('/__test__', handler)`. Registrars run AFTER the
 *   factory's standard route registration; callers wishing to verify
 *   404 fall-through or error-handler ordering should account for that.
 * @returns {Function} A fresh Express app callable, ready for Supertest
 *   in-process injection. Not bound to any port.
 */
function buildApp(overrides = {}) {
  // ---------------------------------------------------------------------
  // Lazy-require `src/app.js`
  // ---------------------------------------------------------------------
  // Requiring INSIDE the function body (rather than at module top-level)
  // ensures any `jest.mock('../../../src/app', ...)` calls in test files
  // are honored — the mock registration is applied before this require()
  // executes at test runtime.
  //
  // Path resolution: from `tests/helpers/buildApp.js` up two levels
  // (`helpers` -> `tests` -> repo root), then down into `src/app.js`.
  // eslint-disable-next-line global-require
  const appModule = require('../../src/app');

  // ---------------------------------------------------------------------
  // Resolve a fresh Express app instance regardless of export style
  // ---------------------------------------------------------------------
  // The broader Express enhancement may use any of several plausible
  // export shapes for `src/app.js`. Supporting all of them here means
  // tests written against this helper remain stable regardless of the
  // chosen pattern. Resolution order is intentional — most-specific
  // (factory functions) checked before least-specific (singleton).
  //
  //   Style A: module.exports = createApp;
  //            (factory default — call appModule() directly)
  //   Style B: module.exports = { createApp };
  //            (named factory export — call appModule.createApp())
  //   Style C: module.exports = { default: createApp };
  //            (ES-module interop fallback — call appModule.default();
  //             unlikely given the project is CommonJS, but defensive
  //             against future bundler-emitted shapes)
  //   Style D: module.exports = app;
  //            (singleton fallback — defensive only; does not satisfy
  //             the fresh-per-call guarantee, but preserves test
  //             functionality if `src/app.js` is restructured to a
  //             singleton-style export.)
  //
  // `let` (not `const`) is required here because the binding is assigned
  // in any one of four mutually exclusive branches.
  let app;
  if (typeof appModule === 'function') {
    app = appModule();
  } else if (appModule && typeof appModule.createApp === 'function') {
    app = appModule.createApp();
  } else if (appModule && typeof appModule.default === 'function') {
    app = appModule.default();
  } else {
    app = appModule;
  }

  // ---------------------------------------------------------------------
  // Apply optional middleware overrides
  // ---------------------------------------------------------------------
  // `Array.isArray` (rather than a truthy check) correctly rejects
  // strings, objects, and other accidental truthy non-array values that
  // a `if (overrides.middleware)` test would erroneously accept.
  //
  // Arrow-function wrapping is intentional — passing `app.use` as the
  // direct iteratee (`forEach(app.use)`) would lose the `this` binding
  // and is brittle across Express versions and prototypes.
  if (Array.isArray(overrides.middleware)) {
    overrides.middleware.forEach((mw) => {
      app.use(mw);
    });
  }

  // ---------------------------------------------------------------------
  // Apply optional route registrars
  // ---------------------------------------------------------------------
  // Each registrar is a function that receives the app and may register
  // custom routes:
  //
  //   (app) => app.get('/__test__', (req, res) => res.json({ ok: true }))
  //
  // This pattern keeps the helper agnostic to specific HTTP methods and
  // path shapes — each registrar owns its own registration logic and
  // can register multiple routes per registrar if desired.
  if (Array.isArray(overrides.routes)) {
    overrides.routes.forEach((registerFn) => {
      registerFn(app);
    });
  }

  // ---------------------------------------------------------------------
  // Return the fresh, unbound app
  // ---------------------------------------------------------------------
  // No `app.listen()` call, no caching, no module-level shared state.
  // Each `buildApp()` invocation produces an independent app instance
  // suitable for parallel test execution and arbitrary test ordering.
  return app;
}

module.exports = { buildApp };
