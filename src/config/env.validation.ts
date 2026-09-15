// class-transformer reads decorator metadata through Reflect.getMetadata.
// Inside the Nest app the runtime loads reflect-metadata first, but this
// module also runs standalone (migrate.ts, unit tests), so import it here.
import 'reflect-metadata';
import { plainToInstance, Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsString, Max, Min, validateSync } from 'class-validator';

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
