import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Money } from '../../money/money';
import { ProgramView } from '../capacity.service';
import { ReservationEntity } from '../reservation.entity';

/** All amounts are decimal strings; bigint never reaches JSON. */
export class ProgramResponseDto {
  @ApiProperty({ example: 'PRG-DEMO' }) programId!: string;
  @ApiProperty({ example: 'USD' }) currency!: string;
  @ApiProperty({ example: '10000000.00' }) totalLimit!: string;
  @ApiProperty({ example: '1080.00' }) reserved!: string;
  @ApiProperty({
    example: '9998920.00',
    description: 'totalLimit - reserved. Negative after a treasury limit cut below reserved.',
  })
  available!: string;
  @ApiProperty({ example: '0', description: 'Last applied treasury version; 0 = none yet' })
  treasuryVersion!: string;
  @ApiProperty() createdAt!: string;

  static from(view: ProgramView): ProgramResponseDto {
    return {
      programId: view.id,
      currency: view.currency,
      totalLimit: view.totalLimit.format(),
      reserved: view.reserved.format(),
      available: view.available.format(),
      treasuryVersion: view.treasuryVersion.toString(),
      createdAt: view.createdAt.toISOString(),
    };
  }
}

/**
 * What the call that produced this response actually did.
 *
 * Reserve and release are idempotent, so a repeat returns the same body as
 * the original call. Without this field a client cannot tell an accepted
 * retry from a first-time success, and for release even the status code is
 * the same (200 either way). It is declared and serialised first so the
 * difference is the first thing visible in the response.
 *
 * A repeat with a *different* amount is not a replay: it stays a 409
 * conflict, because that is a client bug rather than a retry.
 */
export type ReservationOutcome = 'CREATED' | 'ALREADY_RESERVED' | 'RELEASED' | 'ALREADY_RELEASED';

export class ReservationResponseDto {
  @ApiPropertyOptional({
    enum: ['CREATED', 'ALREADY_RESERVED', 'RELEASED', 'ALREADY_RELEASED'],
    description:
      'What this call did. Present on reserve and release, omitted in list items. ' +
      'ALREADY_* means the operation had already happened and nothing changed.',
  })
  outcome?: ReservationOutcome;

  @ApiProperty({ example: 'PRG-DEMO' }) programId!: string;
  @ApiProperty({ example: 'INV-1001' }) invoiceId!: string;
  @ApiProperty({ enum: ['ACTIVE', 'RELEASED'] }) status!: 'ACTIVE' | 'RELEASED';
  @ApiProperty({ example: '1000.00' }) invoiceAmount!: string;
  @ApiProperty({ example: 'EUR' }) invoiceCurrency!: string;
  @ApiProperty({ example: '1.0800000000', description: 'Rate frozen at reservation time' })
  fxRate!: string;
  @ApiProperty({ example: '1080.00', description: 'Amount counted against the program limit' })
  reservedAmount!: string;
  @ApiProperty({ example: 'USD' }) reservedCurrency!: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional({ nullable: true }) releasedAt!: string | null;

  /** Plain representation, used for list items where no call outcome applies. */
  static from(r: ReservationEntity, programCurrency: string): ReservationResponseDto {
    return {
      programId: r.programId,
      invoiceId: r.invoiceId,
      status: r.status,
      invoiceAmount: Money.fromMinor(r.invoiceAmountMinor, r.invoiceCurrency).format(),
      invoiceCurrency: r.invoiceCurrency,
      fxRate: r.fxRate,
      reservedAmount: Money.fromMinor(r.reservedAmountMinor, programCurrency).format(),
      reservedCurrency: programCurrency,
      createdAt: r.createdAt.toISOString(),
      releasedAt: r.releasedAt ? r.releasedAt.toISOString() : null,
    };
  }

  /** Same representation with the outcome spread in first, so it leads the JSON. */
  static withOutcome(
    outcome: ReservationOutcome,
    r: ReservationEntity,
    programCurrency: string,
  ): ReservationResponseDto {
    return { outcome, ...ReservationResponseDto.from(r, programCurrency) };
  }
}

export class ReservationListResponseDto {
  @ApiProperty({ type: [ReservationResponseDto] }) items!: ReservationResponseDto[];
}

export class ApiErrorDto {
  @ApiProperty({ example: 'INSUFFICIENT_CAPACITY' }) code!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  details?: Record<string, unknown>;
}
