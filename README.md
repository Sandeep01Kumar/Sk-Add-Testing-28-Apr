# hao-backprop-test

A Node.js HTTP server test fixture for backprop integration, modernized with the
Express.js framework, routing, middleware, environment-driven configuration,
Winston logging, and PM2 deployment readiness. This repository remains a
deliberately minimal fixture used to exercise backprop integration scenarios;
the testing infrastructure documented below validates the post-enhancement
Express architecture.

> **Note:** Earlier revisions of this README contained a frozen-baseline
> directive reflecting a "do-not-modify" governance state. That directive has
> been superseded by the introduction of comprehensive testing infrastructure
> and the broader Express enhancement. Contributions and modifications are now
> expected to follow the testing patterns documented below.

---

## Project Overview

This project provides:

- An Express.js application replacing the legacy single-file `http.createServer`
  implementation
- HTTP routing with per-route handlers
- Middleware for request logging, error handling, and unmatched-route (404)
  fall-through
- Environment-driven configuration loaded via `dotenv`
- Structured logging via Winston with environment-conditional transports
- A PM2 ecosystem manifest (`ecosystem.config.js`) for production deployment
- A Jest-based unit and integration test suite with coverage gates

The remainder of this document focuses exclusively on the **testing**
workflow — how to install, run, debug, and extend the test suite.

---

## Prerequisites

| Requirement | Recommended Version | Notes |
| ----------- | ------------------- | ----- |
| Node.js     | v18 or later        | Project tested with Node.js v22.22.2; Jest 30 mandates Node 18+ |
| npm         | v11.x               | Required for `package-lock.json` `lockfileVersion: 3` compatibility |

### Installation

Install all production and development dependencies (Express, dotenv, Winston,
Jest, Supertest, `@jest-mock/express`):

```bash
# Preferred for deterministic, lockfile-driven installs (recommended for CI)
npm ci

# Alternative for local development (resolves to latest compatible versions)
npm install
```

After install, verify the test runner is wired correctly by listing the
available scripts:

```bash
npm run
```

You should see `test`, `test:watch`, `test:coverage`, and `test:ci` listed.

---

## Testing

The test suite is built on **Jest 30** (test runner, assertions, mocking,
coverage), **Supertest 7** (in-process HTTP assertion against the Express app),
and **`@jest-mock/express`** (convenience mocks for Express `req`/`res`/`next`
in middleware unit tests). Configuration lives in `jest.config.js`.

### Test Commands

All four commands below are defined in `package.json` under `scripts`. Run them
from the repository root.

| Command                  | Underlying Jest Invocation                              | Purpose |
| ------------------------ | ------------------------------------------------------- | ------- |
| `npm test`               | `jest`                                                  | Run the full test suite once. No watch mode, no coverage collection. Suitable for quick local verification. |
| `npm run test:watch`     | `jest --watch`                                          | Run Jest in watch mode for developer iteration; reruns affected tests on file save. **Developer use only — NEVER use in CI/automation.** Exit with `q`. |
| `npm run test:coverage`  | `jest --coverage`                                       | Run the full suite and collect coverage. Enforces the thresholds defined in `jest.config.js`; the command exits non-zero if any threshold is unmet. |
| `npm run test:ci`        | `jest --ci --coverage --watchAll=false --maxWorkers=2`  | Non-interactive CI-safe run with coverage, watch disabled, and bounded parallelism for resource-constrained CI runners. |

Examples:

```bash
# Run once
npm test

# Iterate locally with watch mode (do NOT use in CI)
npm run test:watch

# Generate the full coverage report
npm run test:coverage

# CI-equivalent run (deterministic, single-pass, capped workers)
npm run test:ci
```

### Coverage Reports

Running `npm run test:coverage` (or `npm run test:ci`) writes coverage
artifacts to the `coverage/` directory at the repository root. Jest creates
this directory automatically; no manual setup is required. The directory is
listed in `.gitignore` and must not be committed.

The configured reporters are:

