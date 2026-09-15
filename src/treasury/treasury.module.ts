import { Module } from '@nestjs/common';
import { ProgramsModule } from '../programs/programs.module';
import { TreasuryConsumer } from './treasury.consumer';
import { TreasuryService } from './treasury.service';

@Module({
  imports: [ProgramsModule],
  providers: [TreasuryService, TreasuryConsumer],
  exports: [TreasuryService],
})
export class TreasuryModule {}
