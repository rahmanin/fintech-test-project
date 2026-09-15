import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  // Decorator metadata is read at class-definition time, so reflect-metadata
  // must be loaded before any DTO module is imported. main.ts does this in
  // the app; unit tests need it too.
  setupFiles: ['reflect-metadata'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  collectCoverageFrom: ['**/*.ts', '!**/*.spec.ts', '!main.ts', '!database/migrate.ts'],
  coverageDirectory: '../coverage',
};

export default config;
