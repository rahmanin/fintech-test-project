import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * Level-1 validation: shape only (PLAN.md §12.1). Anything that needs state
 * (program exists, currency supported, capacity) is a business rule.
 */
export class ReserveRequestDto {
  @ApiProperty({ example: 'INV-1001', description: 'Idempotency key within the program' })
  @IsString()
  @IsNotEmpty()
  invoiceId!: string;

  @ApiProperty({
    example: '1000.00',
    description: 'Decimal string, never a JSON number. Must be greater than zero.',
  })
  @IsString()
  @Matches(/^(?!0+(\.0+)?$)\d+(\.\d+)?$/, {
    message: 'amount must be a positive decimal string such as "1000.00"',
  })
  amount!: string;

  @ApiProperty({ example: 'EUR', description: 'ISO 4217 code of the invoice currency' })
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter uppercase ISO 4217 code' })
  currency!: string;
}