| Reporter        | Output                                                 | Use Case |
| --------------- | ------------------------------------------------------ | -------- |
| `text`          | Printed to terminal as a per-file coverage table        | Quick visual inspection at the end of a run |
| `text-summary`  | Single-line summary printed to terminal                 | Lightweight CI log summary |
| `lcov`          | Machine-readable file at `coverage/lcov.info`           | Upload to coverage services (Codecov, Coveralls) |
| `html`          | Browsable report at `coverage/lcov-report/index.html`   | Open in a browser to drill into per-file/per-line coverage |

Open the HTML report locally with your platform's default browser:

```bash
# macOS
open coverage/lcov-report/index.html

# Linux
xdg-open coverage/lcov-report/index.html

# Windows (PowerShell or cmd)
start coverage/lcov-report/index.html
```

#### Coverage Thresholds

The build fails if any of these global thresholds is unmet:

| Metric      | Global Threshold |
| ----------- | ---------------- |
| Lines       | ≥ 85%            |
| Statements  | ≥ 85%            |
| Branches    | ≥ 80%            |
| Functions   | ≥ 90%            |

Stricter per-directory thresholds (defined in `jest.config.js`) apply IN
ADDITION to the global thresholds for `./src/middleware/`, `./src/config/`,
and `./src/routes/`:

| Metric      | Per-Directory Threshold |
| ----------- | ----------------------- |
| Lines       | ≥ 90%                   |
| Statements  | ≥ 90%                   |
| Branches    | ≥ 85%                   |
| Functions   | 100%                    |

`src/server.js` is excluded from coverage because it exists solely to invoke
`app.listen()` and is not exercised at test time, by design (the standard
Express + Supertest separation pattern).

### Test Layout

Tests are organized under a top-level `tests/` directory, mirroring the source
layout for predictable navigation:

```
tests/
  unit/         - Per-module unit tests (routes, middleware, config, logger)
  integration/  - Full-stack integration tests via Supertest
  fixtures/     - Reusable factories: env, request, response, payloads, .env.test
  helpers/      - Shared utilities: buildApp.js, silenceLogger.js
jest.config.js  - Jest configuration with coverage thresholds
```

- `tests/unit/` holds isolated tests that exercise a single module with all
  external dependencies mocked.
- `tests/integration/` holds tests that wire the full Express middleware chain
  together and issue real HTTP requests via Supertest's in-process injection.
- `tests/fixtures/` holds plain JavaScript factory modules (no Jest-specific
  code) that produce shaped `req`/`res` mocks, env-variable overrides, and
  canonical response payloads. Fixtures are framework-agnostic and reusable
  across unit and integration tests.
- `tests/helpers/` holds shared utilities such as `buildApp.js` (constructs a
  fresh Express app for unit tests), `silenceLogger.js` (replaces Winston's
  transports with a no-op transport at runtime), and `loadTestEnv.js` (the
  Jest setup file that loads `tests/fixtures/.env.test` into `process.env`
  via `dotenv.config({ path: ... })` before tests run).

### Adding New Tests

When introducing a new test file, follow the conventions established by the
initial suite:

#### 1. File Naming

Test file names mirror the corresponding source module's base name with a
`.test.js` suffix:

```
src/middleware/errorHandler.js  →  tests/unit/middleware/errorHandler.test.js
src/routes/health.js            →  tests/unit/routes/health.test.js
src/config/index.js             →  tests/unit/config/config.test.js
```

