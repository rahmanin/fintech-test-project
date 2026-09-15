import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { CapacityService } from '../src/programs/capacity.service';
import {
  AmountTooSmallError,
  IdempotencyConflictError,
  InsufficientCapacityError,
  ProgramNotFoundError,
  ReservationNotFoundError,
} from '../src/programs/programs.errors';
import { ReservationEntity } from '../src/programs/reservation.entity';
import { InvalidAmountScaleError } from '../src/money/money.errors';
import { UnsupportedCurrencyPairError } from '../src/fx/fx.errors';
import { createProgram, migrate, truncateAll } from './db';

describe('CapacityService (integration, real Postgres)', () => {
  let dataSource: DataSource;
  let service: CapacityService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(CapacityService);
    await migrate(dataSource);
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
    await createProgram(dataSource); // PRG-TEST, USD, limit 10,000.00
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  const reserve = (invoiceId: string, amount: string, currency = 'USD', programId = 'PRG-TEST') =>
    service.reserve({ programId, invoiceId, amount, currency });

  describe('reserve → availability → release round trip', () => {
    it('reserves, reflects availability, releases, and restores availability', async () => {
      const { reservation, created } = await reserve('INV-1', '1500.00');
      expect(created).toBe(true);
      expect(reservation.status).toBe('ACTIVE');
      expect(reservation.reservedAmountMinor).toBe(150_000n);

      let view = await service.getProgram('PRG-TEST');
      expect(view.reserved.format()).toBe('1500.00');
      expect(view.available.format()).toBe('8500.00');

      const released = await service.release('PRG-TEST', 'INV-1');
      expect(released.changed).toBe(true);
      expect(released.reservation.status).toBe('RELEASED');

      view = await service.getProgram('PRG-TEST');
      expect(view.reserved.format()).toBe('0.00');
      expect(view.available.format()).toBe('10000.00');
    });

    it('converts a foreign-currency invoice and freezes the rate on the row', async () => {
      const { reservation } = await reserve('INV-EUR', '1000.00', 'EUR');
      expect(reservation.invoiceAmountMinor).toBe(100_000n);
      expect(reservation.invoiceCurrency).toBe('EUR');
      expect(reservation.fxRate).toBe('1.0800000000');
      expect(reservation.reservedAmountMinor).toBe(108_000n);
      expect((await service.getProgram('PRG-TEST')).reserved.format()).toBe('1080.00');
    });

    it('rejects an unsupported currency pair without touching state', async () => {
      await expect(reserve('INV-GBP', '10.00', 'GBP')).rejects.toBeInstanceOf(
        UnsupportedCurrencyPairError,
      );
      expect((await service.getProgram('PRG-TEST')).reserved.isZero()).toBe(true);
    });

    it('rejects an amount that rounds to zero in the program currency', async () => {
      await expect(reserve('INV-JPY', '1', 'JPY')).rejects.toBeInstanceOf(AmountTooSmallError);
    });

    it('validates the amount before taking any lock', async () => {
      await expect(reserve('INV-X', '10.005')).rejects.toBeInstanceOf(InvalidAmountScaleError);
    });
  });

  describe('idempotency', () => {
    it('replays the same request and returns the existing reservation (created = false)', async () => {
      const first = await reserve('INV-1', '100.00');
      const second = await reserve('INV-1', '100.00');
      expect(second.created).toBe(false);
      expect(second.reservation.createdAt).toEqual(first.reservation.createdAt);
      expect((await service.getProgram('PRG-TEST')).reserved.format()).toBe('100.00');
    });

    it('rejects the same invoice with a different amount or currency', async () => {
      await reserve('INV-1', '100.00');
      await expect(reserve('INV-1', '200.00')).rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(reserve('INV-1', '100.00', 'EUR')).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });

    it('replay after release still returns the released reservation, not a new one', async () => {
      await reserve('INV-1', '100.00');
      await service.release('PRG-TEST', 'INV-1');
      const replay = await reserve('INV-1', '100.00');
      expect(replay.created).toBe(false);
      expect(replay.reservation.status).toBe('RELEASED');
    });

    it('release is idempotent', async () => {
      await reserve('INV-1', '100.00');
      const first = await service.release('PRG-TEST', 'INV-1');
      const second = await service.release('PRG-TEST', 'INV-1');
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.reservation.releasedAt).toEqual(first.reservation.releasedAt);
    });

    it('release of an unknown invoice is 404, not a silent no-op', async () => {
      await expect(service.release('PRG-TEST', 'NOPE')).rejects.toBeInstanceOf(
        ReservationNotFoundError,
      );
    });
  });

  describe('capacity', () => {
    it('rejects a reservation that exceeds available capacity with details', async () => {
      await reserve('INV-1', '9000.00');
      await expect(reserve('INV-2', '1000.01')).rejects.toMatchObject({
        code: 'INSUFFICIENT_CAPACITY',
        details: { requested: '1000.01', available: '1000.00', currency: 'USD' },
      });
      await expect(reserve('INV-3', '1000.00')).resolves.toMatchObject({ created: true });
    });

    it('never oversubscribes under concurrent requests', async () => {
      // 25 parallel reservations of 1,000.00 against a 10,000.00 limit:
      // exactly 10 must succeed, regardless of scheduling.
      const attempts = Array.from({ length: 25 }, (_, i) => reserve(`INV-${i}`, '1000.00'));
      const results = await Promise.allSettled(attempts);

      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(10);
      expect(rejected).toHaveLength(15);
      for (const r of rejected) expect(r.reason).toBeInstanceOf(InsufficientCapacityError);

      const view = await service.getProgram('PRG-TEST');
      expect(view.reserved.format()).toBe('10000.00');
      expect(view.available.format()).toBe('0.00');
    });

    it('interleaved reserve/release under concurrency keeps SUM(active) exact', async () => {
      for (let i = 0; i < 5; i++) await reserve(`INV-${i}`, '1000.00');
      const ops = [
        ...Array.from({ length: 5 }, (_, i) => service.release('PRG-TEST', `INV-${i}`)),
        ...Array.from({ length: 10 }, (_, i) => reserve(`NEW-${i}`, '1000.00')),
      ];
      await Promise.allSettled(ops);
      const view = await service.getProgram('PRG-TEST');
      const { reservations: active } = await service.listReservations('PRG-TEST', 'ACTIVE');
      const sum = active.reduce((acc, r) => acc + r.reservedAmountMinor, 0n);
      expect(view.reserved.minor).toBe(sum);
      expect(view.reserved.minor).toBeLessThanOrEqual(1_000_000n);
    });

    it('limit below reserved: available is negative, new reservations rejected, release works', async () => {
      await reserve('INV-1', '8000.00');
      await dataSource.query(
        `UPDATE programs SET total_limit_minor = 500000 WHERE id = 'PRG-TEST'`,
      );

      const view = await service.getProgram('PRG-TEST');
      expect(view.available.format()).toBe('-3000.00');
      await expect(reserve('INV-2', '0.01')).rejects.toBeInstanceOf(InsufficientCapacityError);

      await service.release('PRG-TEST', 'INV-1');
      expect((await service.getProgram('PRG-TEST')).available.format()).toBe('5000.00');
    });
  });

  describe('reads', () => {
    it('unknown program is not found on every path', async () => {
      await expect(service.getProgram('NOPE')).rejects.toBeInstanceOf(ProgramNotFoundError);
      await expect(reserve('INV-1', '1.00', 'USD', 'NOPE')).rejects.toBeInstanceOf(
        ProgramNotFoundError,
      );
      await expect(service.listReservations('NOPE')).rejects.toBeInstanceOf(ProgramNotFoundError);
    });

    it('lists reservations filtered by derived status', async () => {
      await reserve('INV-A', '1.00');
      await reserve('INV-B', '2.00');
      await service.release('PRG-TEST', 'INV-A');
      const ids = async (status?: 'ACTIVE' | 'RELEASED') =>
        (await service.listReservations('PRG-TEST', status)).reservations.map((r) => r.invoiceId);
      expect(await ids()).toEqual(['INV-A', 'INV-B']);
      expect(await ids('ACTIVE')).toEqual(['INV-B']);
      expect(await ids('RELEASED')).toEqual(['INV-A']);
      expect((await service.listReservations('PRG-TEST')).programCurrency).toBe('USD');
    });
  });

  describe('driver and column types', () => {
    it('pg returns NUMERIC and BIGINT as strings; entities expose bigint', async () => {
      await reserve('INV-1', '1000.00', 'EUR');
      const raw = await dataSource.query<{ fx_rate: unknown; reserved_amount_minor: unknown }[]>(
        `SELECT fx_rate, reserved_amount_minor FROM reservations WHERE invoice_id = 'INV-1'`,
      );
      expect(typeof raw[0].fx_rate).toBe('string');
      expect(typeof raw[0].reserved_amount_minor).toBe('string');

      const entity = await dataSource.manager.findOneOrFail(ReservationEntity, {
        where: { programId: 'PRG-TEST', invoiceId: 'INV-1' },
      });
      expect(typeof entity.reservedAmountMinor).toBe('bigint');
      expect(entity.fxRate).toBe('1.0800000000');
    });

    it('database CHECK constraints reject a zero reservation even if code did not', async () => {
      await expect(
        dataSource.query(
          `INSERT INTO reservations (program_id, invoice_id, invoice_amount_minor, invoice_currency, fx_rate, reserved_amount_minor)
           VALUES ('PRG-TEST', 'BAD', 0, 'USD', 1, 0)`,
        ),
      ).rejects.toThrow(/check constraint/i);
    });
  });
});
