import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../database/bigint.transformer';

export type ReservationStatus = 'ACTIVE' | 'RELEASED';

@Entity('reservations')
export class ReservationEntity {
  @PrimaryColumn('text', { name: 'program_id' })
  programId!: string;

  @PrimaryColumn('text', { name: 'invoice_id' })
  invoiceId!: string;

  /** What the client sent, kept to detect idempotency conflicts. */
  @Column('bigint', { name: 'invoice_amount_minor', transformer: bigintTransformer })
  invoiceAmountMinor!: bigint;

  @Column('char', { name: 'invoice_currency', length: 3 })
  invoiceCurrency!: string;

  /**
   * Frozen at reservation time. NUMERIC(20,10) arrives from the driver as a
   * string and is kept as one; FxRate.fromStored() parses it when needed.
   */
  @Column('numeric', { name: 'fx_rate', precision: 20, scale: 10 })
  fxRate!: string;

  /** Converted amount in the program currency; this is what counts against capacity. */
  @Column('bigint', { name: 'reserved_amount_minor', transformer: bigintTransformer })
  reservedAmountMinor!: bigint;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** NULL = active. */
  @Column('timestamptz', { name: 'released_at', nullable: true })
  releasedAt!: Date | null;

  get status(): ReservationStatus {
    return this.releasedAt === null ? 'ACTIVE' : 'RELEASED';
  }
}
