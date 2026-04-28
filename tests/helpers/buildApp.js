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
 *   - tests/unit/routes/*.test.js (HTTP-level route tests)
 *   - tests/integration/*.test.js (full-chain integration tests
 *     that need test-only middleware or routes injected on top of
 *     the standard app build)
 *
 * Contract guarantees (per AAP Sections 0.5.2 and 0.10.1):
 *   - Returns a brand-new app instance per invocation — no shared
 *     state, no cached singletons — so tests can be parallelized and
 *     run in arbitrary order without interference.
 *   - NEVER calls `app.listen()` — the helper is strictly a builder.
 *     Callers are expected to pass the returned app to Supertest's
 *     in-process injection (per AAP 0.10.1: "Never call `app.listen()`
 *     from any test file").
 *   - Lazy-requires `src/app.js` INSIDE the function body so that any
 *     `jest.mock('../../../src/app', ...)` calls in test files take
 *     effect before resolution. This is the standard pattern for test
 *     helpers that consume mockable modules.
 *   - Robust to multiple plausible export styles in `src/app.js`
 *     (factory default export, named factory export, ES-module interop)
 *     so tests written against this helper remain stable as the
 *     broader Express enhancement evolves.
 *   - Override injection happens INSIDE the factory call (the factory
 *     receives `overrides` as a parameter), so override middleware and
 *     routes are registered BEFORE the 404 handler — making them
 *     reachable. Registering overrides AFTER the factory returns would
 *     place them AFTER the 404 handler in the middleware chain, where
 *     they would never run.
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
 * (`src/app.js`), invokes it with any caller-supplied overrides, and
 * returns the resulting app. The function is intentionally tolerant
 * of several plausible export shapes for `src/app.js` so tests
 * remain stable across the broader Express enhancement's chosen
 * export pattern.
 *
 * The returned app is NOT bound to any port; callers are expected
 * to pass it to Supertest (`request(app).get(...)`) or invoke its
 * methods directly. This helper will NEVER call `app.listen()`.
 *
 * Override injection is delegated to the factory — overrides are
 * passed as a parameter to the factory call, NOT applied
 * post-construction. This is the only correct ordering for two
 * reasons:
 *
 *   1. Reachability: the factory registers a 404 fall-through
 *      handler at the end of the middleware chain. Overrides
 *      applied AFTER `factory()` returns would be registered AFTER
 *      the 404 handler, where they would never run because the 404
 *      handler terminates with a response.
 *
 *   2. Composition: the factory determines the canonical chain
 *      order (request logger -> standard routes -> overrides ->
 *      404 -> error handler). Splicing overrides into the chain at
 *      the correct point requires factory cooperation; doing it
 *      from the helper would either duplicate the factory's logic
 *      or be unable to position overrides correctly.
 *
 * @param {Object} [overrides={}] Optional test-specific overrides
 *   forwarded verbatim to the factory.
 * @param {Function[]} [overrides.middleware] Array of Express
 *   middleware functions with the standard `(req, res, next)`
 *   signature. The factory registers each via `app.use(mw)` AFTER
 *   the standard middleware so the test-only behavior layers on top
 *   (and is observed last in the middleware chain).
 * @param {Function[]} [overrides.routes] Array of route registrar
 *   callbacks. The factory invokes each with the freshly built app
 *   so custom routes can be registered, e.g.
 *   `(app) => app.get('/__test__', handler)`. Registrars run AFTER
 *   the factory's standard route registration but BEFORE the 404
 *   handler.
 * @returns {Function} A fresh Express app callable, ready for
 *   Supertest in-process injection. Not bound to any port.
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
  // Resolve a fresh Express app instance via the factory
  // ---------------------------------------------------------------------
  // The broader Express enhancement may use any of several plausible
  // factory export shapes. Supporting all of them here means tests
  // written against this helper remain stable regardless of the chosen
  // pattern. Resolution order is intentional — most-specific (callable
  // module) checked first, ES-module interop fallback last.
  //
  //   Style A: module.exports = createApp;
  //            (factory default — call appModule(overrides) directly)
  //   Style B: module.exports = { createApp };
  //            (named factory export — call
  //             appModule.createApp(overrides))
  //   Style C: module.exports = { default: createApp };
  //            (ES-module interop fallback — call
  //             appModule.default(overrides); unlikely given the project
  //             is CommonJS, but defensive against future
  //             bundler-emitted shapes)
  //   Style D: module.exports = app;  (singleton — defensive only;
  //            does not satisfy the fresh-per-call guarantee, but
  //            preserves test functionality if `src/app.js` is
  //            restructured to a singleton-style export. Overrides are
  //            ignored in this case because there is no factory to
  //            forward them to.)
  //
  // CRITICAL: each branch passes `overrides` to the factory call so the
  // factory can register override middleware/routes BEFORE the 404
  // handler, keeping them reachable. Applying overrides
  // post-construction (after the factory returns) would register them
  // AFTER the 404 handler, where they would never run.
  let app;
  if (typeof appModule === 'function') {
    app = appModule(overrides);
  } else if (appModule && typeof appModule.createApp === 'function') {
    app = appModule.createApp(overrides);
  } else if (appModule && typeof appModule.default === 'function') {
    app = appModule.default(overrides);
  } else {
    // Singleton fallback — overrides cannot be honored because there is
    // no factory to forward them to. We still return the app so tests
    // that DON'T use overrides continue to work.
    app = appModule;
  }

  // ---------------------------------------------------------------------
  // Return the fresh, unbound app
  // ---------------------------------------------------------------------
  // No `app.listen()` call, no caching, no module-level shared state.
  // Each `buildApp()` invocation produces an independent app instance
  // suitable for parallel test execution and arbitrary test ordering.
  // Override injection has already been performed inside the factory.
  return app;
}

module.exports = { buildApp };
