import { FxRate } from './fx-rate';

/**
 * Source of FX rates. Abstract class (not interface) so it can serve as a
 * Nest injection token. The only implementation in this exercise is static
 * configuration; a table-backed or external provider would implement the
 * same method and nothing else in the codebase would change.
 */
export abstract class FxRateProvider {
  /** Throws UnsupportedCurrencyPairError when no rate exists for from → to. */
  abstract getRate(from: string, to: string): Promise<FxRate>;
}
