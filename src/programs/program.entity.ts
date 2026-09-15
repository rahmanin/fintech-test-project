import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../database/bigint.transformer';

@Entity('programs')
export class ProgramEntity {
  /** Treasury's identifier, e.g. "PRG-001". */
  @PrimaryColumn('text')
  id!: string;

  @Column('char', { length: 3 })
  currency!: string;

  @Column('bigint', { name: 'total_limit_minor', transformer: bigintTransformer })
  totalLimitMinor!: bigint;

  /** Last applied treasury version; 0 = never received. */
  @Column('bigint', { name: 'treasury_version', transformer: bigintTransformer })
  treasuryVersion!: bigint;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
