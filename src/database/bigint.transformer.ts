import { ValueTransformer } from 'typeorm';

/**
 * Maps Postgres BIGINT columns to JS bigint.
 *
 * Why: the pg driver returns BIGINT as a string (it cannot fit in a double),
 * and TypeORM passes that string through untouched. Without a transformer
 * every money column would be a string that silently concatenates on `+`.
 * With it, entity properties are real bigint values and the type system
 * prevents mixing them with numbers.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value: bigint | null | undefined): string | null | undefined =>
    value === null || value === undefined ? value : value.toString(),
  from: (value: string | number | null | undefined): bigint | null | undefined =>
    value === null || value === undefined ? value : BigInt(value),
};
