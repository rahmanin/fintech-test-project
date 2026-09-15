import { currencyScale } from '../money/currency';
import { CurrencyMismatchError } from '../money/money.errors';
import { Money, assertBigintRange, pow10 } from '../money/money';
import { FX_RATE_ONE, FxRate } from './fx-rate';

/**
 * Integer division rounded half-up. Both arguments must be non-negative.
 *
 * The rounding decision is made from the exact remainder, so it is
 * deterministic and does not depend on any floating-point intermediate.
 */
export function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

/**
 * Convert an amount into the rate's target currency.
 *
 *   result_minor = round_half_up( amount_minor × rate_scaled × 10^scale_to
 *                                 / (10^10 × 10^scale_from) )
 *
 * Everything stays in bigint; the only rounding happens once, at the end, to
 * the target currency's minor unit (half-up, see PLAN.md A6). The result may
 * round to zero for tiny amounts; rejecting that is a business rule that
 * lives in the reservation flow, not here.
 */
export function convert(amount: Money, rate: FxRate): Money {
  if (amount.currency !== rate.from) throw new CurrencyMismatchError(rate.from, amount.currency);
  if (amount.minor < 0n) throw new RangeError('convert() expects a non-negative amount');

  const scaleFrom = currencyScale(rate.from);
  const scaleTo = currencyScale(rate.to);

  const numerator = amount.minor * rate.scaled * pow10(scaleTo);
  const denominator = FX_RATE_ONE * pow10(scaleFrom);
  const minor = divideRoundHalfUp(numerator, denominator);
  assertBigintRange(minor);
  return Money.fromMinor(minor, rate.to);
}
