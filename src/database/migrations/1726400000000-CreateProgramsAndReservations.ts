import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two tables, no enums, no counters (PLAN.md §5).
 *
 * - Money columns are BIGINT minor units; CHECK constraints are the last line
 *   of defence behind DTO and business validation.
 * - reservations has a composite PK (program_id, invoice_id): one reservation
 *   per invoice per program, and the idempotency safety net if anything ever
 *   bypasses the row-lock path.
 * - released_at NULL means active; the partial index serves the SUM over
 *   active reservations that every capacity check runs.
 */
export class CreateProgramsAndReservations1726400000000 implements MigrationInterface {
  name = 'CreateProgramsAndReservations1726400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE programs (
        id                TEXT        PRIMARY KEY,
        currency          CHAR(3)     NOT NULL,
        total_limit_minor BIGINT      NOT NULL CHECK (total_limit_minor >= 0),
        treasury_version  BIGINT      NOT NULL CHECK (treasury_version >= 0),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE reservations (
        program_id            TEXT           NOT NULL REFERENCES programs(id),
        invoice_id            TEXT           NOT NULL,
        invoice_amount_minor  BIGINT         NOT NULL CHECK (invoice_amount_minor > 0),
        invoice_currency      CHAR(3)        NOT NULL,
        fx_rate               NUMERIC(20,10) NOT NULL CHECK (fx_rate > 0),
        reserved_amount_minor BIGINT         NOT NULL CHECK (reserved_amount_minor > 0),
        created_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
        released_at           TIMESTAMPTZ    NULL,
        PRIMARY KEY (program_id, invoice_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX reservations_active_by_program
        ON reservations (program_id) WHERE released_at IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE reservations`);
    await queryRunner.query(`DROP TABLE programs`);
  }
}
