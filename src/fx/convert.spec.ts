import { Money, PG_BIGINT_MAX } from '../money/money';
import { AmountOutOfRangeError, CurrencyMismatchError } from '../money/money.errors';
import { convert, divideRoundHalfUp } from './convert';
import { FxRate } from './fx-rate';

describe('divideRoundHalfUp', () => {
  it('rounds down below half, up at half and above', () => {
    expect(divideRoundHalfUp(10n, 4n)).toBe(3n); // 2.5 → 3
    expect(divideRoundHalfUp(9n, 4n)).toBe(2n); // 2.25 → 2
    expect(divideRoundHalfUp(11n, 4n)).toBe(3n); // 2.75 → 3
    expect(divideRoundHalfUp(8n, 4n)).toBe(2n); // exact
    expect(divideRoundHalfUp(1n, 3n)).toBe(0n); // 0.33 → 0
  });
});

describe('convert', () => {
  it('EUR → USD at 1.08: 1000.00 EUR = 1080.00 USD', () => {
    const out = convert(Money.parse('1000.00', 'EUR'), FxRate.parse('EUR', 'USD', '1.08'));
    expect(out.format()).toBe('1080.00');
    expect(out.currency).toBe('USD');
  });

  it('JPY → USD (scale 0 → 2): 100000 JPY at 0.0067 = 670.00 USD', () => {
    const out = convert(Money.parse('100000', 'JPY'), FxRate.parse('JPY', 'USD', '0.0067'));
    expect(out.format()).toBe('670.00');
  });

  it('USD → JPY (scale 2 → 0) yields a whole number of yen', () => {
    const out = convert(Money.parse('10.00', 'USD'), FxRate.parse('USD', 'JPY', '149.25'));
    expect(out.format()).toBe('1493'); // 1492.5 → half-up → 1493
  });

  it('rounds half-up to the target minor unit', () => {
    // 1.005 USD exactly: 1.00 × 1.005 = 1.005 → 1.01
    expect(convert(Money.parse('1.00', 'EUR'), FxRate.parse('EUR', 'USD', '1.005')).format()).toBe(
      '1.01',
    );
    // 1.0049 → 1.00
    expect(convert(Money.parse('1.00', 'EUR'), FxRate.parse('EUR', 'USD', '1.0049')).format()).toBe(
      '1.00',
    );
  });

  it('identity rate returns the same minor units', () => {
    const out = convert(Money.parse('123.45', 'USD'), FxRate.identity('USD'));
    expect(out.minor).toBe(12345n);
  });

  it('can round to zero for tiny amounts (rejecting that is a business rule)', () => {
    const out = convert(Money.parse('1', 'JPY'), FxRate.parse('JPY', 'USD', '0.0040'));
    expect(out.isZero()).toBe(true);
  });

  it('is exact for values where floating point would drift', () => {
    // 0.1 + 0.2 style: 3 × 1.1 in doubles is 3.3000000000000003
    const out = convert(Money.parse('3.00', 'EUR'), FxRate.parse('EUR', 'USD', '1.1'));
    expect(out.format()).toBe('3.30');
  });

  it('rejects an amount whose currency does not match the rate', () => {
    expect(() => convert(Money.parse('1.00', 'USD'), FxRate.parse('EUR', 'USD', '1.08'))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('rejects a result outside the BIGINT range', () => {
    const max = Money.fromMinor(PG_BIGINT_MAX, 'EUR');
    expect(() => convert(max, FxRate.parse('EUR', 'USD', '1.08'))).toThrow(AmountOutOfRangeError);
  });
});
