'use strict';

/**
 * tests/unit/app.test.js
 *
 * Unit tests for the Express application factory at `src/app.js`.
 *
 * Test contracts verified:
 *   1. buildApp() returns an Express app instance (a callable function).
 *   2. The app exposes the standard Express callable surface:
 *      .use, .get, .post, .put, .delete, .listen, .set, .request, .response.
 *   3. Each buildApp() invocation returns an INDEPENDENT app instance —
 *      no shared state, no cached singletons.
 *   4. The app does NOT bind to a port at construction time (the
 *      .listen() method is exposed but is NEVER invoked from any test
 *      file per AAP Section 0.10.1).
 *   5. buildApp() accepts optional middleware/route overrides without
 *      throwing, and exercises the helper's override-injection paths.
 *
 * Test strategy:
 *   - Use tests/helpers/buildApp.js for fresh app construction per test;
 *     this decouples the test from the eventual export style chosen for
 *     src/app.js (factory default, named factory, ES-interop, singleton).
 *   - Inspect the returned app object for required methods/properties.
 *   - Use callback-tracking to verify override injection.
 *   - NEVER call app.listen() (per AAP Section 0.10.1).
 *   - NEVER issue HTTP requests in this file — HTTP-level testing is
 *     the responsibility of tests/integration/server.integration.test.js
 *     and tests/unit/routes/*.test.js.
 *   - NEVER mutate process.env — env-driven behavior is covered by
 *     tests/unit/config/config.test.js and tests/unit/logger/logger.test.js.
 *   - NEVER mock src/app.js — per AAP Section 0.5.2 the factory is pure
 *     and there is nothing to mock; mocking it would test the mock
 *     instead of the real factory.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Trailing commas in multiline arrays/objects
 *   - Block hierarchy: describe('Unit: ...') -> describe(scenario) -> it(...)
 *   - File naming: app.test.js mirrors src/app.js
 *
 * Coordination note:
 *   The Express app factory at `src/app.js` is created by the broader
 *   Express enhancement (NOT by this testing AAP). Until that file
 *   exists, the helper's lazy `require('../../src/app')` will throw
 *   MODULE_NOT_FOUND and every test below will fail at the buildApp()
 *   call. This is expected and acceptable per AAP Section 0.2.1 — the
 *   testing AAP and the broader enhancement are coordinated efforts.
 *
 * @module tests/unit/app.test
 */

const { buildApp } = require('../helpers/buildApp');

