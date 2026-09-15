import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EnvConfig } from '../config/env.validation';
import { buildDataSourceOptions } from './data-source';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        ...buildDataSourceOptions(config.get('DATABASE_URL', { infer: true })),
        // The app never applies migrations itself; see migrate.ts.
        migrationsRun: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
