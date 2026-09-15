import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CapacityService } from './capacity.service';
import { ListReservationsQueryDto } from './dto/list-reservations-query.dto';
import { ReserveRequestDto } from './dto/reserve-request.dto';
import {
  ApiErrorDto,
  ProgramResponseDto,
  ReservationListResponseDto,
  ReservationResponseDto,
} from './dto/responses.dto';

@ApiTags('programs')
@ApiBearerAuth()
@ApiResponse({ status: 401, description: 'Missing or invalid bearer token', type: ApiErrorDto })
@Controller('programs')
export class ProgramsController {
  constructor(private readonly capacity: CapacityService) {}

  @Get(':programId')
  @ApiOperation({ summary: 'Program with current availability' })
  @ApiParam({ name: 'programId', example: 'PRG-DEMO' })
  @ApiResponse({ status: 200, type: ProgramResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  async getProgram(@Param('programId') programId: string): Promise<ProgramResponseDto> {
    return ProgramResponseDto.from(await this.capacity.getProgram(programId));
  }

  /**
   * 201 when a reservation is created, 200 when the same request is replayed
   * (idempotent). The status is the only difference; the body is the same.
   */
  @Post(':programId/reservations')
  @ApiOperation({ summary: 'Reserve capacity for an approved invoice' })
  @ApiParam({ name: 'programId', example: 'PRG-DEMO' })
  @ApiResponse({ status: 201, description: 'Created', type: ReservationResponseDto })
  @ApiResponse({
    status: 200,
    description: 'Already reserved (idempotent replay)',
    type: ReservationResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR, INVALID_AMOUNT_*',
    type: ApiErrorDto,
  })
  @ApiResponse({ status: 404, description: 'PROGRAM_NOT_FOUND', type: ApiErrorDto })
  @ApiResponse({
    status: 409,
    description: 'INSUFFICIENT_CAPACITY or IDEMPOTENCY_CONFLICT',
    type: ApiErrorDto,
  })
  @ApiResponse({
    status: 422,
    description: 'UNSUPPORTED_CURRENCY or AMOUNT_TOO_SMALL',
    type: ApiErrorDto,
  })
  async reserve(
    @Param('programId') programId: string,
    @Body() body: ReserveRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReservationResponseDto> {
    const result = await this.capacity.reserve({ programId, ...body });
    res.status(result.created ? 201 : 200);
    return ReservationResponseDto.from(result.reservation, result.programCurrency);
  }

  @Post(':programId/reservations/:invoiceId/release')
  @HttpCode(200)
  @ApiOperation({ summary: 'Release a reservation after the invoice is repaid (idempotent)' })
  @ApiParam({ name: 'programId', example: 'PRG-DEMO' })
  @ApiParam({ name: 'invoiceId', example: 'INV-1001' })
  @ApiResponse({ status: 200, type: ReservationResponseDto })
  @ApiResponse({ status: 404, description: 'RESERVATION_NOT_FOUND', type: ApiErrorDto })
  async release(
    @Param('programId') programId: string,
    @Param('invoiceId') invoiceId: string,
  ): Promise<ReservationResponseDto> {
    const result = await this.capacity.release(programId, invoiceId);
    return ReservationResponseDto.from(result.reservation, result.programCurrency);
  }

  @Get(':programId/reservations')
  @ApiOperation({ summary: 'List reservations of a program' })
  @ApiParam({ name: 'programId', example: 'PRG-DEMO' })
  @ApiResponse({ status: 200, type: ReservationListResponseDto })
  @ApiResponse({ status: 404, type: ApiErrorDto })
  async list(
    @Param('programId') programId: string,
    @Query() query: ListReservationsQueryDto,
  ): Promise<ReservationListResponseDto> {
    const { programCurrency, reservations } = await this.capacity.listReservations(
      programId,
      query.status,
    );
    return { items: reservations.map((r) => ReservationResponseDto.from(r, programCurrency)) };
  }
}
