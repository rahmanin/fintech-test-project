/**
 * Typed errors for the money layer. Each carries a stable `code` so the HTTP
 * layer (phase 4) can map it to an API error without string matching.
 */
export abstract class MoneyError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnsupportedCurrencyError extends MoneyError {
  readonly code = 'UNSUPPORTED_CURRENCY';

  constructor(readonly currency: string) {
    super(`Unsupported currency: ${currency}`);
  }
}

export class InvalidAmountFormatError extends MoneyError {
  readonly code = 'INVALID_AMOUNT_FORMAT';

  constructor(readonly input: string) {
    super(
      `Invalid amount format: "${input}" (expected digits with optional fraction, e.g. "1234.56")`,
    );
  }
}

export class InvalidAmountScaleError extends MoneyError {
  readonly code = 'INVALID_AMOUNT_SCALE';

  constructor(
    readonly input: string,
    readonly currency: string,
    readonly maxScale: number,
  ) {
    super(`Amount "${input}" has more decimals than ${currency} allows (${maxScale})`);
  }
}

export class AmountOutOfRangeError extends MoneyError {
  readonly code = 'AMOUNT_OUT_OF_RANGE';

  constructor() {
    super('Amount does not fit the 64-bit integer range in minor units');
  }
}

export class CurrencyMismatchError extends MoneyError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}
