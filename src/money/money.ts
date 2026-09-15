import { currencyScale } from './currency';
import {
  AmountOutOfRangeError,
  CurrencyMismatchError,
  InvalidAmountFormatError,
  InvalidAmountScaleError,
} from './money.errors';

/**
 * Postgres BIGINT bounds. Every amount in minor units must fit, otherwise an
 * INSERT would fail with a driver error (a 500 for the API, an endless retry
 * for the Kafka consumer). Checking here turns that into a typed 4xx.
 */
export const PG_BIGINT_MAX = 2n ** 63n - 1n;
export const PG_BIGINT_MIN = -(2n ** 63n);

const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

export function assertBigintRange(value: bigint): void {
  if (value > PG_BIGINT_MAX || value < PG_BIGINT_MIN) throw new AmountOutOfRangeError();
}

export function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/**
 * Immutable monetary amount: an integer number of minor units plus a currency.
 *
 * Why bigint minor units and not a decimal library: amounts are stored as
 * BIGINT in Postgres, compared and summed there, and travel through JSON as
 * strings. Keeping a single integer representation end to end means there is
 * no conversion boundary where a float can sneak in. A decimal library would
 * add a second numeric system and a conversion at every boundary.
 */
export class Money {
  private constructor(
    readonly minor: bigint,
    readonly currency: string,
  ) {}

  /** Build from minor units already known to be in the right scale (DB rows, sums). */
  static fromMinor(minor: bigint, currency: string): Money {
    currencyScale(currency); // validates the currency
    assertBigintRange(minor);
    return new Money(minor, currency);
  }

  /**
   * Parse a decimal string such as "1234.56" into minor units.
   *
   * Rejects: signs, exponents, thousands separators, empty fraction, more
   * decimals than the currency allows ("10.005" USD), and values outside the
   * BIGINT range. It never rounds: an over-precise input is a client error,
   * not something to silently truncate.
   */
  static parse(amount: string, currency: string): Money {
    const scale = currencyScale(currency);
    if (!AMOUNT_PATTERN.test(amount)) throw new InvalidAmountFormatError(amount);

    const [whole, fraction = ''] = amount.split('.');
    if (fraction.length > scale) throw new InvalidAmountScaleError(amount, currency, scale);

    const minor = BigInt(whole) * pow10(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
    assertBigintRange(minor);
    return new Money(minor, currency);
  }

  get scale(): number {
    return currencyScale(this.currency);
  }

  /** Decimal string with exactly the currency's number of decimals, e.g. "1080.00", "12500". */
  format(): string {
    return formatMinor(this.minor, this.scale);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    const sum = this.minor + other.minor;
    assertBigintRange(sum);
    return new Money(sum, this.currency);
  }

  /** May yield a negative amount (e.g. available = limit - reserved after a limit cut). */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const diff = this.minor - other.minor;
    assertBigintRange(diff);
    return new Money(diff, this.currency);
  }

  /** Comparison across currencies is a programming error, never a business result. */
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minor < other.minor) return -1;
    if (this.minor > other.minor) return 1;
    return 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/** Format minor units as a decimal string; handles negative values. */
export function formatMinor(minor: bigint, scale: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const divisor = pow10(scale);
  const whole = (abs / divisor).toString();
  if (scale === 0) return (negative ? '-' : '') + whole;
  const fraction = (abs % divisor).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
