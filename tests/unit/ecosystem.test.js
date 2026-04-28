'use strict';

/**
 * tests/unit/ecosystem.test.js
 *
 * Unit tests for the PM2 process-manager configuration file
 * `ecosystem.config.js` at the repository root.
 *
 * Test strategy:
 *   - require() the ecosystem config as a plain CommonJS module
 *   - Assert the exported object's structural shape
 *   - Verify each app's required fields, value types, and value ranges
 *   - NEVER invoke the PM2 binary, the PM2 daemon, or any real process
 *
 * Test groups:
 *   - Module load          : require() succeeds, exports non-null object,
 *                            parse time < 50ms
 *   - Top-level shape      : `apps` is an array with at least one entry
 *   - Per-app required     : each app has name, script, instances,
 *     fields                 exec_mode, env, env_production
 *   - Environment          : env_production.NODE_ENV === 'production';
 *     overrides              env.NODE_ENV is a string if defined
 *
 * Conventions (per AAP 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons, const-by-default
 *   - Block hierarchy: describe('Unit: ...') -> describe(scenario) -> it(...)
 *   - File naming: ecosystem.test.js mirrors ecosystem.config.js
 *
 * Coordination note:
 *   `ecosystem.config.js` is created by the broader Express enhancement at
 *   the repository root. Until that file exists, this test will fail at
 *   the require() step with MODULE_NOT_FOUND. This is expected per AAP
 *   Section 0.2.1 — the testing AAP and the broader enhancement are
 *   coordinated efforts. Once the ecosystem manifest exists, every test
 *   below validates its shape and value correctness.
 *
 * @module tests/unit/ecosystem.test
 */

// Direct require() at module load is the canonical pattern. The
// ecosystem.config.js file is plain CommonJS with no external dependencies,
// no I/O, and no side effects, so no jest.mock() or beforeEach setup is
// needed. If the require() throws (e.g., the file is missing or has a
// syntax error), the test file fails to load and Jest reports a clear
// MODULE_NOT_FOUND or SyntaxError diagnostic — exactly the canary behavior
// we want for the PM2 manifest contract.
const ecosystemConfig = require('../../ecosystem.config');

