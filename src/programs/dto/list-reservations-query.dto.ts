import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { ReservationStatus } from '../reservation.entity';

export class ListReservationsQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'RELEASED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'RELEASED'])
  status?: ReservationStatus;
}
