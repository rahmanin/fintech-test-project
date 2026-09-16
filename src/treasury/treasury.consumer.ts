import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Consumer, EachMessagePayload, Kafka, logLevel } from 'kafkajs';
import { EnvConfig } from '../config/env.validation';
import { InvalidTreasuryMessageError } from './treasury.errors';
import { TreasuryService } from './treasury.service';

/**
 * Kafka transport for treasury messages. Uses kafkajs directly rather than
 * the Nest microservices transport, because offset handling and the error
 * policy are the substance of this integration and the transport hides both.
 */
@Injectable()
export class TreasuryConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TreasuryConsumer.name);
  private consumer?: Consumer;

  constructor(
    private readonly config: ConfigService<EnvConfig, true>,
    private readonly treasury: TreasuryService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get('KAFKA_ENABLED', { infer: true })) {
      this.logger.warn('KAFKA_ENABLED=false; treasury consumer not started');
      return;
    }
    const topic = this.config.get('KAFKA_TOPIC', { infer: true });
    const kafka = new Kafka({
      clientId: 'capacity-service',
      brokers: this.config.get('KAFKA_BROKERS', { infer: true }).split(','),
      logLevel: logLevel.WARN,
    });

    this.consumer = kafka.consumer({
      groupId: this.config.get('KAFKA_CONSUMER_GROUP', { infer: true }),
      // A transient failure is retried by kafkajs; when the retries are
      // exhausted the consumer crashes and is restarted. A crash loop during
      // a database outage is intended: it is visible, whereas skipping would
      // silently lose a limit change.
      retry: { initialRetryTime: 300, retries: 5, restartOnFailure: () => Promise.resolve(true) },
    });

    await this.consumer.connect();
    // fromBeginning so a snapshot published before the service started is
    // still applied; re-reading the topic is safe because every entry is
    // absolute state guarded by the version check.
    await this.consumer.subscribe({ topic, fromBeginning: true });
    await this.consumer.run({
      // One instance handles messages sequentially. Nothing in the design
      // depends on that: the row lock and the version check make several
      // instances safe.
      partitionsConsumedConcurrently: 1,
      eachMessage: (payload) => this.onMessage(payload),
    });
    this.logger.log(`treasury consumer subscribed to ${topic}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
  }

  /**
   * kafkajs marks the offset as processed when this promise resolves, so the
   * whole message (a bulk snapshot included) is acknowledged exactly once,
   * after every entry has been handled.
   *
   * Throwing leaves the offset uncommitted and the message is redelivered;
   * entries already committed are then skipped by the version check, so a
   * partial batch is safe to replay.
   */
  private async onMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, partition, message } = payload;
    const at = `${topic}/${partition}@${message.offset}`;
    let raw: unknown;
    try {
      raw = JSON.parse(message.value?.toString() ?? 'null');
    } catch {
      // Poison message: unparsable now and forever. Log and acknowledge, or
      // it would block this partition permanently.
      this.logger.error(`treasury message at ${at} is not valid JSON; skipped`);
      return;
    }

    try {
      await this.treasury.handleMessage(raw, () => payload.heartbeat());
    } catch (error) {
      if (error instanceof InvalidTreasuryMessageError) {
        this.logger.error(`treasury message at ${at} rejected: ${error.message}; skipped`);
        return;
      }
      this.logger.error(`treasury message at ${at} failed; offset not committed`, error);
      throw error;
    }
  }
}
