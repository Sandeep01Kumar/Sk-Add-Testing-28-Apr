/**
 * Jest configuration
 *
 * Authored per Agent Action Plan Section 0.5.4 to drive test execution,
 * coverage collection, and CI-friendly defaults for the Express.js
 * modernization of the legacy Node.js HTTP server.
 *
 * - testEnvironment: node          (no jsdom required for an HTTP server)
 * - testMatch: tests/**\/*.test.js (co-located test layout)
 * - setupFiles: dotenv/config      (loads .env / tests/fixtures/.env.test)
 * - coverage thresholds            (per AAP Section 0.7.1)
 * - clearMocks / restoreMocks: true (per AAP Section 0.7.2)
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['dotenv/config'],
  collectCoverageFrom: [
    'src/**/*.js',
    'ecosystem.config.js',
    '!src/server.js',
    '!**/node_modules/**'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 90,
      lines: 85,
      statements: 85
    },
    './src/middleware/': {
      branches: 85,
      functions: 100,
      lines: 90,
      statements: 90
    },
    './src/config/': {
      branches: 85,
      functions: 100,
      lines: 90,
      statements: 90
    },
    './src/routes/': {
      branches: 85,
      functions: 100,
      lines: 90,
      statements: 90
    }
  },
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/coverage/',
    '/tests/',
    '/src/server.js'
  ],
  clearMocks: true,
  restoreMocks: true,
  verbose: true,
  testTimeout: 10000
};