describe('Unit: ecosystem.config.js (PM2 manifest)', () => {
  // ----------------------------------------------------------------
  // Module load
  // ----------------------------------------------------------------
  // Verify the file can be located and parsed by Node's CommonJS loader,
  // exports a non-null object, and parses within the AAP-defined performance
  // boundary (< 50ms). These assertions cover the "happy path" and "error
  // case" categories from AAP Section 0.4.3.
  describe('Module load', () => {
    it('should require() without throwing', () => {
      // The top-level require('../../ecosystem.config') has already executed
      // by the time this test runs, so wrapping a fresh require() in
      // expect(...).not.toThrow() would be redundant (the module is cached).
      // Instead, assert that require.resolve() locates the file — a
      // distinct, meaningful check that does NOT re-execute the module body.
      expect(() => {
        require.resolve('../../ecosystem.config');
      }).not.toThrow();
    });

    it('should export a non-null object', () => {
      // Three checks triangulate "true plain object":
      //   1. defined (not undefined)
      //   2. not null (typeof null === 'object' historically, so this is needed)
      //   3. typeof === 'object' (rules out primitives)
      // Together these assert ecosystemConfig is a real object literal.
      expect(ecosystemConfig).toBeDefined();
      expect(ecosystemConfig).not.toBeNull();
      expect(typeof ecosystemConfig).toBe('object');
    });

    it('should parse in under 50ms', () => {
      // To meaningfully measure parse time, clear the require.cache entry
      // first. Without cache invalidation, a subsequent require() returns
      // the cached object instantly (~0ms) and the test would always pass
      // even if the underlying file had become catastrophically slow to
      // parse (e.g., due to a future top-level computation).
      const resolvedPath = require.resolve('../../ecosystem.config');
      delete require.cache[resolvedPath];

      const start = Date.now();
      // eslint-disable-next-line global-require
      require('../../ecosystem.config');
      const elapsed = Date.now() - start;

      // 50ms is the AAP-defined upper bound for ecosystem manifest parse
      // time. A typical pure-CommonJS object literal parses in <5ms; the
      // 50ms cap is a generous safety margin that catches accidental
      // top-level I/O, network calls, or expensive computation.
      expect(elapsed).toBeLessThan(50);
    });
  });

  // ----------------------------------------------------------------
  // Top-level shape
  // ----------------------------------------------------------------
  // PM2 expects the manifest to expose `apps` as an array of process
  // definitions. The array must contain at least one entry — an empty
  // apps array would mean PM2 has nothing to manage, defeating the
  // purpose of the manifest entirely.
  describe('Top-level shape', () => {
    it('should expose an `apps` array', () => {
      // toHaveProperty checks own-property presence; Array.isArray rules
      // out cases where `apps` is declared as a non-array value (e.g.,
      // an object, string, or number).
      expect(ecosystemConfig).toHaveProperty('apps');
      expect(Array.isArray(ecosystemConfig.apps)).toBe(true);
    });

    it('should have at least one app entry', () => {
      // A non-empty apps array is required for PM2 to manage any process.
      // This assertion also serves as a precondition for all subsequent
      // per-app tests: if apps is empty, the forEach loops below would
      // execute zero times and silently report all per-app field tests
      // as "passing" — a false negative we explicitly guard against here.
      expect(ecosystemConfig.apps.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ----------------------------------------------------------------
  // Per-app required fields
  // ----------------------------------------------------------------
  // Each app entry must satisfy the required-fields contract from AAP
  // Section 0.4.3: name, script, instances, exec_mode, env, env_production.
  // forEach iteration ensures every app entry is validated, not just the
  // first — this gracefully handles future multi-app configurations
  // (e.g., a worker process defined alongside the main web app).
  describe('Per-app required fields', () => {
    it('should have a non-empty string `name` field on each app', () => {
      // PM2 uses `name` as the process identifier for `pm2 start <name>`,
      // `pm2 logs <name>`, etc. An empty or missing name makes the
      // process unmanageable.
      ecosystemConfig.apps.forEach((app) => {
        expect(typeof app.name).toBe('string');
        expect(app.name.length).toBeGreaterThan(0);
      });
    });

    it('should have a non-empty string `script` field on each app', () => {
      // `script` is the entry-point file path PM2 invokes (e.g.,
      // 'src/server.js'). Without it, PM2 has nothing to launch.
      ecosystemConfig.apps.forEach((app) => {
        expect(typeof app.script).toBe('string');
        expect(app.script.length).toBeGreaterThan(0);
      });
    });

    it('should have an `instances` field that is a positive integer or the string "max"', () => {
      // PM2's `instances` field accepts a positive integer (exact worker
      // count) or the string 'max' (auto-scale to CPU core count). Per
      // AAP Section 0.4.3, only these two forms are sanctioned by this
      // testing strategy. Other PM2-supported values (e.g., -1, "0") are
      // intentionally rejected to keep the cluster-mode contract crisp.
      ecosystemConfig.apps.forEach((app) => {
        expect(app).toHaveProperty('instances');
        const isPositiveInt = typeof app.instances === 'number'
          && Number.isInteger(app.instances)
          && app.instances > 0;
        const isMaxString = app.instances === 'max';
        expect(isPositiveInt || isMaxString).toBe(true);
      });
    });

    it('should have an `exec_mode` of "fork" or "cluster"', () => {
      // PM2's `exec_mode` has only two valid values:
      //   - 'fork'    : single-process mode (default)
      //   - 'cluster' : multi-process mode using Node's cluster module
      // Any other value indicates a configuration bug.
      ecosystemConfig.apps.forEach((app) => {
        expect(app).toHaveProperty('exec_mode');
        expect(['fork', 'cluster']).toContain(app.exec_mode);
      });
    });

    it('should have an `env` object on each app', () => {
      // `env` is the default environment-variable map applied to the
      // process. It must be a plain object (not null, not an array,
      // not a primitive). The triangulation below rejects all three
      // failure modes:
      //   - null     -> `expect(...).not.toBeNull()` fails
      //   - array    -> `Array.isArray(...)` returns true and trips
      //                 the toBe(false) assertion
      //   - primitive-> `typeof !== 'object'` fails
      ecosystemConfig.apps.forEach((app) => {
        expect(app).toHaveProperty('env');
        expect(app.env).not.toBeNull();
        expect(typeof app.env).toBe('object');
        expect(Array.isArray(app.env)).toBe(false);
      });
    });

    it('should have an `env_production` object on each app', () => {
      // env_production is the production-only environment override map.
      // Same plain-object triangulation as `env` above.
      ecosystemConfig.apps.forEach((app) => {
        expect(app).toHaveProperty('env_production');
        expect(app.env_production).not.toBeNull();
        expect(typeof app.env_production).toBe('object');
        expect(Array.isArray(app.env_production)).toBe(false);
      });
    });
  });

  // ----------------------------------------------------------------
  // Environment overrides
  // ----------------------------------------------------------------
  // The most security-critical assertion in this test file is the
  // production-mode NODE_ENV check. Misconfiguring env_production.NODE_ENV
  // causes the production deployment to run in development mode — verbose
  // logging, exposed stack traces, debug endpoints active, and other
  // exploitable issues. This block enforces strict equality.
  describe('Environment overrides', () => {
    it('should set env_production.NODE_ENV to "production"', () => {
      // Strict-equality assertion against the literal 'production' string.
      // No tolerance for casing variants ('Production', 'PRODUCTION') or
      // alternative values ('prod', 'live') — PM2 and most Node libraries
      // (Express, Winston, etc.) check the exact string 'production' to
      // toggle production-mode behavior.
      ecosystemConfig.apps.forEach((app) => {
        expect(app.env_production.NODE_ENV).toBe('production');
      });
    });

    it('should have a string NODE_ENV value in env if defined', () => {
      // env.NODE_ENV is conventionally 'development' but the AAP does
      // NOT mandate its presence (only env_production.NODE_ENV is
      // strictly required). If env.NODE_ENV is defined, however, it
      // must be a non-empty string — an empty string or non-string
      // value would cause downstream environment-detection logic to
      // misbehave (Express defaults to 'development' if NODE_ENV is
      // an empty string, for example, which is fine, but assigning a
      // numeric or boolean value to NODE_ENV would break Winston's
      // environment-conditional transport selection).
      ecosystemConfig.apps.forEach((app) => {
        if (app.env.NODE_ENV !== undefined) {
          expect(typeof app.env.NODE_ENV).toBe('string');
          expect(app.env.NODE_ENV.length).toBeGreaterThan(0);
        }
      });
    });
  });
});
