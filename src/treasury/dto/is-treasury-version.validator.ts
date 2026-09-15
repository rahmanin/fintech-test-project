import { ValidationArguments, ValidationOptions, registerDecorator } from 'class-validator';

/**
 * Accepts a treasury version as a JSON number or a digit string.
 *
 * Why a custom validator instead of `@Type(() => String)` + a regex: the
 * precision check has to happen on the RAW value. JSON.parse turns
 * 9007199254740993 into 9007199254740992 before any DTO transformation
 * runs, so converting to a string first would hide the loss. A number is
 * therefore accepted only when it is a safe integer; treasury can send
 * larger values losslessly as a decimal string.
 *
 * Failure mode prevented: two distinct versions collapsing into one (or
 * swapping order), which would make the handler skip a real limit change or
 * apply a stale one.
 */
export function IsTreasuryVersion(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isTreasuryVersion',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
          if (typeof value === 'string') return /^\d+$/.test(value);
          return false;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a non-negative integer, as a safe JSON integer or a digit string`;
        },
      },
    });
  };
}

/** Raw version → bigint. Call only on a value that passed IsTreasuryVersion. */
export function parseVersion(value: number | string): bigint {
  return BigInt(value);
}
