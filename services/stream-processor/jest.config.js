/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Previously this listed exactly two files, so the reported percentage described a
  // hand-picked subset rather than the service. Now it is every shipped source file.
  // index.ts is the process bootstrap; both exclusions are explicit rather than quiet.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts'
  ]
  // No coverageThreshold. A threshold over a two-file allowlist measures nothing; the
  // measured figure over the real file set is recorded in docs/STATUS.md.
};
