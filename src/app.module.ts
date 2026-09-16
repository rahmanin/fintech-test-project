import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { FxModule } from './fx/fx.module';
import { HealthModule } from './health/health.module';
import { ProgramsModule } from './programs/programs.module';
import { TreasuryModule } from './treasury/treasury.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    AuthModule,
    DatabaseModule,
    FxModule,
    ProgramsModule,
    TreasuryModule,
    HealthModule,
  ],
})
export class AppModule {}
