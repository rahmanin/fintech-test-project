// class-transformer reads decorator metadata through Reflect.getMetadata.
// Inside the Nest app the runtime loads reflect-metadata first, but this
// module also runs standalone (migrate.ts, unit tests), so import it here.
import 'reflect-metadata';
import { Transform, plainToInstance, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Typed, validated view of process.env.
 *
 * Why: configuration is validated once, at boot, with the same library the
 * HTTP DTOs use, so a missing or malformed variable fails the process
 * immediately with a readable message instead of surfacing later as a
 * confusing runtime error (e.g. TypeORM failing to parse an empty URL after
 * the first request).
 *
 * Failure mode prevented: a container that starts "green" but cannot serve
 * a single request because one env var was never set.
 */
export class EnvConfig {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  // Explicit conversion: env values are always strings. Relying on implicit
  // conversion through emitted design:type metadata is fragile (an inferred
  // field type is emitted as Object and would never convert).
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  /** JSON object of "FROM/TO": "rate" strings; parsed and validated by FxModule at boot. */
  @IsString()
  @IsNotEmpty()
  FX_RATES!: string;

  /** HS256 signing secret. Short secrets are refused at boot. */
  @IsString()
  @MinLength(16)
  JWT_SECRET!: string;

  /** Token lifetime as accepted by jsonwebtoken, e.g. "1h", "30m". */
  @IsString()
  @IsNotEmpty()
  JWT_EXPIRES_IN: string = '1h';

  /** Client credentials accepted by POST /auth/token. */
  @IsString()
  @IsNotEmpty()
  API_CLIENT_ID!: string;

  @IsString()
  @MinLength(16)
  API_CLIENT_SECRET!: string;

  /** Comma-separated list, e.g. "kafka:9092" inside Compose, "localhost:29092" from the host. */
  @IsString()
  @IsNotEmpty()
  KAFKA_BROKERS: string = 'localhost:29092';

  @IsString()
  @IsNotEmpty()
  KAFKA_TOPIC: string = 'treasury.program-capacity';

  @IsString()
  @IsNotEmpty()
  KAFKA_CONSUMER_GROUP: string = 'capacity-service';

  /** Set to false in tests and when running the API without a broker. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value !== 'false' : value,
  )
  @IsBoolean()
  KAFKA_ENABLED: boolean = true;
}

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const config = plainToInstance(EnvConfig, raw);
  const errors = validateSync(config, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return config;
}
