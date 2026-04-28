'use strict';

/**
 * ecosystem.config.js
 *
 * PM2 process manager configuration for the Express.js application.
 *
 * PM2 is a production-grade Node.js process manager that handles:
 *   - Auto-restarts on crash
 *   - Cluster-mode multi-process scaling
 *   - Log aggregation and rotation
 *   - Graceful reloads (zero-downtime deploys)
 *   - Environment-variable injection per environment (dev, staging,
 *     production)
 *
 * This file is loaded by PM2's CLI and daemon at process-management
 * commands such as:
 *   - `pm2 start ecosystem.config.js`
 *   - `pm2 start ecosystem.config.js --env production`
 *   - `pm2 reload ecosystem.config.js`
 *
 * The exported shape is fixed by PM2's documented schema:
 *   { apps: [ { name, script, instances, exec_mode, env,
 *               env_production, ... } ] }
 *
 * Behavior contract (per AAP Section 0.4.3 and the
 * tests/unit/ecosystem.test.js test suite):
 *
 *   Top-level shape
 *     - Exports a plain object via `module.exports`.
 *     - The `apps` property is an array with at least one entry.
 *
 *   Per-app required fields
 *     - `name`        : non-empty string (PM2 process identifier)
 *     - `script`      : non-empty string (entry-point file path)
 *     - `instances`   : positive integer or string 'max' (scale
 *                       count or auto-scale to CPU core count)
 *     - `exec_mode`   : 'fork' (single-process) or 'cluster'
 *                       (multi-process via Node's cluster module)
 *     - `env`         : plain object — default env-var map
 *     - `env_production` : plain object — production-only env-var
 *                       map; MUST set `NODE_ENV: 'production'`
 *
 * CommonJS-only constraint:
 *   This file is loaded by PM2's CommonJS-based parser. The project's
 *   `package.json` does NOT declare `"type": "module"`, so `.js`
 *   files default to CommonJS resolution. The `module.exports`
 *   pattern below is the canonical PM2 manifest shape and is
 *   compatible with both Node's CommonJS loader (used by Jest's
 *   `tests/unit/ecosystem.test.js`) and PM2's parser.
 *
 *   Per AAP 0.10.1: "The `ecosystem.config.js` file is loaded by
 *   PM2's CommonJS-based parser; ensuring `package.json` does NOT
 *   add `"type": "module"` keeps the file working with both PM2 and
 *   Node's `require()`."
 *
 * Conventions (per AAP Section 0.10.1):
 *   - CommonJS module.exports
 *   - Two-space indentation, single quotes, semicolons,
 *     const-by-default, trailing commas in multiline literals
 *   - 'use strict' at the file head
 *
 * @see https://pm2.keymetrics.io/docs/usage/application-declaration/
 */

// ---------------------------------------------------------------------------
// Default environment variables (applied to every PM2 environment)
// ---------------------------------------------------------------------------
// Held in a constant so `env` and the per-environment overrides
// (`env_production`) can build on a shared baseline without
// repeating the entire env map. PM2 merges per-environment env maps
// onto the base `env` map at process start: keys present in
// `env_production` override the same keys in `env`; keys absent
// from `env_production` fall through to `env`.

/**
 * Default environment variables applied to every PM2 launch.
 *
 * `NODE_ENV: 'development'` is the conventional default; it
 * activates Express's verbose error pages, Winston's pretty-print
 * formatter, and other developer-friendly behaviors. The production
 * environment overrides this value via `env_production` below.
 *
 * `PORT` and `HOST` mirror the defaults documented in
 * `src/config/index.js`. PM2 makes these available to the app
 * process via `process.env.PORT` / `process.env.HOST`, where the
 * config loader picks them up.
 *
 * `LOG_LEVEL` is omitted from the default env map intentionally —
 * the config loader applies environment-aware defaults
 * ('debug' for non-production, 'info' for production) when
 * `LOG_LEVEL` is unset, so explicit defaults here would override
 * the environment-aware logic.
 */
const DEFAULT_ENV = {
  NODE_ENV: 'development',
  PORT: '3000',
  HOST: '0.0.0.0',
};

