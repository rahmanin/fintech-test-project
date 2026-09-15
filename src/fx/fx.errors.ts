import { MoneyError } from '../money/money.errors';

export class InvalidFxRateError extends MoneyError {
  readonly code = 'INVALID_FX_RATE';

  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`Invalid FX rate "${input}": ${reason}`);
  }
}

export class UnsupportedCurrencyPairError extends MoneyError {
  readonly code = 'UNSUPPORTED_CURRENCY';

  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`No FX rate configured for ${from}/${to}`);
  }
}

export class InvalidFxConfigError extends Error {
  constructor(reason: string) {
    super(`Invalid FX_RATES configuration: ${reason}`);
    this.name = 'InvalidFxConfigError';
  }
}
