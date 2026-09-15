import { DataSource } from 'typeorm';
import { ProgramEntity } from '../src/programs/program.entity';

/** Apply migrations once per test file and wipe business tables between tests. */
export async function migrate(dataSource: DataSource): Promise<void> {
  await dataSource.runMigrations({ transaction: 'each' });
}

export async function truncateAll(dataSource: DataSource): Promise<void> {
  await dataSource.query('TRUNCATE TABLE reservations, programs');
}

export async function createProgram(
  dataSource: DataSource,
  overrides: Partial<
    Pick<ProgramEntity, 'id' | 'currency' | 'totalLimitMinor' | 'treasuryVersion'>
  > = {},
): Promise<ProgramEntity> {
  const program = dataSource.manager.create(ProgramEntity, {
    id: 'PRG-TEST',
    currency: 'USD',
    totalLimitMinor: 1_000_000n, // 10,000.00 USD
    treasuryVersion: 0n,
    ...overrides,
  });
  await dataSource.manager.insert(ProgramEntity, program);
  return dataSource.manager.findOneOrFail(ProgramEntity, { where: { id: program.id } });
}
