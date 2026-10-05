import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const QA_MODES = ['local', 'claude'] as const;
export type QaMode = (typeof QA_MODES)[number];

export const QA_STATUSES = ['pending', 'streaming', 'done', 'error', 'aborted'] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

/** Cited chunks as returned by retrieval; kept as JSON so history survives re-indexing. */
export interface QaCitation {
  chunkId: string;
  sourceId: string;
  trustLevel: number;
  page?: number | null;
}

/** numeric(10,5) comes back from pg as a string; convert so callers can sum it as a number. */
const decimalToNumber = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * One row per question. Two jobs: the monthly Claude budget guard sums `cost_usd`,
 * and later it becomes the evaluation set (question, answer, rating).
 */
@Entity({ name: 'qa_log' })
@Check('CK_qa_log_mode', `"mode" IN ('local', 'claude')`)
@Check('CK_qa_log_status', `"status" IN ('pending', 'streaming', 'done', 'error', 'aborted')`)
@Check('CK_qa_log_rating', `"rating" IS NULL OR "rating" IN (-1, 1)`)
@Index('IDX_qa_log_mode_created', ['mode', 'createdAt'])
export class QaLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  question: string;

  @Column({ type: 'jsonb', nullable: true })
  filters: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 16 })
  mode: QaMode;

  @Column({ type: 'varchar', length: 100, nullable: true })
  model: string | null;

  @Column({ type: 'text', nullable: true })
  answer: string | null;

  @Column({ type: 'jsonb', default: '[]' })
  cited: QaCitation[];

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: QaStatus;

  @Column({ type: 'int', nullable: true })
  tokensIn: number | null;

  @Column({ type: 'int', nullable: true })
  tokensOut: number | null;

  @Column({
    type: 'numeric',
    precision: 10,
    scale: 5,
    default: 0,
    transformer: decimalToNumber,
  })
  costUsd: number;

  @Column({ type: 'int', nullable: true })
  latencyMs: number | null;

  /** 1 = helpful, -1 = not helpful. */
  @Column({ type: 'smallint', nullable: true })
  rating: -1 | 1 | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
