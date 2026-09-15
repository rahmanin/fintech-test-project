/**
 * Business-rule failures. Each has a stable `code` that the HTTP layer maps
 * to a status; `details` is safe to return to the client.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProgramNotFoundError extends DomainError {
  readonly code = 'PROGRAM_NOT_FOUND';
  constructor(programId: string) {
    super(`Program ${programId} not found`, { programId });
  }
}

export class ReservationNotFoundError extends DomainError {
  readonly code = 'RESERVATION_NOT_FOUND';
  constructor(programId: string, invoiceId: string) {
    super(`No reservation for invoice ${invoiceId} in program ${programId}`, {
      programId,
      invoiceId,
    });
  }
}

export class InsufficientCapacityError extends DomainError {
  readonly code = 'INSUFFICIENT_CAPACITY';
  constructor(programId: string, requested: string, available: string, currency: string) {
    super(
      `Program ${programId}: requested ${requested} ${currency}, available ${available} ${currency}`,
      { programId, requested, available, currency },
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(invoiceId: string, existingAmount: string, existingCurrency: string) {
    super(
      `Invoice ${invoiceId} is already reserved with a different amount (${existingAmount} ${existingCurrency})`,
      { invoiceId, existingAmount, existingCurrency },
    );
  }
}

export class AmountTooSmallError extends DomainError {
  readonly code = 'AMOUNT_TOO_SMALL';
  constructor(invoiceId: string, programCurrency: string) {
    super(`Invoice ${invoiceId} converts to zero ${programCurrency} after rounding`, {
      invoiceId,
      programCurrency,
    });
  }
}

/**
 * A treasury message claims a different currency than the program we hold.
 * Refused rather than applied: existing reservations are stored converted
 * into the program currency, so changing it would make them meaningless.
 */
export class ProgramCurrencyMismatchError extends DomainError {
  readonly code = 'PROGRAM_CURRENCY_MISMATCH';
  constructor(programId: string, expected: string, received: string) {
    super(`Program ${programId} is denominated in ${expected}; message says ${received}`, {
      programId,
      expected,
      received,
    });
  }
}
