import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FxModule } from '../fx/fx.module';
import { CapacityService } from './capacity.service';
import { ProgramsController } from './programs.controller';
import { ProgramEntity } from './program.entity';
import { ReservationEntity } from './reservation.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ProgramEntity, ReservationEntity]), FxModule],
  controllers: [ProgramsController],
  providers: [CapacityService],
  exports: [CapacityService],
})
export class ProgramsModule {}
