import { CapacityService, TreasuryApplyOutcome } from '../programs/capacity.service';
import { ProgramCurrencyMismatchError } from '../programs/programs.errors';
import { UnsupportedCurrencyError } from '../money/money.errors';
import { InvalidTreasuryMessageError } from './treasury.errors';
import { TreasuryService } from './treasury.service';

/** Capacity is stubbed here: this suite is about parsing, validation and dispatch. */
type Entry = Parameters<CapacityService['applyTreasuryCapacity']>[0];

function makeService(outcome: (n: number) => TreasuryApplyOutcome | Error = () => 'UPDATED') {
  const calls: Entry[] = [];
  let n = 0;
  const apply = jest.fn((entry: Entry) => {
    calls.push(entry);
    const result = outcome(n++);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const capacity = { applyTreasuryCapacity: apply } as unknown as CapacityService;
  return { service: new TreasuryService(capacity), apply, calls };
}

const update = (over: Record<string, unknown> = {}) => ({
  eventId: 'evt-1',
  type: 'CAPACITY_UPDATED',
  occurredAt: '2026-09-15T10:00:00Z',
  payload: { programId: 'PRG-1', version: 5, currency: 'USD', totalLimit: '9000000.00', ...over },
});

const snapshot = (programs: unknown[]) => ({
  eventId: 'evt-2',
  type: 'PROGRAM_SNAPSHOT',
  occurredAt: '2026-09-15T10:00:00Z',
  programs,
});

describe('TreasuryService.handleMessage', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  describe('envelope validation (before any DB access)', () => {
    it.each([
      ['null', null],
      ['an array', []],
      ['a string', 'hello'],
      ['an unknown type', { type: 'SOMETHING_ELSE', payload: {} }],
      ['a missing type', { payload: {} }],
      ['CAPACITY_UPDATED without payload', { type: 'CAPACITY_UPDATED' }],
      ['PROGRAM_SNAPSHOT without programs', { type: 'PROGRAM_SNAPSHOT' }],
    ])('rejects %s', async (_label, raw) => {
      const { service, apply } = makeService();
      await expect(service.handleMessage(raw)).rejects.toBeInstanceOf(InvalidTreasuryMessageError);
      expect(apply).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty programId', { programId: '' }],
      ['a lowercase currency', { currency: 'usd' }],
      ['a negative limit', { totalLimit: '-1.00' }],
      ['a numeric limit', { totalLimit: 9000000 }],
      ['an unsafe version', { version: 1e20 }],
    ])('rejects an entry with %s', async (_label, over) => {
      const { service, apply } = makeService();
      await expect(service.handleMessage(update(over))).rejects.toBeInstanceOf(
        InvalidTreasuryMessageError,
      );
      expect(apply).not.toHaveBeenCalled();
    });

    it('ignores unknown envelope fields instead of failing', async () => {
      const { service } = makeService();
      await expect(
        service.handleMessage({ ...update(), producedBy: 'treasury-v3' }),
      ).resolves.toMatchObject({ applied: 1 });
    });
  });

  describe('dispatch', () => {
    it('applies a single update and converts the version to bigint', async () => {
      const { service, calls } = makeService();
      const result = await service.handleMessage(update());
      expect(result).toEqual({ entries: 1, applied: 1, skipped: 0, invalid: 0 });
      expect(calls[0]).toEqual({
        programId: 'PRG-1',
        version: 5n,
        currency: 'USD',
        totalLimit: '9000000.00',
      });
    });

    it('accepts a version sent as a digit string', async () => {
      const { service, calls } = makeService();
      await service.handleMessage(update({ version: '9007199254740993' }));
      expect(calls[0].version).toBe(9007199254740993n);
    });

    it('applies every entry of a bulk snapshot, each on its own', async () => {
      const { service, calls } = makeService();
      const result = await service.handleMessage(
        snapshot([
          { programId: 'PRG-1', version: 6, currency: 'USD', totalLimit: '1.00' },
          { programId: 'PRG-2', version: 1, currency: 'EUR', totalLimit: '2.00' },
        ]),
      );
      expect(result).toEqual({ entries: 2, applied: 2, skipped: 0, invalid: 0 });
      expect(calls.map((c) => c.programId)).toEqual(['PRG-1', 'PRG-2']);
    });

    it('treats an empty snapshot as a valid no-op', async () => {
      const { service, apply } = makeService();
      await expect(service.handleMessage(snapshot([]))).resolves.toEqual({
        entries: 0,
        applied: 0,
        skipped: 0,
        invalid: 0,
      });
      expect(apply).not.toHaveBeenCalled();
    });

    it('counts a stale entry as skipped, not applied', async () => {
      const { service } = makeService(() => 'SKIPPED_STALE');
      await expect(service.handleMessage(update())).resolves.toMatchObject({
        applied: 0,
        skipped: 1,
      });
    });
  });

  describe('error policy', () => {
    it('skips a permanently invalid entry and still applies the rest', async () => {
      // Entry 0 fails on an unsupported currency; entries 1 and 2 must proceed.
      const { service } = makeService((n) =>
        n === 0 ? new UnsupportedCurrencyError('XXX') : 'UPDATED',
      );
      const result = await service.handleMessage(
        snapshot([
          { programId: 'PRG-1', version: 1, currency: 'USD', totalLimit: '1.00' },
          { programId: 'PRG-2', version: 1, currency: 'USD', totalLimit: '2.00' },
          { programId: 'PRG-3', version: 1, currency: 'USD', totalLimit: '3.00' },
        ]),
      );
      expect(result).toEqual({ entries: 3, applied: 2, skipped: 0, invalid: 1 });
    });

    it('skips an entry whose currency contradicts the stored program', async () => {
      const { service } = makeService(
        () => new ProgramCurrencyMismatchError('PRG-1', 'USD', 'EUR'),
      );
      await expect(service.handleMessage(update({ currency: 'EUR' }))).resolves.toMatchObject({
        invalid: 1,
      });
    });

    it('propagates a database failure so the offset is not committed', async () => {
      const { service } = makeService((n) =>
        n === 1 ? new Error('connection terminated') : 'UPDATED',
      );
      await expect(
        service.handleMessage(
          snapshot([
            { programId: 'PRG-1', version: 1, currency: 'USD', totalLimit: '1.00' },
            { programId: 'PRG-2', version: 1, currency: 'USD', totalLimit: '2.00' },
          ]),
        ),
      ).rejects.toThrow('connection terminated');
    });
  });

  describe('heartbeat', () => {
    it('beats every 50 entries so a long batch does not trigger a rebalance', async () => {
      const { service } = makeService();
      const heartbeat = jest.fn().mockResolvedValue(undefined);
      const programs = Array.from({ length: 120 }, (_, i) => ({
        programId: `PRG-${i}`,
        version: 1,
        currency: 'USD',
        totalLimit: '1.00',
      }));
      await service.handleMessage(snapshot(programs), heartbeat);
      expect(heartbeat).toHaveBeenCalledTimes(2); // after entry 50 and entry 100
    });

    it('works without a heartbeat callback', async () => {
      const { service } = makeService();
      await expect(service.handleMessage(update())).resolves.toMatchObject({ applied: 1 });
    });
  });
});
