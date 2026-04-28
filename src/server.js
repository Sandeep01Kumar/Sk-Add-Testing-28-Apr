'use strict';

/**
 * src/server.js
 *
 * Application bootstrap — the single point in the codebase that binds
 * the Express app to a TCP socket via `app.listen()`.
 *
 * Responsibilities:
 *   1. Load the configuration (port, host, nodeEnv, logLevel) via
 *      `src/config/index.js`.
 *   2. Construct the Express app via the `src/app.js` factory.
 *   3. Bind the app to `config.host:config.port` via `.listen()`.
 *   4. Emit a startup log entry indicating the server is listening.
 *   5. Handle process-level shutdown signals (SIGINT, SIGTERM)
 *      gracefully, closing the HTTP server before the process exits.
 *
 * Why this file exists separately from `src/app.js`:
 *   Per AAP 0.10.1: "the only acceptable source change driven by
 *   testing is the `app.js`/`server.js` separation noted above."
 *   This file IS that separation. By isolating `.listen()` here,
 *   the test suite can construct app instances via the factory in
 *   `app.js` and inject them into Supertest WITHOUT triggering a real
 *   port bind. That separation is the cornerstone of every modern
 *   Express + Supertest testing guide.
 *
 * Module-level execution semantics:
 *   The module body executes at the time of the first `require()` —
 *   which, for this file, is when PM2 (or `npm start`) launches the
 *   process. The body calls `app.listen()` synchronously; the bind
 *   itself is asynchronous (the OS kernel returns control before the
 *   socket is fully ready), but the call returns the http.Server
 *   instance immediately so we can attach signal handlers.
 *
 * Test exclusion:
 *   This file is excluded from coverage via Jest's
 *   `coveragePathIgnorePatterns` because `app.listen()` triggers a
 *   real port bind and is not meaningfully testable in-process. The
 *   binding behavior is exercised at process-boot time during
 *   manual smoke tests and PM2 startup verification per AAP 0.4.3.
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS require() / module.exports
 *   - Two-space indentation, single quotes, semicolons,
 *     const-by-default, trailing commas in multiline literals
 *   - 'use strict' at the file head
 *
 * @module src/server
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
// Top-level requires: `dotenv/config` MUST be loaded before any module
// that reads `process.env` (i.e., before `./config`). The
// `dotenv/config` side-effect import populates `process.env` from the
// `.env` file at the project root if one exists. In production
// deployments under PM2, environment variables are populated via PM2's
// `env`/`env_production` mechanism (per `ecosystem.config.js`), so the
// `.env` file is typically absent and dotenv silently no-ops.

// eslint-disable-next-line import/no-unassigned-import
require('dotenv/config');

const config = require('./config');
const logger = require('./logger');
const createApp = require('./app');

// ---------------------------------------------------------------------------
// Construct the Express app
// ---------------------------------------------------------------------------
// `createApp()` returns an unbound Express app instance — no port is
// bound yet. The factory is pure and idempotent; calling it here is
// equivalent to calling it from any test helper.

const app = createApp();

// ---------------------------------------------------------------------------
// Bind the app to a TCP socket
// ---------------------------------------------------------------------------
// `app.listen(port, host, callback)` returns the http.Server instance
// the OS kernel attaches the socket to. The callback fires once the
// socket is ready to accept connections — we use it to log the
// startup line so the operator (or PM2 log aggregator) can confirm
// the bind succeeded.
//
// Storing the returned server in a `const` so we can close it in the
// signal handlers below. PM2 sends SIGINT (Ctrl+C) and SIGTERM
// (`pm2 stop`) to gracefully terminate the process; without explicit
// handlers, Node's default behavior is an immediate exit which can
// drop in-flight requests and corrupt log streams.

const server = app.listen(config.port, config.host, () => {
  // Structured log — the message is human-readable and the metadata
  // is queryable. Winston serializes the object to JSON in production
  // mode (per src/logger/index.js's environment-conditional
  // formatter) and to colorized pretty-print in development.
  logger.info('server listening', {
    host: config.host,
    port: config.port,
    nodeEnv: config.nodeEnv,
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown handlers
// ---------------------------------------------------------------------------
// Both SIGINT (interactive Ctrl+C) and SIGTERM (`kill <pid>`,
// `pm2 stop`, container orchestration) trigger the same shutdown
// sequence: stop accepting new connections, drain in-flight ones,
// then exit. `server.close(callback)` performs this drain and
// invokes the callback once the last request finishes.
//
// We use a single shared handler factory rather than two anonymous
// handlers to keep the shutdown logic in one place. The signal name
// is captured in the closure for use in the log message.

/**
 * Build a process-signal handler that gracefully shuts down the HTTP
 * server before exiting.
 *
 * @param {string} signal The signal name (e.g., 'SIGINT', 'SIGTERM').
 * @returns {Function} A no-arg handler suitable for
 *   `process.on(signal, handler)`.
 */
function buildShutdownHandler(signal) {
  return function handleShutdown() {
    logger.info('shutdown signal received, closing server', {
      signal,
    });

    // server.close stops accepting new connections immediately and
    // invokes the callback once all existing connections have ended.
    // The exit code 0 indicates a clean shutdown — PM2 distinguishes
    // 0 from non-zero exit codes when deciding whether to restart.
    server.close((err) => {
      if (err) {
        // Failed to close cleanly (rare — typically only if .close()
        // is called twice). Log the error and exit with a non-zero
        // code so PM2 knows to restart in cluster mode.
        logger.error('error during server close', err);
        // eslint-disable-next-line no-process-exit
        process.exit(1);
        return;
      }

      logger.info('server closed cleanly, exiting', { signal });
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    });
  };
}

process.on('SIGINT', buildShutdownHandler('SIGINT'));
process.on('SIGTERM', buildShutdownHandler('SIGTERM'));

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
// Export the http.Server instance so out-of-band consumers (PM2's
// readiness checks, integration smoke tests that spawn this module
// in a subprocess) can introspect the bound server. Most consumers
// don't import this module directly — PM2 launches it as a child
// process and the http.Server's lifecycle is tied to the process.

module.exports = server;
