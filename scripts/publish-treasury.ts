import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Kafka } from 'kafkajs';

/**
 * Development helper: publish a treasury message to the capacity topic.
 *
 *   npm run treasury:publish -- update PRG-DEMO 5 9000000.00 USD
 *   npm run treasury:publish -- snapshot PRG-DEMO:6:8000000.00:USD PRG-002:1:500000.00:EUR
 *
 * Single updates are keyed by programId so consecutive updates for one
 * program keep their order within a partition. A snapshot covers many
 * programs and therefore cannot carry a per-program key: it is sent
 * unkeyed, and correctness rests on the per-program version instead.
 */
async function main(): Promise<void> {
  const [kind, ...rest] = process.argv.slice(2);
  const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:29092').split(',');
  const topic = process.env.KAFKA_TOPIC ?? 'treasury.program-capacity';

  const kafka = new Kafka({ clientId: 'treasury-publisher', brokers });
  const producer = kafka.producer();
  await producer.connect();

  try {
    if (kind === 'update') {
      const [programId, version, totalLimit, currency = 'USD'] = rest;
      if (!programId || !version || !totalLimit) throw new Error(usage());
      const message = {
        eventId: randomUUID(),
        type: 'CAPACITY_UPDATED',
        occurredAt: new Date().toISOString(),
        payload: { programId, version: Number(version), currency, totalLimit },
      };
      await producer.send({
        topic,
        messages: [{ key: programId, value: JSON.stringify(message) }],
      });
      console.log(`published CAPACITY_UPDATED ${programId} v${version} ${totalLimit} ${currency}`);
    } else if (kind === 'snapshot') {
      if (rest.length === 0) throw new Error(usage());
      const programs = rest.map((spec) => {
        const [programId, version, totalLimit, currency = 'USD'] = spec.split(':');
        if (!programId || !version || !totalLimit) throw new Error(`bad entry "${spec}"`);
        return { programId, version: Number(version), currency, totalLimit };
      });
      const message = {
        eventId: randomUUID(),
        type: 'PROGRAM_SNAPSHOT',
        occurredAt: new Date().toISOString(),
        programs,
      };
      await producer.send({ topic, messages: [{ value: JSON.stringify(message) }] });
      console.log(`published PROGRAM_SNAPSHOT with ${programs.length} program(s)`);
    } else {
      throw new Error(usage());
    }
  } finally {
    await producer.disconnect();
  }
}

function usage(): string {
  return [
    'Usage:',
    '  npm run treasury:publish -- update <programId> <version> <totalLimit> [currency]',
    '  npm run treasury:publish -- snapshot <programId:version:totalLimit[:currency]> ...',
  ].join('\n');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
