import 'dotenv/config';
import { validateEnv } from '../config/env.validation';
import { createDataSource } from './data-source';

/**
 * Standalone migration runner, executed by the container entrypoint before
 * the HTTP server starts (see docker-entrypoint.sh).
 *
 * Why a separate step and not `migrationsRun: true` inside the app: with two
 * app instances starting at once, both would try to apply the same migration
 * and one would fail on the migrations table lock or on a duplicate DDL.
 * Running migrations as an explicit, single step keeps "schema is ready"
 * and "app is serving" as two distinct states an operator can observe.
 */
async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const dataSource = createDataSource(env.DATABASE_URL);
  await dataSource.initialize();
  try {
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    if (applied.length === 0) {
      console.log('migrations: nothing to apply');
    } else {
      for (const m of applied) console.log(`migrations: applied ${m.name}`);
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err: unknown) => {
  console.error('migrations: failed', err);
  process.exit(1);
});
