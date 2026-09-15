import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvConfig } from '../config/env.validation';
import { FxRateProvider } from './fx-rate.provider';
import { StaticFxRateProvider } from './static-fx-rate.provider';

@Module({
  providers: [
    {
      provide: FxRateProvider,
      inject: [ConfigService],
      // Parsed once at boot: a malformed FX_RATES fails startup, not the first reservation.
      useFactory: (config: ConfigService<EnvConfig, true>) =>
        StaticFxRateProvider.fromJson(config.get('FX_RATES', { infer: true })),
    },
  ],
  exports: [FxRateProvider],
})
export class FxModule {}
