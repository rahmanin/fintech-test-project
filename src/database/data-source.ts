import { DataSource, DataSourceOptions } from 'typeorm';

/**
 * Single TypeORM configuration shared by the Nest app and the migration runner.
 *
 * Why `synchronize: false`, always: schema changes must be explicit,
 * reviewable migrations. Auto-sync would silently alter or drop columns in
 * whatever database it connects to, which is unacceptable for a table that
 * holds money.
 *
 * Entities and migrations are resolved relative to this file so the same
 * options work from `src/` under ts-node and from `dist/` after `nest build`.
 */
export function buildDataSourceOptions(databaseUrl: string): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    synchronize: false,
    logging: ['error', 'warn'],
    entities: [__dirname + '/../**/*.entity.{ts,js}'],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    migrationsTableName: 'migrations',
  };
}

export function createDataSource(databaseUrl: string): DataSource {
  return new DataSource(buildDataSourceOptions(databaseUrl));
}
