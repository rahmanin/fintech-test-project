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
}

export interface ReleaseResult {
  reservation: ReservationEntity;
  /** false = it was already released. */
  changed: boolean;
}

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
        if (sameRequest) return { reservation: existing, created: false };
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
      return { reservation: saved, created: true };
    });
  }

  async release(programId: string, invoiceId: string): Promise<ReleaseResult> {
    return this.dataSource.transaction(async (manager) => {
      // The lock is needed here too: a concurrent reserve() computes
      // SUM(active) under the same lock, so a release must not change the
      // set of active rows while that computation is in flight.
      await this.lockProgram(manager, programId);

      const reservation = await manager.findOne(ReservationEntity, {
        where: { programId, invoiceId },
      });
      if (!reservation) throw new ReservationNotFoundError(programId, invoiceId);
      if (reservation.releasedAt !== null) return { reservation, changed: false };

      await manager.update(ReservationEntity, { programId, invoiceId }, { releasedAt: new Date() });
      const updated = await manager.findOneOrFail(ReservationEntity, {
        where: { programId, invoiceId },
      });
      return { reservation: updated, changed: true };
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

  async listReservations(
    programId: string,
    status?: ReservationStatus,
  ): Promise<ReservationEntity[]> {
    const exists = await this.dataSource.manager.exists(ProgramEntity, {
      where: { id: programId },
    });
    if (!exists) throw new ProgramNotFoundError(programId);
    return this.dataSource.manager.find(ReservationEntity, {
      where: {
        programId,
        ...(status === 'ACTIVE' ? { releasedAt: IsNull() } : {}),
        ...(status === 'RELEASED' ? { releasedAt: Not(IsNull()) } : {}),
      },
      order: { createdAt: 'ASC', invoiceId: 'ASC' },
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
