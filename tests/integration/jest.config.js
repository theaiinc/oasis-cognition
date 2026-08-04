/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.test\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
  testTimeout: 1_200_000,
  maxWorkers: 1,               // runInBand — avoid GPU contention on local LLM
  globalSetup: './setup.ts',
  globalTeardown: './teardown.ts',
};
