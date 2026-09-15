import { CURRENCY_CODE_PATTERN, currencyScale } from '../money/currency';
import { MoneyError } from '../money/money.errors';
import { FxRate } from './fx-rate';
import { FxRateProvider } from './fx-rate.provider';
import { InvalidFxConfigError, UnsupportedCurrencyPairError } from './fx.errors';

const PAIR_PATTERN = /^([A-Z]{3})\/([A-Z]{3})$/;

/**
 * Rates from configuration, e.g. FX_RATES='{"EUR/USD":"1.0800","USD/EUR":"0.9259"}'.
 *
 * Rules, all enforced at construction so a bad config fails the process at boot:
 * - values must be strings (a JSON number is already a double, see FxRate);
 * - keys are "FROM/TO" with supported currencies;
 * - each direction is configured explicitly, nothing is derived. Deriving
 *   USD/EUR as 1 / EUR/USD would round the rate itself and then freeze that
 *   rounded value on reservations, so a round trip would not close;
 * - X/X is always 1 and must not be configured.
 */
export class StaticFxRateProvider extends FxRateProvider {
  private readonly rates: ReadonlyMap<string, FxRate>;

  constructor(rates: Iterable<FxRate>) {
    super();
    const map = new Map<string, FxRate>();
    for (const rate of rates) map.set(`${rate.from}/${rate.to}`, rate);
    this.rates = map;
  }

  static fromJson(json: string): StaticFxRateProvider {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new InvalidFxConfigError('not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidFxConfigError('expected an object of "FROM/TO": "rate"');
    }

    const rates: FxRate[] = [];
    for (const [pair, value] of Object.entries(parsed as Record<string, unknown>)) {
      const match = PAIR_PATTERN.exec(pair);
      if (!match) throw new InvalidFxConfigError(`key "${pair}" is not of the form FROM/TO`);
      const [, from, to] = match;
      if (from === to)
        throw new InvalidFxConfigError(`"${pair}" must not be configured; X/X is always 1`);
      if (typeof value !== 'string') {
        throw new InvalidFxConfigError(`rate for "${pair}" must be a string, got ${typeof value}`);
      }
      try {
        rates.push(FxRate.parse(from, to, value));
      } catch (err) {
        if (err instanceof MoneyError) throw new InvalidFxConfigError(`"${pair}": ${err.message}`);
        throw err;
      }
    }
    return new StaticFxRateProvider(rates);
  }

  // async so that every failure, including a synchronous throw from
  // currencyScale(), surfaces as a rejected promise, never as a sync throw
  // that bypasses the caller's await/catch.
  // eslint-disable-next-line @typescript-eslint/require-await -- intentional, see above
  async getRate(from: string, to: string): Promise<FxRate> {
    if (!CURRENCY_CODE_PATTERN.test(from) || !CURRENCY_CODE_PATTERN.test(to)) {
      throw new UnsupportedCurrencyPairError(from, to);
    }
    currencyScale(from);
    currencyScale(to);
    if (from === to) return FxRate.identity(from);
    const rate = this.rates.get(`${from}/${to}`);
    if (!rate) throw new UnsupportedCurrencyPairError(from, to);
    return rate;
  }
}
