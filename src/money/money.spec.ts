import { Money, PG_BIGINT_MAX, formatMinor } from './money';
import {
  AmountOutOfRangeError,
  CurrencyMismatchError,
  InvalidAmountFormatError,
  InvalidAmountScaleError,
  UnsupportedCurrencyError,
} from './money.errors';

describe('Money.parse', () => {
  it('parses a two-decimal currency into minor units', () => {
    const m = Money.parse('1234.56', 'USD');
    expect(m.minor).toBe(123456n);
    expect(m.currency).toBe('USD');
  });

  it('pads a short fraction and accepts a whole number', () => {
    expect(Money.parse('10.5', 'USD').minor).toBe(1050n);
    expect(Money.parse('10', 'USD').minor).toBe(1000n);
    expect(Money.parse('0', 'USD').minor).toBe(0n);
  });

  it('parses a zero-decimal currency', () => {
    expect(Money.parse('12500', 'JPY').minor).toBe(12500n);
  });

  it('rejects more decimals than the currency allows, without rounding', () => {
    expect(() => Money.parse('10.005', 'USD')).toThrow(InvalidAmountScaleError);
    expect(() => Money.parse('100.5', 'JPY')).toThrow(InvalidAmountScaleError);
  });

  it.each(['', ' 10', '10 ', '-5', '+5', '1e3', '1,000.00', '10.', '.5', 'abc', '0x10'])(
    'rejects malformed input %j',
    (input) => {
      expect(() => Money.parse(input, 'USD')).toThrow(InvalidAmountFormatError);
    },
  );

  it('rejects an unsupported currency', () => {
    expect(() => Money.parse('1.00', 'XXX')).toThrow(UnsupportedCurrencyError);
    expect(() => Money.parse('1.00', 'usd')).toThrow(UnsupportedCurrencyError);
  });

  it('accepts the BIGINT maximum and rejects one minor unit more', () => {
    // 9223372036854775807 minor units = 92233720368547758.07 USD
    expect(Money.parse('92233720368547758.07', 'USD').minor).toBe(PG_BIGINT_MAX);
    expect(() => Money.parse('92233720368547758.08', 'USD')).toThrow(AmountOutOfRangeError);
  });
});

describe('Money.format', () => {
  it('always prints the currency scale', () => {
    expect(Money.parse('1080', 'USD').format()).toBe('1080.00');
    expect(Money.parse('0.05', 'USD').format()).toBe('0.05');
    expect(Money.parse('12500', 'JPY').format()).toBe('12500');
    expect(Money.fromMinor(0n, 'EUR').format()).toBe('0.00');
  });

  it('round-trips parse → format', () => {
    for (const s of ['0.00', '0.01', '999999.99', '1.00']) {
      expect(Money.parse(s, 'USD').format()).toBe(s);
    }
  });

  it('formats negative minor units (available after a limit cut)', () => {
    expect(formatMinor(-150n, 2)).toBe('-1.50');
    expect(formatMinor(-5n, 2)).toBe('-0.05');
    expect(formatMinor(-7n, 0)).toBe('-7');
  });
});

describe('Money arithmetic', () => {
  const usd = (s: string) => Money.parse(s, 'USD');

  it('adds and subtracts in the same currency', () => {
    expect(usd('10.00').add(usd('0.50')).format()).toBe('10.50');
    expect(usd('10.00').subtract(usd('12.00')).format()).toBe('-2.00');
  });

  it('refuses to mix currencies', () => {
    const eur = Money.parse('1.00', 'EUR');
    expect(() => usd('1.00').add(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd('1.00').subtract(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd('1.00').compare(eur)).toThrow(CurrencyMismatchError);
  });

  it('compares', () => {
    expect(usd('1.00').compare(usd('2.00'))).toBe(-1);
    expect(usd('2.00').compare(usd('2.00'))).toBe(0);
    expect(usd('3.00').compare(usd('2.00'))).toBe(1);
    expect(usd('0').isZero()).toBe(true);
    expect(usd('0.01').isPositive()).toBe(true);
  });

  it('detects overflow on add', () => {
    const max = Money.fromMinor(PG_BIGINT_MAX, 'USD');
    expect(() => max.add(usd('0.01'))).toThrow(AmountOutOfRangeError);
  });

  it('fromMinor validates range and currency', () => {
    expect(() => Money.fromMinor(PG_BIGINT_MAX + 1n, 'USD')).toThrow(AmountOutOfRangeError);
    expect(() => Money.fromMinor(1n, 'ZZZ')).toThrow(UnsupportedCurrencyError);
  });
});
