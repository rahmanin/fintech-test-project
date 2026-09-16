import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, Not } from 'typeorm';
import { convert } from '../fx/convert';
import { FxRateProvider } from '../fx/fx-rate.provider';
import { Money } from '../money/money';
import { ProgramEntity } from './program.entity';
import {
  AmountTooSmallError,
  IdempotencyConflictError,
  InsufficientCapacityError,
  ProgramCurrencyMismatchError,
  ProgramNotFoundError,
  ReservationNotFoundError,
} from './programs.errors';
import { ReservationEntity, ReservationStatus } from './reservation.entity';

export interface ReserveCommand {
  programId: string;
  invoiceId: string;
  /** Decimal string, e.g. "1000.00". */
  amount: string;
  currency: string;
}

export interface ReserveResult {
  reservation: ReservationEntity;
  /** false = idempotent replay of an existing reservation. */
  created: boolean;
  /** Currency of reservedAmountMinor (the program's). */
  programCurrency: string;
}

export interface ReleaseResult {
  reservation: ReservationEntity;
  /** false = it was already released. */
  changed: boolean;
  programCurrency: string;
}

export interface ReservationList {
  programCurrency: string;
  reservations: ReservationEntity[];
}

/** One program's absolute capacity state from treasury. */
export interface TreasuryCapacityEntry {
  programId: string;
  version: bigint;
  currency: string;
  /** Decimal string in the program currency. */
  totalLimit: string;
}

export type TreasuryApplyOutcome = 'CREATED' | 'UPDATED' | 'SKIPPED_STALE';

export interface ProgramView {
  id: string;
  currency: string;
  totalLimit: Money;
  reserved: Money;
  /** May be negative after a treasury limit cut (PLAN.md A9). */
  available: Money;
  treasuryVersion: bigint;
  createdAt: Date;
}

interface ProgramRow {
  id: string;
  currency: string;
  total_limit_minor: string;
  treasury_version: string;
  created_at: Date;
  reserved_minor: string;
}

/**
 * The capacity ledger. Every write path runs inside one transaction that
 * starts by locking the program row (`SELECT ... FOR UPDATE`). Postgres then
 * serialises all writers of that program, so "check capacity, then insert"
 * cannot interleave with another writer's "check capacity, then insert".
 *
 * Rule: inside a transaction, every query goes through the transactional
 * EntityManager passed to the callback. An injected repository would use a
 * different pooled connection, outside the transaction, and the row lock
 * would silently not apply to it.
 */
