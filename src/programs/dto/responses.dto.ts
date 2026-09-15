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

export class ReservationResponseDto {
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
