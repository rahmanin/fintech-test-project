import { currencyScale } from '../money/currency';
import { formatMinor, pow10 } from '../money/money';
import { InvalidFxRateError } from './fx.errors';

/**
 * Fixed-point FX rate: an integer scaled by 10^10.
 *
 * Why not a JS number: JSON.parse and parseFloat produce IEEE doubles, and
 * 1.1 becomes 1.1000000000000001. Multiplying an exact bigint amount by an
 * inexact double would defeat the point of storing money as integers. A rate
 * with a fixed denominator (10^10) is a rational number that bigint
 * arithmetic handles exactly; NUMERIC(20,10) in Postgres round-trips it as a
 * string with no loss.
 */
export const FX_RATE_SCALE = 10;
export const FX_RATE_ONE = pow10(FX_RATE_SCALE);

const RATE_PATTERN = /^\d+(\.\d+)?$/;

export class FxRate {
  private constructor(
    readonly from: string,
    readonly to: string,
    /** rate × 10^10 */
    readonly scaled: bigint,
  ) {}

  /** Parse "1.0800" into a scaled bigint. Rejects zero, negatives, exponents, >10 decimals. */
  static parse(from: string, to: string, input: string): FxRate {
    currencyScale(from);
    currencyScale(to);
    if (!RATE_PATTERN.test(input)) throw new InvalidFxRateError(input, 'expected a decimal string');
    const [whole, fraction = ''] = input.split('.');
    if (fraction.length > FX_RATE_SCALE) {
      throw new InvalidFxRateError(input, `more than ${FX_RATE_SCALE} decimals`);
    }
    const scaled = BigInt(whole) * FX_RATE_ONE + BigInt(fraction.padEnd(FX_RATE_SCALE, '0') || '0');
    if (scaled <= 0n) throw new InvalidFxRateError(input, 'must be greater than zero');
    return new FxRate(from, to, scaled);
  }

  /** Same-currency conversion is always exactly 1. */
  static identity(currency: string): FxRate {
    currencyScale(currency);
    return new FxRate(currency, currency, FX_RATE_ONE);
  }

  /** Reconstruct from a NUMERIC(20,10) column value (a string from the driver). */
  static fromStored(from: string, to: string, stored: string): FxRate {
    return FxRate.parse(from, to, stored);
  }

  /** Decimal string with exactly 10 decimals, matching NUMERIC(20,10). */
  toString(): string {
    return formatMinor(this.scaled, FX_RATE_SCALE);
  }
}