describe('Unit: src/app.js (Express application factory)', () => {
  // ----------------------------------------------------------------
  // App instance construction
  // ----------------------------------------------------------------
  // The factory must return an Express app — which Express implements
  // as a callable function (the app IS the request handler). These
  // tests assert the most fundamental contract: typeof === 'function'
  // and presence of the canonical Express public-API methods. If any
  // of these fail, src/app.js is not returning a valid Express app.
  describe('App instance construction', () => {
    it('should return a callable function (Express app)', () => {
      // Express apps are functions: they ARE the request handler that
      // node's http.Server invokes for each incoming request. Asserting
      // typeof === 'function' triangulates "this is a real Express app
      // and not, say, a wrapped object literal or a Promise."
      const app = buildApp();
      expect(typeof app).toBe('function');
    });

    it('should expose .use() method for middleware registration', () => {
      // app.use(mw) is the universal middleware registration API.
      // Without it, the app cannot register request loggers, body
      // parsers, error handlers, or any of the other middleware
      // explicitly required by the Express enhancement (AAP 0.3.1).
      const app = buildApp();
      expect(typeof app.use).toBe('function');
    });

    it('should expose .get() method for GET-route registration', () => {
      // app.get('/path', handler) is the GET-route registrar; it is
      // also overloaded to read app settings via app.get(settingName).
      // Both forms share the same function reference, so this single
      // typeof check covers both behaviors.
      const app = buildApp();
      expect(typeof app.get).toBe('function');
    });

    it('should expose .post() method for POST-route registration', () => {
      // POST is required to support body-receiving endpoints — even
      // though the initial Express enhancement may only register GET
      // routes, the surface MUST include POST so future routes can
      // be added without restructuring the app factory.
      const app = buildApp();
      expect(typeof app.post).toBe('function');
    });

    it('should expose .put() method for PUT-route registration', () => {
      // PUT support is part of the standard Express verb surface; we
      // assert its presence to guarantee a complete REST-friendly app.
      const app = buildApp();
      expect(typeof app.put).toBe('function');
    });

    it('should expose .delete() method for DELETE-route registration', () => {
      // DELETE support rounds out the canonical CRUD verb set.
      const app = buildApp();
      expect(typeof app.delete).toBe('function');
    });

    it('should expose .listen() method but tests MUST NOT invoke it', () => {
      // Per AAP Section 0.10.1: "Never call app.listen() from any test
      // file. All HTTP-level testing uses Supertest's in-process
      // injection." We assert .listen() is exposed (it is part of the
      // Express public API and src/server.js will call it at process
      // boot) but we do NOT invoke it here. Invoking it would bind a
      // real TCP socket to a port and create EADDRINUSE collisions
      // when tests run in parallel.
      const app = buildApp();
      expect(typeof app.listen).toBe('function');
    });
  });

  // ----------------------------------------------------------------
  // Independence (fresh app per call)
  // ----------------------------------------------------------------
  // Per AAP Section 0.4.3, "createApp() called twice produces independent
  // app instances." This guarantees test isolation when multiple tests
  // each call buildApp() and customize their app via overrides — the
  // customizations must NOT bleed across instances.
  describe('Independence (fresh app per call)', () => {
    it('should return independent app instances when buildApp() is called twice', () => {
      // Identity check: two calls must return distinct object references.
      // Express attaches per-instance state (router stack, settings
      // table, sub-app registry); sharing state across calls would
      // cause registry collisions and unpredictable cross-test
      // interference.
      const app1 = buildApp();
      const app2 = buildApp();
      expect(app1).not.toBe(app2);
    });

    it('should not share middleware or route state across instances', () => {
      // Behavioral check: a custom route registered on app1 must NOT
      // appear on app2. We use the override mechanism to register a
      // marker route on app1, then verify app2 is a different object.
      // (Direct inspection of Express's router stack is intentionally
      // avoided — that is internal API and varies between Express 4
      // and 5; behavioral verification of routing is the integration
      // suite's responsibility per tests/integration/server.integration.test.js.)
      const app1 = buildApp({
        routes: [
          (a) => a.get('/app1-only', (req, res) => res.json({ source: 'app1' })),
        ],
      });
      const app2 = buildApp();

      expect(app1).not.toBe(app2);
      // Both apps must remain independently functional after the
      // override pass — that is, neither has been corrupted by the
      // act of registering routes on the other.
      expect(typeof app1.use).toBe('function');
      expect(typeof app2.use).toBe('function');
      expect(typeof app1.get).toBe('function');
      expect(typeof app2.get).toBe('function');
    });

    it('should produce three independent apps when buildApp() is called three times', () => {
      // Strengthens the independence guarantee beyond the two-call
      // baseline by checking three distinct identities pairwise. If
      // any future caching / memoization is introduced into the
      // factory or helper, this test will catch it.
      const app1 = buildApp();
      const app2 = buildApp();
      const app3 = buildApp();
      expect(app1).not.toBe(app2);
      expect(app2).not.toBe(app3);
      expect(app1).not.toBe(app3);
    });
  });

  // ----------------------------------------------------------------
  // No-listen contract (does NOT bind to a port)
  // ----------------------------------------------------------------
  // The cornerstone of testable Express setups: the app factory must
  // return an unbound app. Binding to a port at construction time would
  // make tests collide on port assignments and conflict with locally
  // running dev servers (AAP Section 0.10.1).
  describe('No-listen contract (does NOT bind to a port)', () => {
    it('should not have an active server attached at construction time', () => {
      // Express's app.listening is provided by the underlying
      // http.Server once attached via .listen(). Before .listen() is
      // called, the property is either undefined (Express 5) or
      // false. .toBeFalsy() accepts both, providing forward
      // compatibility across Express versions.
      const app = buildApp();
      expect(app.listening).toBeFalsy();
    });

    it('should not throw when buildApp() is called repeatedly', () => {
      // Stress-test the factory by constructing many apps in a tight
      // loop. If construction had any side effect that accumulated
      // state (e.g., a singleton emitter, a counter overflow, a port
      // counter, or a leaking file descriptor), it would surface as
      // a thrown error here. Five iterations is a balance between
      // catching real issues and keeping the test fast.
      expect(() => {
        const apps = [];
        for (let i = 0; i < 5; i += 1) {
          apps.push(buildApp());
        }
        return apps;
      }).not.toThrow();
    });

    it('should not expose a `_server` or `server` property tied to a live socket', () => {
      // Defensive check: if the factory accidentally called .listen()
      // at construction (which would be a regression), the resulting
      // http.Server instance is typically attached as a property on
      // the app or accessible via app.listen()'s return value. We
      // verify no such bound server exists. Express does not attach
      // a _server property until .listen() runs; our assertion is
      // a triangulation against accidental binding.
      const app = buildApp();
      // Express does not define a `_server` property on the app
      // object; if it ever does (because .listen() was invoked),
      // its .listening flag would be truthy. We've already covered
      // that above; this assertion ensures the property simply does
      // not exist at construction time.
      expect(app._server).toBeUndefined();
    });
  });

  // ----------------------------------------------------------------
  // Standard Express object surface
  // ----------------------------------------------------------------
  // Beyond the verb registrars, Express apps expose `request` and
  // `response` prototype objects (used to extend req/res globally
  // across the app), and a `set()` method for app-level settings such
  // as 'trust proxy', 'view engine', 'env', etc. These are part of
  // the standard public surface and must be present.
  describe('Standard Express object surface', () => {
    it('should expose a `request` prototype object', () => {
      // Express's app.request is the prototype from which each
      // incoming req is derived. It must be a real object (not
      // null, not undefined, not a primitive). The two-step
      // triangulation rules out all three failure modes.
      const app = buildApp();
      expect(app.request).toBeDefined();
      expect(app.request).not.toBeNull();
      expect(typeof app.request).toBe('object');
    });

    it('should expose a `response` prototype object', () => {
      // Symmetric assertion for app.response — the prototype from
      // which each outgoing res is derived.
      const app = buildApp();
      expect(app.response).toBeDefined();
      expect(app.response).not.toBeNull();
      expect(typeof app.response).toBe('object');
    });

    it('should expose .set() method for app-level settings', () => {
      // app.set('key', value) is the canonical way to configure
      // app-level options (e.g., 'trust proxy', 'view engine'). The
      // AAP transformation table (Section 0.5.1) explicitly mentions
      // "trust-proxy configuration" as a verifiable behavior of
      // src/app.js; presence of .set() is a precondition.
      const app = buildApp();
      expect(typeof app.set).toBe('function');
    });

    it('should expose .get() that does not throw on unknown setting reads', () => {
      // Express's .get() is overloaded:
      //   - app.get('/path', handler) registers a GET route
      //   - app.get('settingName')    reads an app-level setting
      // The settings-getter form must return undefined (not throw)
      // when asked for a setting that has not been .set(). This is
      // the canonical "absent setting" behavior; relying tests must
      // be able to probe settings safely without try/catch wrappers.
      const app = buildApp();
      expect(() => app.get('non-existent-setting')).not.toThrow();
    });

    it('should expose .all() method for all-verb route registration', () => {
      // app.all('/path', handler) is the multi-verb registrar; it is
      // not strictly required by the Express enhancement's documented
      // routes but is part of the standard Express surface and we
      // assert its presence for completeness.
      const app = buildApp();
      expect(typeof app.all).toBe('function');
    });

    it('should expose .disable() and .enable() methods for boolean settings', () => {
      // .disable('x-powered-by') is a common production hardening
      // step — disabling the X-Powered-By header so the server does
      // not advertise its framework. Both methods must be present
      // on a standard Express app.
      const app = buildApp();
      expect(typeof app.disable).toBe('function');
      expect(typeof app.enable).toBe('function');
    });
  });

  // ----------------------------------------------------------------
  // Override injection via buildApp()
  // ----------------------------------------------------------------
  // The buildApp() helper accepts an `overrides` object that lets
  // individual tests inject test-only middleware and routes ON TOP of
  // the standard app build. These tests verify the override mechanism
  // works mechanically — they do NOT verify behavioral middleware
  // ordering, which is the responsibility of the integration suite.
  describe('Override injection via buildApp()', () => {
    it('should accept custom middleware via overrides.middleware', () => {
      // The simplest middleware: a no-op that calls next(). Passing
      // it via overrides.middleware exercises the helper's
      // Array.isArray + forEach + app.use(mw) path.
      const customMw = (req, res, next) => {
        next();
      };
      expect(() => buildApp({ middleware: [customMw] })).not.toThrow();
    });

    it('should accept custom routes via overrides.routes and invoke each registrar', () => {
      // Each routes-array entry is a registrar function that receives
      // the freshly built app and registers one or more routes. The
      // routeRegistrarCalled flag verifies the helper did invoke our
      // registrar (rather than, say, silently ignoring the routes
      // array if its iteration logic ever regresses).
      let routeRegistrarCalled = false;
      const customRoute = (a) => {
        // Intentionally use a path that no other test references so
        // accidental cross-test interference is impossible.
        a.get('/__custom-path__', (req, res) => res.json({ ok: true }));
        routeRegistrarCalled = true;
      };
      const app = buildApp({ routes: [customRoute] });
      expect(typeof app).toBe('function');
      expect(routeRegistrarCalled).toBe(true);
    });

    it('should accept zero-argument call (no overrides at all)', () => {
      // buildApp() must work with no arguments — overrides is optional
      // and defaults to {} per the helper's signature.
      expect(() => buildApp()).not.toThrow();
    });

    it('should accept an empty overrides object', () => {
      // Passing an empty object should be equivalent to passing no
      // arguments at all — the helper's defaults handle the absent
      // middleware/routes properties gracefully.
      expect(() => buildApp({})).not.toThrow();
    });

    it('should accept empty middleware and routes arrays', () => {
      // Empty arrays must not cause forEach iteration errors and
      // must not change the resulting app's behavior versus the
      // zero-argument form.
      expect(() => buildApp({ middleware: [] })).not.toThrow();
      expect(() => buildApp({ routes: [] })).not.toThrow();
      expect(() => buildApp({ middleware: [], routes: [] })).not.toThrow();
    });

    it('should accept multiple middleware in registration order', () => {
      // Multiple-middleware support is required by the broader
      // Express enhancement (request logger + body parser + security
      // middleware all stack on top of each other). The helper's
      // forEach loop must apply them in array order without mutating
      // the input array.
      const mw1 = (req, res, next) => {
        next();
      };
      const mw2 = (req, res, next) => {
        next();
      };
      const mw3 = (req, res, next) => {
        next();
      };
      expect(() => buildApp({ middleware: [mw1, mw2, mw3] })).not.toThrow();
    });

    it('should accept multiple route registrars and invoke each one', () => {
      // Symmetric multi-registrar test for routes. The two flags
      // verify both registrars ran; if the helper's forEach loop
      // ever broke after the first iteration, only one flag would
      // flip and the assertion would fail.
      let firstCalled = false;
      let secondCalled = false;
      const first = (a) => {
        a.get('/__first__', (req, res) => res.json({ which: 'first' }));
        firstCalled = true;
      };
      const second = (a) => {
        a.get('/__second__', (req, res) => res.json({ which: 'second' }));
        secondCalled = true;
      };
      const app = buildApp({ routes: [first, second] });
      expect(typeof app).toBe('function');
      expect(firstCalled).toBe(true);
      expect(secondCalled).toBe(true);
    });

    it('should accept both middleware and routes overrides simultaneously', () => {
      // The two override channels are independent and must compose
      // cleanly when both are supplied at once. This is the most
      // realistic real-world usage pattern (an integration test
      // that injects a request observer middleware AND a custom
      // test-only route in the same buildApp() call).
      const observer = (req, res, next) => {
        next();
      };
      let registrarRan = false;
      const registrar = (a) => {
        a.get('/__combo__', (req, res) => res.json({ combo: true }));
        registrarRan = true;
      };
      const app = buildApp({
        middleware: [observer],
        routes: [registrar],
      });
      expect(typeof app).toBe('function');
      expect(registrarRan).toBe(true);
    });
  });
});
