import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Demo data so the service is usable right after `docker compose up`
 * (PLAN.md A8: programs are otherwise created only by treasury messages).
 *
 * treasury_version = 0 means "no treasury message received yet"; the first
 * real message must carry version >= 1. This migration would not exist in a
 * production migration chain.
 */
export class SeedDemoProgram1726400001000 implements MigrationInterface {
  name = 'SeedDemoProgram1726400001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO programs (id, currency, total_limit_minor, treasury_version)
      VALUES ('PRG-DEMO', 'USD', 1000000000, 0)
      ON CONFLICT (id) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM programs WHERE id = 'PRG-DEMO'`);
  }
}
