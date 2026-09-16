import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { IsTreasuryVersion } from './is-treasury-version.validator';

export const CAPACITY_UPDATED = 'CAPACITY_UPDATED';
export const PROGRAM_SNAPSHOT = 'PROGRAM_SNAPSHOT';
export type TreasuryMessageType = typeof CAPACITY_UPDATED | typeof PROGRAM_SNAPSHOT;

/**
 * One program's absolute capacity state, as treasury sees it.
 *
 * Deliberately no invoice-level data: TASK.md never says treasury knows
 * about reservations, so a snapshot only carries program capacity.
 */
export class TreasuryProgramEntryDto {
  @IsString()
  @Matches(/^\S.*$/, { message: 'programId must be a non-empty string' })
  programId!: string;

  /**
   * Monotonic per program. Accepted as a JSON number or a digit string.
   *
   * JSON numbers are IEEE doubles: integers above 2^53 lose precision, so a
   * nanosecond-epoch style version would compare wrongly and silently skip
   * or accept the wrong message. A number that is not a safe integer is
   * rejected; a digit string lets treasury send large values losslessly.
   * Parsed to bigint before any comparison (see parseVersion).
   */
  @IsTreasuryVersion()
  version!: number | string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter uppercase ISO 4217 code' })
  currency!: string;

  /** Decimal string in the program's own currency, e.g. "10000000.00". */
  @IsString()
  @Matches(/^\d+(\.\d+)?$/, { message: 'totalLimit must be a non-negative decimal string' })
  totalLimit!: string;
}

export class TreasuryMessageDto {
  /** Logging / tracing only; the version check is what makes handling idempotent. */
  @IsOptional()
  @IsString()
  eventId?: string;

  @IsIn([CAPACITY_UPDATED, PROGRAM_SNAPSHOT])
  type!: TreasuryMessageType;

  /** Logging only; no format enforced because the producer contract is unknown. */
  @IsOptional()
  @IsString()
  occurredAt?: string;

  /** Present for CAPACITY_UPDATED. */
  @IsOptional()
  @ValidateNested()
  @Type(() => TreasuryProgramEntryDto)
  payload?: TreasuryProgramEntryDto;

  /** Present for PROGRAM_SNAPSHOT. An empty array is valid and is a no-op. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => TreasuryProgramEntryDto)
  programs?: TreasuryProgramEntryDto[];
}
