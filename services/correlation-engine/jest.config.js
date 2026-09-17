/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // The differential fuzz drives 10,000 randomised sequences through two implementations and
  // compares the partition after every operation. That is the acceptance criterion for WP2, so
  // it runs in the normal suite rather than behind a flag, and it needs more than jest's 5s.
  testTimeout: 120000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts'
  ]
};
