/** A message or entry that can never succeed: skipped and logged, never retried. */
export class InvalidTreasuryMessageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'InvalidTreasuryMessageError';
  }
}
