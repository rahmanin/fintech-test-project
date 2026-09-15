import type { Config } from 'jest';

// End-to-end tests need a real Postgres (see docker-compose.test.yml); they
// are kept out of the default `npm test` run so unit tests stay instant.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
};

export default config;
