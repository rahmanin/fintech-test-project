import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CapacityService, TreasuryApplyOutcome } from '../programs/capacity.service';
import { DomainError } from '../programs/programs.errors';
import { MoneyError } from '../money/money.errors';
import { parseVersion } from './dto/is-treasury-version.validator';
import {
  CAPACITY_UPDATED,
  PROGRAM_SNAPSHOT,
  TreasuryMessageDto,
  TreasuryProgramEntryDto,
} from './dto/treasury-message.dto';
import { InvalidTreasuryMessageError } from './treasury.errors';

export interface HandleResult {
  entries: number;
  applied: number;
  skipped: number;
  invalid: number;
}

/**
 * Parses, validates and applies treasury messages. Deliberately free of any
 * kafkajs types so it can be unit-tested with plain objects, which is also
 * why the consumer (transport) and this class (logic) are separate.
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);

  constructor(private readonly capacity: CapacityService) {}

  /**
   * Handle one Kafka message. Resolves only after every entry has been
   * handled; the caller commits the offset then, never per entry (a Kafka
   * offset addresses a message, not an item inside it).
   *
   * `heartbeat` is called every HEARTBEAT_EVERY entries: a large snapshot
   * processed one transaction at a time can outlive the consumer
   * sessionTimeout, and the broker would rebalance the partition away
   * mid-batch.
   */
  async handleMessage(raw: unknown, heartbeat?: () => Promise<void>): Promise<HandleResult> {
    const message = this.parseEnvelope(raw);
    const entries = this.entriesOf(message);
    const result: HandleResult = { entries: entries.length, applied: 0, skipped: 0, invalid: 0 };

    let processed = 0;
    for (const entry of entries) {
      const outcome = await this.applyEntry(entry, message.eventId);
      if (outcome === 'INVALID') result.invalid += 1;
      else if (outcome === 'SKIPPED_STALE') result.skipped += 1;
      else result.applied += 1;

      processed += 1;
      if (heartbeat && processed % HEARTBEAT_EVERY === 0) await heartbeat();
    }

    this.logger.log(
      `treasury ${message.type} eventId=${message.eventId ?? '-'} ` +
        `entries=${result.entries} applied=${result.applied} skipped=${result.skipped} invalid=${result.invalid}`,
    );
    return result;
  }

  /**
   * Everything that can make an entry permanently unprocessable is decided
   * here, before the database is touched. That is what lets the consumer
   * treat any error thrown by the DB as transient and retry it.
   */
  private async applyEntry(
    entry: TreasuryProgramEntryDto,
    eventId: string | undefined,
  ): Promise<TreasuryApplyOutcome | 'INVALID'> {
    try {
      return await this.capacity.applyTreasuryCapacity({
        programId: entry.programId,
        version: parseVersion(entry.version),
        currency: entry.currency,
        totalLimit: entry.totalLimit,
      });
    } catch (error) {
      // Unsupported currency, bad amount scale, amount beyond BIGINT, or a
      // currency that contradicts the stored program: all permanent. Log and
      // skip so one bad entry never blocks the partition or the rest of the
      // batch. Anything else (a DB outage) propagates and is retried.
      if (error instanceof MoneyError || error instanceof DomainError) {
        this.logger.warn(
          `treasury entry rejected eventId=${eventId ?? '-'} programId=${entry.programId}: ${error.message}`,
        );
        return 'INVALID';
      }
      throw error;
    }
  }

  private parseEnvelope(raw: unknown): TreasuryMessageDto {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new InvalidTreasuryMessageError('message is not a JSON object');
    }
    const message = plainToInstance(TreasuryMessageDto, raw);
    const errors = validateSync(message, {
      whitelist: true,
      forbidNonWhitelisted: false,
      validationError: { target: false },
    });
    if (errors.length > 0) {
      throw new InvalidTreasuryMessageError(errors.map(describe).join('; '));
    }
    return message;
  }

  private entriesOf(message: TreasuryMessageDto): TreasuryProgramEntryDto[] {
    if (message.type === CAPACITY_UPDATED) {
      if (!message.payload) {
        throw new InvalidTreasuryMessageError(`${CAPACITY_UPDATED} requires a payload object`);
      }
      return [message.payload];
    }
    if (!message.programs) {
      throw new InvalidTreasuryMessageError(`${PROGRAM_SNAPSHOT} requires a programs array`);
    }
    return message.programs;
  }
}

const HEARTBEAT_EVERY = 50;

function describe(error: {
  property: string;
  constraints?: Record<string, string>;
  children?: unknown[];
}): string {
  const own = Object.values(error.constraints ?? {}).join(', ');
  const children = (error.children ?? []) as (typeof error)[];
  const nested = children.map(describe).filter(Boolean).join('; ');
  return [own, nested].filter(Boolean).join(': ') || `${error.property} is invalid`;
}
