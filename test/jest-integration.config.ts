import type { Config } from 'jest';

// Integration tests need a real Postgres (docker-compose.test.yml). They run
// serially (--runInBand in the npm script) because they share one database.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '.*\\.(int|e2e)-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  setupFiles: ['reflect-metadata', '<rootDir>/setup-env.ts'],
  testTimeout: 30000,
};

export default config;
