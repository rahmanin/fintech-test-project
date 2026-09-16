import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { IDEMPOTENT_REPLAY_HEADER_DOC, setIdempotentReplay } from '../common/idempotency';
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
   * 201 when a reservation is created, 200 when the same request is replayed.
   * The reservation itself is identical either way, so what this call did is
   * reported explicitly: `outcome` as the first field of the body, and the
   * Idempotent-Replay header for clients that only read metadata.
   */
  @Post(':programId/reservations')
  @ApiOperation({ summary: 'Reserve capacity for an approved invoice' })
  @ApiParam({ name: 'programId', example: 'PRG-DEMO' })
  @ApiResponse({
    status: 201,
    description: 'Created; outcome = CREATED',
    type: ReservationResponseDto,
    headers: IDEMPOTENT_REPLAY_HEADER_DOC,
  })
  @ApiResponse({
    status: 200,
    description: 'Already reserved (idempotent replay); outcome = ALREADY_RESERVED',
    type: ReservationResponseDto,
    headers: IDEMPOTENT_REPLAY_HEADER_DOC,
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
    setIdempotentReplay(res, !result.created);
    return ReservationResponseDto.withOutcome(
      result.created ? 'CREATED' : 'ALREADY_RESERVED',
      result.reservation,
      result.programCurrency,
    );
  }

  @Post(':programId/reservations/:invoiceId/release')
  @HttpCode(200)
  @ApiOperation({ summary: 'Release a reservation after the invoice is repaid (idempotent)' })
  @ApiParam({ name: 'programId', example: 'PRG-DEMO' })
  @ApiParam({ name: 'invoiceId', example: 'INV-1001' })
  @ApiResponse({
    status: 200,
    description:
      'Released. The status is 200 whether this call performed the release or ' +
      'repeated one that already happened; outcome is RELEASED or ALREADY_RELEASED.',
    type: ReservationResponseDto,
    headers: IDEMPOTENT_REPLAY_HEADER_DOC,
  })
  @ApiResponse({ status: 404, description: 'RESERVATION_NOT_FOUND', type: ApiErrorDto })
  async release(
    @Param('programId') programId: string,
    @Param('invoiceId') invoiceId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReservationResponseDto> {
    const result = await this.capacity.release(programId, invoiceId);
    setIdempotentReplay(res, !result.changed);
    return ReservationResponseDto.withOutcome(
      result.changed ? 'RELEASED' : 'ALREADY_RELEASED',
      result.reservation,
      result.programCurrency,
    );
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
