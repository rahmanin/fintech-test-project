import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { CapacityService } from '../src/programs/capacity.service';
import { ProgramEntity } from '../src/programs/program.entity';
import { TreasuryService } from '../src/treasury/treasury.service';
import { createProgram, migrate, truncateAll } from './db';

describe('Treasury capacity handling (integration, real Postgres)', () => {
  let dataSource: DataSource;
  let treasury: TreasuryService;
  let capacity: CapacityService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // KAFKA_ENABLED=false in test/setup-env.ts, so no broker is needed: the
    // handler is exercised directly with message objects.
    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    treasury = moduleRef.get(TreasuryService);
    capacity = moduleRef.get(CapacityService);
    await migrate(dataSource);
  });

  beforeEach(() => truncateAll(dataSource));
  afterAll(() => dataSource.destroy());

  const program = (id: string) => dataSource.manager.findOne(ProgramEntity, { where: { id } });

  const update = (
    programId: string,
    version: number | string,
    totalLimit: string,
    currency = 'USD',
  ) => ({
    eventId: `evt-${programId}-${version}`,
    type: 'CAPACITY_UPDATED',
    occurredAt: new Date().toISOString(),
    payload: { programId, version, currency, totalLimit },
  });

  const snapshot = (
    entries: { programId: string; version: number; totalLimit: string; currency?: string }[],
  ) => ({
    eventId: 'evt-snapshot',
    type: 'PROGRAM_SNAPSHOT',
    occurredAt: new Date().toISOString(),
    programs: entries.map((e) => ({ currency: 'USD', ...e })),
  });

  describe('creating and updating programs', () => {
    it('creates a program that does not exist locally, with no reservations', async () => {
      await treasury.handleMessage(update('PRG-NEW', 1, '5000000.00'));
      const created = await program('PRG-NEW');
      expect(created).toMatchObject({
        currency: 'USD',
        totalLimitMinor: 500_000_000n,
        treasuryVersion: 1n,
      });
      const view = await capacity.getProgram('PRG-NEW');
      expect(view.reserved.isZero()).toBe(true);
      expect(view.available.format()).toBe('5000000.00');
    });

    it('updates the limit of an existing program and bumps the version', async () => {
      await createProgram(dataSource, {
        id: 'PRG-A',
        totalLimitMinor: 1_000_000n,
        treasuryVersion: 3n,
      });
      await treasury.handleMessage(update('PRG-A', 4, '8000.00'));
      expect(await program('PRG-A')).toMatchObject({
        totalLimitMinor: 800_000n,
        treasuryVersion: 4n,
      });
    });

    it('leaves reservations untouched; availability follows the new limit', async () => {
      await createProgram(dataSource, {
        id: 'PRG-A',
        totalLimitMinor: 1_000_000n,
        treasuryVersion: 1n,
      });
      await capacity.reserve({
        programId: 'PRG-A',
        invoiceId: 'INV-1',
        amount: '8000.00',
        currency: 'USD',
      });

      await treasury.handleMessage(update('PRG-A', 2, '5000.00'));

      const view = await capacity.getProgram('PRG-A');
      expect(view.totalLimit.format()).toBe('5000.00');
      expect(view.reserved.format()).toBe('8000.00');
      expect(view.available.format()).toBe('-3000.00'); // negative, nothing auto-cancelled
      const { reservations } = await capacity.listReservations('PRG-A', 'ACTIVE');
      expect(reservations).toHaveLength(1);
    });
  });

  describe('idempotency and ordering', () => {
    it('ignores a duplicate delivery of the same version', async () => {
      await treasury.handleMessage(update('PRG-A', 1, '1000.00'));
      const result = await treasury.handleMessage(update('PRG-A', 1, '9999.00'));
      expect(result).toMatchObject({ applied: 0, skipped: 1 });
      expect((await program('PRG-A'))?.totalLimitMinor).toBe(100_000n);
    });

    it('ignores a stale version arriving after a newer one', async () => {
      await treasury.handleMessage(update('PRG-A', 5, '5000.00'));
      await treasury.handleMessage(update('PRG-A', 4, '4000.00'));
      expect(await program('PRG-A')).toMatchObject({
        totalLimitMinor: 500_000n,
        treasuryVersion: 5n,
      });
    });

    it('accepts versions beyond 2^53 sent as digit strings', async () => {
      await treasury.handleMessage(update('PRG-A', '9007199254740993', '1000.00'));
      await treasury.handleMessage(update('PRG-A', '9007199254740992', '2000.00')); // older
      expect(await program('PRG-A')).toMatchObject({
        treasuryVersion: 9007199254740993n,
        totalLimitMinor: 100_000n,
      });
    });

    it('rejects a currency change and keeps the stored program intact', async () => {
      await createProgram(dataSource, { id: 'PRG-A', currency: 'USD', treasuryVersion: 1n });
      const result = await treasury.handleMessage(update('PRG-A', 2, '1000.00', 'EUR'));
      expect(result).toMatchObject({ invalid: 1, applied: 0 });
      expect(await program('PRG-A')).toMatchObject({ currency: 'USD', treasuryVersion: 1n });
    });
  });

  describe('bulk snapshots', () => {
    it('applies every entry, creating and updating in one message', async () => {
      await createProgram(dataSource, { id: 'PRG-A', totalLimitMinor: 100n, treasuryVersion: 1n });
      const result = await treasury.handleMessage(
        snapshot([
          { programId: 'PRG-A', version: 2, totalLimit: '1000.00' },
          { programId: 'PRG-B', version: 1, totalLimit: '2000.00', currency: 'EUR' },
        ]),
      );
      expect(result).toEqual({ entries: 2, applied: 2, skipped: 0, invalid: 0 });
      expect((await program('PRG-A'))?.totalLimitMinor).toBe(100_000n);
      expect(await program('PRG-B')).toMatchObject({ currency: 'EUR', totalLimitMinor: 200_000n });
    });

    it('leaves programs absent from the snapshot untouched', async () => {
      await createProgram(dataSource, {
        id: 'PRG-OLD',
        totalLimitMinor: 777n,
        treasuryVersion: 9n,
      });
      await treasury.handleMessage(
        snapshot([{ programId: 'PRG-A', version: 1, totalLimit: '1.00' }]),
      );
      expect(await program('PRG-OLD')).toMatchObject({
        totalLimitMinor: 777n,
        treasuryVersion: 9n,
      });
    });

    it('skips one invalid entry and still commits the others', async () => {
      const result = await treasury.handleMessage(
        snapshot([
          { programId: 'PRG-A', version: 1, totalLimit: '1000.00' },
          { programId: 'PRG-BAD', version: 1, totalLimit: '10.005' }, // more decimals than USD allows
          { programId: 'PRG-C', version: 1, totalLimit: '3000.00' },
        ]),
      );
      expect(result).toEqual({ entries: 3, applied: 2, skipped: 0, invalid: 1 });
      expect(await program('PRG-A')).not.toBeNull();
      expect(await program('PRG-BAD')).toBeNull();
      expect(await program('PRG-C')).not.toBeNull();
    });

    it('on redelivery after a partial failure, re-applies only what is missing', async () => {
      // First delivery: two entries commit, the third fails mid-batch.
      const entries = [
        { programId: 'PRG-A', version: 1, totalLimit: '1000.00' },
        { programId: 'PRG-B', version: 1, totalLimit: '2000.00' },
        { programId: 'PRG-C', version: 1, totalLimit: '3000.00' },
      ];
      const original = capacity.applyTreasuryCapacity.bind(capacity);
      const spy = jest
        .spyOn(capacity, 'applyTreasuryCapacity')
        .mockImplementationOnce(original)
        .mockImplementationOnce(original)
        .mockImplementationOnce(() => Promise.reject(new Error('connection terminated')));

      await expect(treasury.handleMessage(snapshot(entries))).rejects.toThrow(
        'connection terminated',
      );
      expect(await program('PRG-A')).not.toBeNull();
      expect(await program('PRG-C')).toBeNull();

      // Redelivery (the offset was never committed): the first two are now
      // skipped as stale, the third is applied.
      spy.mockRestore();
      const replay = await treasury.handleMessage(snapshot(entries));
      expect(replay).toEqual({ entries: 3, applied: 1, skipped: 2, invalid: 0 });
      expect(await program('PRG-C')).not.toBeNull();
    });
  });

  describe('concurrency', () => {
    it('two concurrent entries for the same new program create exactly one row', async () => {
      // SELECT ... FOR UPDATE cannot lock a row that does not exist; the
      // INSERT ... ON CONFLICT DO NOTHING before it is what makes this safe.
      const results = await Promise.allSettled([
        treasury.handleMessage(update('PRG-RACE', 1, '1000.00')),
        treasury.handleMessage(update('PRG-RACE', 2, '2000.00')),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

      const rows = await dataSource.manager.find(ProgramEntity, { where: { id: 'PRG-RACE' } });
      expect(rows).toHaveLength(1);
      // Whichever committed first, the newer version must win in the end.
      expect(rows[0].treasuryVersion).toBe(2n);
      expect(rows[0].totalLimitMinor).toBe(200_000n);
    });

    it('a treasury update and an API reservation serialise on the same row lock', async () => {
      await createProgram(dataSource, {
        id: 'PRG-A',
        totalLimitMinor: 1_000_000n,
        treasuryVersion: 1n,
      });
      await Promise.all([
        treasury.handleMessage(update('PRG-A', 2, '6000.00')),
        capacity.reserve({
          programId: 'PRG-A',
          invoiceId: 'INV-1',
          amount: '5000.00',
          currency: 'USD',
        }),
      ]);
      const view = await capacity.getProgram('PRG-A');
      expect(view.totalLimit.format()).toBe('6000.00');
      expect(view.reserved.format()).toBe('5000.00');
      expect(view.available.format()).toBe('1000.00');
    });
  });
});
