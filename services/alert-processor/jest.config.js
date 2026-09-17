/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFiles: ['<rootDir>/src/testSetup.ts'],
  // Every shipped source file, not a hand-picked subset. index.ts is the process bootstrap
  // and test-producer.ts is a manual smoke-test script; neither is meaningfully testable
  // without a broker, and both are excluded explicitly rather than quietly.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/test-producer.ts',
    '!src/testSetup.ts',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts'
  ]
  // No coverageThreshold. A threshold over a two-file allowlist is theatre; see docs/STATUS.md
  // for the measured figure over the real file set.
};
