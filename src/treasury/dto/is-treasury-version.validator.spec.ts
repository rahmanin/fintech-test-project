import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { TreasuryProgramEntryDto } from './treasury-message.dto';
import { parseVersion } from './is-treasury-version.validator';

const entry = (version: unknown) =>
  validateSync(
    plainToInstance(TreasuryProgramEntryDto, {
      programId: 'PRG-1',
      version,
      currency: 'USD',
      totalLimit: '100.00',
    }),
  );

describe('treasury version validation', () => {
  it('accepts a safe JSON integer', () => {
    expect(entry(42)).toHaveLength(0);
    expect(entry(0)).toHaveLength(0);
    expect(entry(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });

  it('accepts a digit string, so large versions survive JSON', () => {
    expect(entry('9007199254740993')).toHaveLength(0);
    expect(parseVersion('9007199254740993')).toBe(9007199254740993n);
  });

  it('rejects a number that lost precision, rather than comparing a wrong value', () => {
    // 2^53 + 1 cannot be represented; JSON.parse already rounded it.
    expect(entry(Number.MAX_SAFE_INTEGER + 2)).not.toHaveLength(0);
    expect(entry(1e20)).not.toHaveLength(0);
  });

  it.each([-1, 1.5, NaN, Infinity, '1.5', '-1', '', 'abc', null, undefined, {}, []])(
    'rejects %j',
    (value) => {
      expect(entry(value)).not.toHaveLength(0);
    },
  );

  it('parses both forms to the same bigint', () => {
    expect(parseVersion(42)).toBe(42n);
    expect(parseVersion('42')).toBe(42n);
  });
});