@Injectable()
export class CapacityService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly fx: FxRateProvider,
  ) {}

  async reserve(cmd: ReserveCommand): Promise<ReserveResult> {
    // Pure input validation before taking any lock: format, scale, range.
    const invoiceAmount = Money.parse(cmd.amount, cmd.currency);

    return this.dataSource.transaction(async (manager) => {
      const program = await this.lockProgram(manager, cmd.programId);

      // Idempotency, decided under the lock so two concurrent replays cannot
      // both pass this check. The composite PK is the safety net behind it.
      const existing = await manager.findOne(ReservationEntity, {
        where: { programId: cmd.programId, invoiceId: cmd.invoiceId },
      });
      if (existing) {
        const sameRequest =
          existing.invoiceAmountMinor === invoiceAmount.minor &&
          existing.invoiceCurrency === cmd.currency;
        if (sameRequest) {
          return { reservation: existing, created: false, programCurrency: program.currency };
        }
        throw new IdempotencyConflictError(
          cmd.invoiceId,
          Money.fromMinor(existing.invoiceAmountMinor, existing.invoiceCurrency).format(),
          existing.invoiceCurrency,
        );
      }

      // Rate is looked up now and frozen on the row (PLAN.md A4). Release
      // never converts again, so what is subtracted is exactly what comes back.
      const rate = await this.fx.getRate(cmd.currency, program.currency);
      const reserved = convert(invoiceAmount, rate);
      if (reserved.isZero()) throw new AmountTooSmallError(cmd.invoiceId, program.currency);

      const reservedSum = await this.sumActive(manager, program.id);
      const available = program.totalLimitMinor - reservedSum;
      if (reserved.minor > available) {
        throw new InsufficientCapacityError(
          program.id,
          reserved.format(),
          Money.fromMinor(available, program.currency).format(),
          program.currency,
        );
      }

      const reservation = manager.create(ReservationEntity, {
        programId: program.id,
        invoiceId: cmd.invoiceId,
        invoiceAmountMinor: invoiceAmount.minor,
        invoiceCurrency: cmd.currency,
        fxRate: rate.toString(),
        reservedAmountMinor: reserved.minor,
        releasedAt: null,
      });
      await manager.insert(ReservationEntity, reservation);
      const saved = await manager.findOneOrFail(ReservationEntity, {
        where: { programId: program.id, invoiceId: cmd.invoiceId },
      });
      return { reservation: saved, created: true, programCurrency: program.currency };
    });
  }

  async release(programId: string, invoiceId: string): Promise<ReleaseResult> {
    return this.dataSource.transaction(async (manager) => {
      // The lock is needed here too: a concurrent reserve() computes
      // SUM(active) under the same lock, so a release must not change the
      // set of active rows while that computation is in flight.
      const program = await this.lockProgram(manager, programId);

      const reservation = await manager.findOne(ReservationEntity, {
        where: { programId, invoiceId },
      });
      if (!reservation) throw new ReservationNotFoundError(programId, invoiceId);
      if (reservation.releasedAt !== null) {
        return { reservation, changed: false, programCurrency: program.currency };
      }

      await manager.update(ReservationEntity, { programId, invoiceId }, { releasedAt: new Date() });
      const updated = await manager.findOneOrFail(ReservationEntity, {
        where: { programId, invoiceId },
      });
      return { reservation: updated, changed: true, programCurrency: program.currency };
    });
  }

  /**
   * Read path. One SQL statement so the limit and the sum come from the same
   * snapshot; two separate queries could straddle a committed treasury
   * update. No lock, no transaction.
   */
  async getProgram(programId: string): Promise<ProgramView> {
    const rows = await this.dataSource.query<ProgramRow[]>(
      `SELECT p.id, p.currency, p.total_limit_minor, p.treasury_version, p.created_at,
              COALESCE((SELECT SUM(r.reserved_amount_minor)
                          FROM reservations r
                         WHERE r.program_id = p.id AND r.released_at IS NULL), 0) AS reserved_minor
         FROM programs p
        WHERE p.id = $1`,
      [programId],
    );
    const row = rows[0];
    if (!row) throw new ProgramNotFoundError(programId);

    const totalLimit = Money.fromMinor(BigInt(row.total_limit_minor), row.currency);
    const reserved = Money.fromMinor(BigInt(row.reserved_minor), row.currency);
    return {
      id: row.id,
      currency: row.currency,
      totalLimit,
      reserved,
      available: totalLimit.subtract(reserved),
      treasuryVersion: BigInt(row.treasury_version),
      createdAt: row.created_at,
    };
  }

  async listReservations(programId: string, status?: ReservationStatus): Promise<ReservationList> {
    const program = await this.dataSource.manager.findOne(ProgramEntity, {
      where: { id: programId },
    });
    if (!program) throw new ProgramNotFoundError(programId);
    const reservations = await this.dataSource.manager.find(ReservationEntity, {
      where: {
        programId,
        ...(status === 'ACTIVE' ? { releasedAt: IsNull() } : {}),
        ...(status === 'RELEASED' ? { releasedAt: Not(IsNull()) } : {}),
      },
      order: { createdAt: 'ASC', invoiceId: 'ASC' },
    });
    return { programCurrency: program.currency, reservations };
  }

  /**
   * Apply one program's absolute capacity state from treasury.
   *
   * Both message types (a single update and one entry of a bulk snapshot)
   * carry absolute state, so one handler serves both. Each entry runs in its
   * own transaction: a bad or failing entry must not roll back the good ones,
   * and one transaction over a whole batch would hold locks on every program
   * in it, blocking API reservations on unrelated programs.
   *
   * Reservations are never read or written here. Availability is derived at
   * read time, so a limit change needs nothing recomputed.
   */
  async applyTreasuryCapacity(entry: TreasuryCapacityEntry): Promise<TreasuryApplyOutcome> {
    const limit = Money.parse(entry.totalLimit, entry.currency);

    return this.dataSource.transaction(async (manager) => {
      // Upsert first, THEN lock. SELECT ... FOR UPDATE cannot lock a row that
      // does not exist, so two concurrent entries for a brand-new program
      // (a snapshot and an update from different partitions, or one message
      // redelivered to two consumers) would both see "missing" and both
      // insert; the loser would hit the primary key and surface as an error
      // for an entirely expected situation. With ON CONFLICT DO NOTHING
      // Postgres waits for the concurrent uncommitted insert: the winner
      // creates the row, the loser sees it and continues below as if the
      // program had always existed.
      const inserted = await manager
        .createQueryBuilder()
        .insert()
        .into(ProgramEntity)
        .values({
          id: entry.programId,
          currency: entry.currency,
          totalLimitMinor: limit.minor,
          treasuryVersion: entry.version,
        })
        .orIgnore()
        .returning('id')
        .execute();
      // RETURNING yields a row only when the insert actually happened, so an
      // empty `raw` means the row already existed. `identifiers` must NOT be
      // used here: TypeORM echoes back the values that were passed in, so it
      // is non-empty even when ON CONFLICT DO NOTHING skipped the insert,
      // which would make every update look like a fresh creation.
      if ((inserted.raw as unknown[]).length > 0) return 'CREATED';

      const program = await this.lockProgram(manager, entry.programId);

      // One check rejects both duplicate deliveries and stale/out-of-order
      // messages. It is correct only because the payload is absolute state:
      // re-applying a version we already hold would be a no-op anyway.
      if (entry.version <= program.treasuryVersion) return 'SKIPPED_STALE';

      // Existing reservations are stored in the program's currency; changing
      // it would make their converted amounts meaningless. TASK.md describes
      // no such scenario, so this is refused rather than guessed at.
      if (program.currency !== entry.currency) {
        throw new ProgramCurrencyMismatchError(entry.programId, program.currency, entry.currency);
      }

      await manager.update(
        ProgramEntity,
        { id: entry.programId },
        { totalLimitMinor: limit.minor, treasuryVersion: entry.version },
      );
      return 'UPDATED';
    });
  }

  /** SELECT ... FOR UPDATE on the program row; the serialisation point for all writers. */
  private async lockProgram(manager: EntityManager, programId: string): Promise<ProgramEntity> {
    const program = await manager
      .createQueryBuilder(ProgramEntity, 'p')
      .setLock('pessimistic_write')
      .where('p.id = :id', { id: programId })
      .getOne();
    if (!program) throw new ProgramNotFoundError(programId);
    return program;
  }

  private async sumActive(manager: EntityManager, programId: string): Promise<bigint> {
    const rows = await manager.query<{ sum: string }[]>(
      `SELECT COALESCE(SUM(reserved_amount_minor), 0) AS sum
         FROM reservations
        WHERE program_id = $1 AND released_at IS NULL`,
      [programId],
    );
    return BigInt(rows[0].sum);
  }
}