/**
 * Production-environment override map.
 *
 * Only the keys that DIFFER from the development defaults need to
 * be specified here — PM2 applies the production env on top of the
 * default env at process start.
 *
 * `NODE_ENV: 'production'` is the single most security-critical
 * value in this file. Express, Winston, and many other Node
 * libraries check the exact string 'production' to toggle:
 *   - Stack-trace suppression in error responses
 *   - JSON log formatting (vs. pretty-print)
 *   - Disabling debug routes
 *   - Enabling response compression
 *   - Caching view templates
 *
 * Misconfiguring this value (e.g., 'Production', 'PROD', 'live')
 * causes the deployment to silently run in development mode with
 * verbose stacks, debug logs, and other exploitable defaults.
 *
 * `LOG_LEVEL: 'info'` matches the config loader's production
 * default. Setting it explicitly here documents the intent —
 * future config-loader changes won't accidentally drop
 * production-mode logging to a less verbose level.
 */
const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
};

// ---------------------------------------------------------------------------
// Manifest export
// ---------------------------------------------------------------------------
// PM2 expects exactly this shape: an object with an `apps` array
// containing one or more app definitions. Single-app deployments
// (the typical case) use a single-element array.

module.exports = {
  apps: [
    {
      // -------------------------------------------------------------------
      // Process identity
      // -------------------------------------------------------------------
      // `name` is the PM2 process identifier — used in `pm2 logs <name>`,
      // `pm2 restart <name>`, etc. The value is human-readable; PM2 uses
      // it as a key in its in-memory process registry. Choosing a name
      // that matches the package's logical role ('hello-world-server')
      // makes operator commands self-documenting.
      name: 'hello-world-server',

      // `script` is the entry-point file PM2 invokes. The path is
      // relative to the project root (where ecosystem.config.js lives).
      // PM2 spawns the script via Node — equivalent to running
      // `node src/server.js` directly.
      script: 'src/server.js',

      // -------------------------------------------------------------------
      // Scaling
      // -------------------------------------------------------------------
      // `instances: 1` runs a single Node process. Setting this to a
      // positive integer N runs N processes; setting it to 'max' runs
      // one process per CPU core. The Hello World endpoint handles a
      // tiny workload; multi-process scaling adds overhead without
      // benefit. Operators who later need horizontal scaling can change
      // this to 'max' or a specific number without restructuring.
      instances: 1,

      // `exec_mode: 'fork'` uses the simpler single-process spawn model
      // (Node's `child_process.spawn`). 'cluster' would use Node's
      // cluster module for multi-process load balancing, which requires
      // `instances` > 1. For a single-instance deployment, 'fork' is
      // the correct choice.
      exec_mode: 'fork',

      // -------------------------------------------------------------------
      // Auto-restart and watch
      // -------------------------------------------------------------------
      // `autorestart: true` is PM2's default — restart the process on
      // crash. Disabling this would mean a single uncaught exception
      // takes down the deployment until manually restarted.
      autorestart: true,

      // `watch: false` disables file-watching restart in production.
      // PM2's watch mode is useful in development (it restarts on file
      // changes) but is dangerous in production because partial
      // deploys (e.g., a partial git pull) could trigger restarts on
      // syntactically-broken files.
      watch: false,

      // `max_memory_restart` automatically restarts the process if its
      // memory usage exceeds the threshold. The Express Hello World
      // app should comfortably fit in 200MB; setting the threshold
      // higher (250MB) provides headroom for log buffer growth and
      // V8's per-process baseline without false positives.
      max_memory_restart: '250M',

      // -------------------------------------------------------------------
      // Environment variable maps
      // -------------------------------------------------------------------
      // PM2 applies the appropriate env map at process start based on
      // the --env flag:
      //   `pm2 start ecosystem.config.js`            -> `env`
      //   `pm2 start ecosystem.config.js --env production`
      //                                              -> `env` + `env_production`
      // Per-environment maps override the base `env` for the keys they
      // define and inherit base values for keys they don't.
      env: DEFAULT_ENV,
      env_production: PRODUCTION_ENV,
    },
  ],
};
