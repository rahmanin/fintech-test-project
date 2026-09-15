import { UnsupportedCurrencyError } from './money.errors';

/**
 * Supported currencies and their minor-unit scale (ISO 4217 exponent).
 *
 * This table is the only place that knows "USD has cents, JPY does not".
 * It is deliberately small: TASK.md does not define a currency list, so the
 * set is "whatever the demo needs", and extending it is a one-line change.
 * A currency missing here is rejected everywhere (API, FX config, treasury
 * messages) rather than guessed at.
 */
const CURRENCY_SCALE: Readonly<Record<string, number>> = Object.freeze({
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
});

export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCY_SCALE, code);
}

export function currencyScale(code: string): number {
  if (!isSupportedCurrency(code)) throw new UnsupportedCurrencyError(code);
  return CURRENCY_SCALE[code];
}

export function supportedCurrencies(): string[] {
  return Object.keys(CURRENCY_SCALE);
}
