import { FX_RATE_ONE, FxRate } from './fx-rate';
import { InvalidFxRateError } from './fx.errors';
import { UnsupportedCurrencyError } from '../money/money.errors';

describe('FxRate.parse', () => {
  it('scales the rate by 10^10 exactly', () => {
    expect(FxRate.parse('EUR', 'USD', '1.08').scaled).toBe(10_800_000_000n);
    expect(FxRate.parse('JPY', 'USD', '0.0067').scaled).toBe(67_000_000n);
    expect(FxRate.parse('USD', 'JPY', '149.25').scaled).toBe(1_492_500_000_000n);
  });

  it('accepts exactly 10 decimals and rejects 11', () => {
    expect(FxRate.parse('EUR', 'USD', '1.0000000001').scaled).toBe(FX_RATE_ONE + 1n);
    expect(() => FxRate.parse('EUR', 'USD', '1.00000000001')).toThrow(InvalidFxRateError);
  });

  it.each(['0', '0.0', '-1.08', '1e-2', '', 'abc', '1,08'])('rejects %j', (input) => {
    expect(() => FxRate.parse('EUR', 'USD', input)).toThrow(InvalidFxRateError);
  });

  it('rejects unsupported currencies', () => {
    expect(() => FxRate.parse('EUR', 'XXX', '1.0')).toThrow(UnsupportedCurrencyError);
  });

  it('formats with exactly 10 decimals, matching NUMERIC(20,10)', () => {
    expect(FxRate.parse('EUR', 'USD', '1.08').toString()).toBe('1.0800000000');
    expect(FxRate.identity('USD').toString()).toBe('1.0000000000');
  });

  it('round-trips through the stored string form', () => {
    const original = FxRate.parse('GBP', 'USD', '1.2700');
    const restored = FxRate.fromStored('GBP', 'USD', original.toString());
    expect(restored.scaled).toBe(original.scaled);
  });
});