This naming aligns with the project's configured `testMatch` pattern in
[`jest.config.js`](https://jestjs.io/docs/configuration#testmatch-arraystring)
(`**/tests/**/*.test.js`). Jest's own out-of-the-box defaults are
`**/__tests__/**/*.[jt]s?(x)` and `**/?(*.)+(spec|test).[jt]s?(x)`; the
project narrows discovery to `tests/**/*.test.js` so that fixtures and
helpers (which lack the `.test.js` suffix) are intentionally NOT matched.

#### 2. Block Structure

Use a nested `describe` / `it` structure with the outer `describe` naming the
module under test, an optional inner `describe` grouping related behaviors,
and an `it` block per behavior:

```javascript
describe('errorHandler', () => {
  describe('when err.statusCode is provided', () => {
    it('should respond with the provided status code', () => {
      // Arrange
      // Act
      // Assert
    });
  });
});
```

#### 3. Test Name Template

Use the form: `it("should <expected behavior> when <input or condition>")`.
Test names serve as primary documentation for the suite.

```javascript
it('should return 404 when the requested path is not registered');
it('should call next() exactly once when the logger throws');
it('should freeze the configuration object when all env vars are valid');
```

#### 4. Module System

All test files use Node.js **CommonJS** `require()` syntax to match
`package.json` (which intentionally does not declare `"type": "module"` in
order to remain compatible with PM2's `ecosystem.config.js` parser).

```javascript
const request = require('supertest');
const errorHandler = require('../../../src/middleware/errorHandler');
```

#### 5. Mocking

Jest's built-in mocking is the standard. No third-party mocking library is
introduced. Use:

- `jest.fn()` for inline function mocks
- `jest.mock(<module>)` (hoisted automatically by Jest) for module-level mocks
- `jest.spyOn(<obj>, <method>)` for spying on existing implementations

Example for mocking Winston:

```javascript
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  format: {
    combine: jest.fn(),
    json: jest.fn(),
    timestamp: jest.fn(),
    printf: jest.fn(),
  },
  transports: { Console: jest.fn(), File: jest.fn() },
}));
```

#### 6. HTTP-Level Tests

All HTTP-level assertions go through Supertest's in-process injection. **Never
call `app.listen()` from a test file.** Pass the Express `app` callable
directly to `supertest()`:

```javascript
const request = require('supertest');
const app = require('../../src/app');

it('should return 200 when GET / is requested', async () => {
  await request(app).get('/').expect(200);
});
```

Supertest binds the app to an ephemeral port internally for the duration of
each request, so no port collisions occur during parallel test runs.

#### 7. Test Isolation

Each test file must be runnable in isolation
(`npx jest path/to/file.test.js`). Jest's `clearMocks: true` and
`restoreMocks: true` flags (configured in `jest.config.js`) automatically
reset `jest.fn()` and `jest.spyOn()` state between tests. For tests that
mutate `process.env`, capture and restore state explicitly:

```javascript
let originalEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  jest.resetModules();
});
afterEach(() => {
  process.env = originalEnv;
});
```

### Test Environment Prerequisites

The following preconditions MUST be satisfied for the test suite to run
correctly:

1. **`tests/fixtures/.env.test` must exist.** This file is committed to the
   repository (it is intentionally NOT excluded by `.gitignore`) because it
   contains only deterministic test-environment values, never secrets. It
   must define at minimum:

   ```bash
   NODE_ENV=test
   PORT=3000
   HOST=127.0.0.1
   LOG_LEVEL=silent
   ```

   The file is loaded once per Jest worker via the custom setup file
   `tests/helpers/loadTestEnv.js`, registered under `setupFiles` in
   `jest.config.js`. That helper resolves the absolute path to
   `tests/fixtures/.env.test` and calls
   `dotenv.config({ path: <abs path> })` so that the project's deterministic
   test-environment fixture is loaded BEFORE any test module is required.

   > **Why a custom setup file rather than the `dotenv/config` shorthand?**
   > The `dotenv/config` entry point loads `.env` from `process.cwd()` by
   > default — it does NOT load `tests/fixtures/.env.test`. The custom
   > setup file targets the fixture explicitly with an absolute path,
   > which works on every platform without requiring `cross-env` or
   > shell-specific environment-variable syntax in npm scripts.

   `dotenv.config()` does NOT overwrite values that already exist in
   `process.env`, so CI runners and developer shells can override any
   key by exporting it before invoking Jest. Tests that need a
   *different* environment than `.env.test` (e.g., production-mode
   tests) follow the canonical capture-and-restore pattern documented
   in the next section.

2. **No external services are required.** The suite makes zero outbound
   network calls and depends on no databases, caches, message queues, or
   third-party APIs. All "external" dependencies (Winston transports, file
   system writes, real HTTP listeners) are mocked or replaced with in-process
   fakes.

3. **The `coverage/` directory is created automatically** by Jest when
   `--coverage` is passed; no manual `mkdir` step is needed. The directory
   is `.gitignore`d and must not be committed.

4. **Node.js v18 or later** must be available on `PATH` (Jest 30 minimum).

### Debugging Tests

#### Run a single test file

```bash
npx jest tests/unit/middleware/errorHandler.test.js
```

#### Run tests matching a name pattern

The `-t` flag filters by `describe`/`it` name regex:

```bash
npx jest -t "should return 404"
```

#### Attach the Node Inspector debugger

Run a single test in `--runInBand` (single-process) mode under Node Inspector
and attach with Chrome DevTools (`chrome://inspect`) or your IDE:

```bash
node --inspect-brk node_modules/.bin/jest --runInBand tests/unit/middleware/errorHandler.test.js
```

#### Diagnose hanging tests

If a test does not exit cleanly (typically due to leaked timers, sockets, or
file descriptors), run with open-handle detection enabled:

```bash
npx jest --detectOpenHandles
```

Jest will print a stack trace identifying the source of any open handle so it
can be cleaned up in the test's `afterEach` or `afterAll` hook.

#### Run all tests in a directory

```bash
npx jest tests/unit/middleware
```

---

## References

Authoritative external documentation for every tool and framework referenced
above. Each link points at the canonical project home, package registry entry,
or configuration reference used to drive the choices documented in this README.

### Test framework and HTTP testing

- [Jest — official documentation](https://jestjs.io) — runner, assertions,
  mocking, and coverage. The configuration reference used by this repository's
  `jest.config.js` is at
  [jestjs.io/docs/configuration](https://jestjs.io/docs/configuration).
- [Jest — `expect` matchers](https://jestjs.io/docs/expect) — full matcher
  catalogue (`toBe`, `toEqual`, `toHaveBeenCalledWith`, `toMatchObject`, etc.).
- [Jest — mocking guide](https://jestjs.io/docs/mock-functions) — `jest.fn()`,
  `jest.mock()`, `jest.spyOn()` patterns used across this suite.
- [Supertest — GitHub repository](https://github.com/ladjs/supertest) —
  in-process HTTP assertion against the Express `app` callable.
- [Supertest — npm package](https://www.npmjs.com/package/supertest) — version
  history and install instructions.
- [`@jest-mock/express` — npm package](https://www.npmjs.com/package/@jest-mock/express)
  — convenience helpers (`getMockReq()`, `getMockRes()`) for unit-testing
  Express middleware.

### Production runtime dependencies

- [Express.js — official documentation](https://expressjs.com) — application
  factory, routing, middleware, and Express 5 migration notes
  ([expressjs.com/en/guide/migrating-5.html](https://expressjs.com/en/guide/migrating-5.html)).
- [Express.js — npm package](https://www.npmjs.com/package/express) — install
  instructions and dependency graph.
- [`dotenv` — GitHub repository](https://github.com/motdotla/dotenv) —
  environment-variable loading from `.env` files (used by
  `tests/helpers/loadTestEnv.js` to load `tests/fixtures/.env.test`).
- [`dotenv` — npm package](https://www.npmjs.com/package/dotenv).
- [Winston — GitHub repository](https://github.com/winstonjs/winston) —
  structured logger with environment-conditional transports.
- [Winston — npm package](https://www.npmjs.com/package/winston).

### Production deployment

- [PM2 — official documentation](https://pm2.keymetrics.io) — production
  process manager. Ecosystem-file reference at
  [pm2.keymetrics.io/docs/usage/application-declaration/](https://pm2.keymetrics.io/docs/usage/application-declaration/).
- [PM2 — npm package](https://www.npmjs.com/package/pm2).

### Runtime environment

- [Node.js — official documentation](https://nodejs.org) — runtime APIs
  (`http`, `process`, modules) used by the application and tests.
- [npm CLI — `npm ci` reference](https://docs.npmjs.com/cli/v11/commands/npm-ci)
  — deterministic, lockfile-driven install used by CI.
- [npm CLI — `npm install` reference](https://docs.npmjs.com/cli/v11/commands/npm-install)
  — local-development install command.

---

## License

MIT
