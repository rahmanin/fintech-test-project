import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { FxModule } from './fx/fx.module';
import { HealthModule } from './health/health.module';
import { ProgramsModule } from './programs/programs.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    DatabaseModule,
    FxModule,
    ProgramsModule,
    HealthModule,
  ],
})
export class AppModule {}
